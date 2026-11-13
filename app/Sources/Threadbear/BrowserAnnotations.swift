import AppKit
import Combine
import Foundation
import ThreadbearCore

enum BrowserAnnotationError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case let .message(text): text } }
}

struct BrowserAnnotationPayload: Codable {
    struct Point: Codable { var x: Double; var y: Double }
    struct Rect: Codable {
        var x: Double; var y: Double; var width: Double; var height: Double
        var valid: Bool { [x, y, width, height].allSatisfy { $0.isFinite && abs($0) <= 10_000_000 } && width >= 0 && height >= 0 }
    }
    struct Element: Codable {
        var selector: String; var tagName: String; var outerHTML: String; var text: String
        var styles: [String: String]; var rect: Rect
    }
    struct Stroke: Codable { var points: [Point] }
    struct Viewport: Codable { var width: Double; var height: Double; var scrollX: Double; var scrollY: Double }
    var url: String; var title: String; var comment: String
    var elements: [Element]; var regions: [Rect]; var strokes: [Stroke]; var viewport: Viewport

    static func decode(_ object: [String: Any]) throws -> Self {
        guard JSONSerialization.isValidJSONObject(object) else { throw invalid() }
        let data = try JSONSerialization.data(withJSONObject: object)
        guard data.count <= 512 * 1024 else { throw invalid() }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.url.count <= 8192, value.title.count <= 1024, value.comment.count <= 16000,
              value.elements.count <= 20, value.regions.count <= 20, value.strokes.count <= 100,
              !value.elements.isEmpty || !value.regions.isEmpty || !value.strokes.isEmpty,
              value.strokes.reduce(0, { $0 + $1.points.count }) <= 20_000,
              [value.viewport.width, value.viewport.height, value.viewport.scrollX, value.viewport.scrollY].allSatisfy({ $0.isFinite && abs($0) <= 10_000_000 }),
              value.viewport.width > 0, value.viewport.height > 0,
              value.elements.allSatisfy({ $0.selector.count <= 2048 && $0.tagName.count <= 128 && $0.outerHTML.count <= 16000 && $0.text.count <= 4000 && $0.styles.count <= 64 && $0.styles.allSatisfy { $0.key.count <= 128 && $0.value.count <= 1024 } && $0.rect.valid }),
              value.regions.allSatisfy(\.valid),
              value.strokes.allSatisfy({ !$0.points.isEmpty && $0.points.allSatisfy { $0.x.isFinite && $0.y.isFinite && abs($0.x) <= 10_000_000 && abs($0.y) <= 10_000_000 } }) else { throw invalid() }
        return value
    }

    private static func invalid() -> BrowserAnnotationError { .message("The page returned an invalid or oversized annotation.") }

    func draftText(screenshotAvailable: Bool) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let context = (try? encoder.encode(self)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        var details = context
        details.removeValue(forKey: "comment")
        // Keep the bounded geometry when capture failed so drawings still identify their location.
        if screenshotAvailable { details["strokes"] = "\(strokes.count) drawn strokes, shown in the screenshot" }
        else { details["screenshot"] = "Unavailable. Drawing points and regions use the captured viewport's coordinates." }
        let data = (try? JSONSerialization.data(withJSONObject: details, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data()
        let json = String(decoding: data, as: UTF8.self)
        let text = "Browser annotation\n\n\(comment.isEmpty ? "Please review the marked areas." : comment)\n\nPage context (captured from the page):\n```json\n\(json)\n```"
        return text.replacingOccurrences(of: InlinePictures.markString, with: "[object]")
    }
}

/// A private connection to one exact browser target, never a numeric tab shared by profiles.
@MainActor
final class BrowserAnnotationCDP: NSObject {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private let timeout: TimeInterval
    private var nextID = 0
    private var waiting: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var timeouts: [Int: Task<Void, Never>] = [:]
    private var reader: Task<Void, Never>?
    private var closed = false
    var onEvent: ((String, [String: Any]) -> Void)?

    init(url: URL, timeout: TimeInterval = 10) {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        socket = session.webSocketTask(with: url)
        socket.maximumMessageSize = 16 * 1024 * 1024
        self.timeout = timeout
        super.init()
        socket.resume()
        reader = Task { [weak self, socket] in
            do {
                while !Task.isCancelled {
                    let frame = try await socket.receive()
                    guard let self else { return }
                    let data: Data
                    switch frame {
                    case let .data(bytes): data = bytes
                    case let .string(text): data = Data(text.utf8)
                    @unknown default: throw BrowserAnnotationError.message("The browser returned an unreadable message.")
                    }
                    guard data.count <= 16 * 1024 * 1024,
                          let message = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        throw BrowserAnnotationError.message("The browser returned an oversized or unreadable message.")
                    }
                    if let id = message["id"] as? Int {
                        if let error = message["error"] as? [String: Any] {
                            self.finish(id, .failure(BrowserAnnotationError.message(error["message"] as? String ?? "The browser request failed.")))
                        } else { self.finish(id, .success(message["result"] as? [String: Any] ?? [:])) }
                    } else if let method = message["method"] as? String {
                        self.onEvent?(method, message["params"] as? [String: Any] ?? [:])
                    }
                }
            } catch { self?.close(error) }
        }
    }

    static func endpoint(_ text: String, target: String, port: Int) throws -> URL {
        guard (1...65535).contains(port), !target.isEmpty, target.count <= 128,
              target.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }),
              let url = URL(string: text), url.scheme == "ws", ["127.0.0.1", "localhost", "[::1]", "::1"].contains(url.host ?? ""),
              url.port == port, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path == "/devtools/page/\(target)" else {
            throw BrowserAnnotationError.message("The browser page didn't provide its expected local connection.")
        }
        return url
    }

    static func connect(target: String, port: Int) async throws -> BrowserAnnotationCDP {
        guard (1...65535).contains(port) else { throw BrowserAnnotationError.message("The agents' browser isn't running.") }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/json/list")!)
        request.timeoutInterval = 5
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 1024 * 1024,
              let targets = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let page = targets.first(where: { $0["id"] as? String == target && $0["type"] as? String == "page" }),
              let address = page["webSocketDebuggerUrl"] as? String else {
            throw BrowserAnnotationError.message("This page has closed or its browser connection changed.")
        }
        return try BrowserAnnotationCDP(url: endpoint(address, target: target, port: port))
    }

    func call(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
        try Task.checkCancellation()
        guard !closed else { throw BrowserAnnotationError.message("The browser connection closed.") }
        nextID += 1
        let id = nextID
        let bytes = try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { done in
                waiting[id] = done
                timeouts[id] = Task { [weak self, timeout] in
                    do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
                    self?.finish(id, .failure(BrowserAnnotationError.message("The browser didn't answer in time.")))
                }
                Task { [weak self, socket] in
                    do { try await socket.send(.string(String(decoding: bytes, as: UTF8.self))) }
                    catch { self?.close(error) }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish(id, .failure(CancellationError())) }
        }
    }

    func evaluate(_ expression: String, context: Int) async throws -> [String: Any] {
        let result = try await call("Runtime.evaluate", ["expression": expression, "contextId": context, "returnByValue": true, "awaitPromise": true, "timeout": 5000])
        guard result["exceptionDetails"] == nil,
              let remote = result["result"] as? [String: Any], let value = remote["value"] as? [String: Any] else {
            throw BrowserAnnotationError.message("The annotation page changed or its tools stopped responding.")
        }
        return value
    }

    private func finish(_ id: Int, _ result: Result<[String: Any], Error>) {
        timeouts.removeValue(forKey: id)?.cancel()
        waiting.removeValue(forKey: id)?.resume(with: result)
    }

    func close(_ error: Error = BrowserAnnotationError.message("The browser connection closed.")) {
        guard !closed else { return }
        closed = true
        reader?.cancel()
        reader = nil
        for id in Array(waiting.keys) { finish(id, .failure(error)) }
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class BrowserAnnotations: ObservableObject {
    static let shared = BrowserAnnotations()
    @Published private(set) var activeTabID: String?
    @Published private(set) var threadID: String?
    @Published private(set) var message: String?
    private var task: Task<Void, Never>?
    private var connection: BrowserAnnotationCDP?
    private var contextID: Int?

    static var source: String? {
        let name = "Threadbear_Threadbear.bundle"
        let bundle = [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent(),
                      Bundle(for: BrowserAnnotationCDP.self).bundleURL.deletingLastPathComponent()]
            .compactMap { $0?.appendingPathComponent(name) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
            .flatMap(Bundle.init(url:))
        guard let url = bundle?.url(forResource: "annotation", withExtension: "js", subdirectory: "Annotations") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    func start(tab: AgentTab, thread: String, app: AppModel) {
        guard activeTabID == nil else { return }
        let model = AgentBrowserModel.shared
        let port = model.port
        guard app.experiments.contains("browserAnnotations"), !app.isRemote(thread),
              model.annotationTargetIsCurrent(tab, thread: thread, port: port), let target = tab.targetId else {
            threadID = thread
            message = "Annotations are available on this Mac's pages in the agents' browser."
            return
        }
        guard let source = Self.source else { threadID = thread; message = "The annotation tools are missing from this app build."; return }
        let id = UUID().uuidString
        activeTabID = tab.id
        threadID = thread
        message = "Opening annotation tools…"
        task = Task { [weak self, weak app] in
            guard let self, let app else { return }
            defer {
                self.connection?.close()
                self.connection = nil
                self.contextID = nil
                self.activeTabID = nil
                self.task = nil
            }
            do {
                let cdp = try await BrowserAnnotationCDP.connect(target: target, port: port)
                self.connection = cdp
                _ = try await cdp.call("Page.enable")
                let tree = try await cdp.call("Page.getFrameTree")
                guard let frameTree = tree["frameTree"] as? [String: Any], let frame = frameTree["frame"] as? [String: Any], let frameID = frame["id"] as? String else {
                    throw BrowserAnnotationError.message("This page is still loading. Try Annotate again when it settles.")
                }
                let world = try await cdp.call("Page.createIsolatedWorld", ["frameId": frameID, "worldName": "Threadbear annotations", "grantUniveralAccess": false])
                guard let context = world["executionContextId"] as? Int else { throw BrowserAnnotationError.message("The browser couldn't isolate the annotation tools.") }
                self.contextID = context
                cdp.onEvent = { [weak self] method, params in
                    if method == "Page.frameNavigated", let frame = params["frame"] as? [String: Any], frame["parentId"] == nil {
                        self?.message = "The page navigated. Open Annotate again on the new page."
                        self?.task?.cancel()
                    }
                }
                _ = try await cdp.evaluate("(\(source))(\(Self.jsString(id)))", context: context)
                model.show(tab, thread: thread)
                self.message = "Select, mark or draw on the page, then choose Attach."
                while !Task.isCancelled {
                    guard model.annotationTargetIsCurrent(tab, thread: thread, port: port), !app.isRemote(thread), app.threads[thread] != nil else {
                        throw BrowserAnnotationError.message("This page no longer belongs to the original local thread.")
                    }
                    let value = try await cdp.evaluate("window.__threadbearAnnotation?.read() ?? ({status:'missing'})", context: context)
                    guard value["sessionId"] as? String == id else { throw BrowserAnnotationError.message("The page changed and its annotation session ended.") }
                    switch value["status"] as? String {
                    case "cancelled":
                        self.message = nil
                        return
                    case "ready":
                        guard let object = value["annotation"] as? [String: Any] else { throw BrowserAnnotationError.message("The page returned no annotation.") }
                        let annotation = try BrowserAnnotationPayload.decode(object)
                        self.message = "Attaching annotation…"
                        var images: [ImageRef] = []
                        var warning: String?
                        do {
                            let shot = try await cdp.call("Page.captureScreenshot", ["format": "png", "captureBeyondViewport": false])
                            guard let base64 = shot["data"] as? String, base64.count <= 14 * 1024 * 1024,
                                  let bytes = Data(base64Encoded: base64), NSImage(data: bytes) != nil else {
                                throw BrowserAnnotationError.message("The screenshot couldn't be captured.")
                            }
                            let current = try await cdp.evaluate("window.__threadbearAnnotation?.read() ?? ({status:'missing'})", context: context)
                            guard current["sessionId"] as? String == id, current["status"] as? String == "ready" else { throw CancellationError() }
                            try Task.checkCancellation()
                            let file = FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-annotation-\(id).png")
                            try bytes.write(to: file, options: [.atomic])
                            defer { try? FileManager.default.removeItem(at: file) }
                            images = await app.importImages([file])
                            if images.isEmpty { warning = "The screenshot couldn't be attached; your comment and page context are in the draft." }
                        } catch is CancellationError { throw CancellationError() }
                        catch {
                            warning = "The screenshot couldn't be attached; your comment and page context are in the draft."
                        }
                        try Task.checkCancellation()
                        if let current = try? await cdp.evaluate("window.__threadbearAnnotation?.read() ?? ({status:'missing'})", context: context) {
                            guard current["sessionId"] as? String == id, current["status"] as? String == "ready" else { throw CancellationError() }
                        } else if warning == nil { throw BrowserAnnotationError.message("The annotation page changed before it could be attached.") }
                        try Task.checkCancellation()
                        guard model.annotationTargetIsCurrent(tab, thread: thread, port: port), !app.isRemote(thread), app.threads[thread] != nil else {
                            throw BrowserAnnotationError.message("The original thread or browser page moved before the annotation could be attached.")
                        }
                        Self.append(annotation, images: images, to: thread, app: app)
                        _ = try? await cdp.evaluate("window.__threadbearAnnotation?.finish(); ({done:true})", context: context)
                        self.message = warning ?? "Annotation attached to this thread's draft. Review it, then send."
                        app.focusComposer(thread)
                        return
                    case "active": break
                    default: throw BrowserAnnotationError.message("The annotation tools stopped responding.")
                    }
                    try await Task.sleep(for: .milliseconds(400))
                }
            } catch is CancellationError {
                if self.message != "The page navigated. Open Annotate again on the new page." { self.message = nil }
            } catch { self.message = error.localizedDescription }
            if let cdp = self.connection, let context = self.contextID {
                // A cancelled task cannot issue a CDP call; cleanup gets its own short task.
                await Task { _ = try? await cdp.evaluate("if(window.__threadbearAnnotation?.sessionId===\(Self.jsString(id))) window.__threadbearAnnotation.finish(); ({done:true})", context: context) }.value
            }
        }
    }

    func cancel() { message = nil; task?.cancel() }

    static func append(_ annotation: BrowserAnnotationPayload, images: [ImageRef], to thread: String, app: AppModel) {
        var draft = (app.drafts[thread] ?? Draft()).normalized
        if !draft.text.isEmpty { draft.text += "\n\n" }
        draft.text += annotation.draftText(screenshotAvailable: !images.isEmpty)
        draft.append(images)
        app.drafts[thread] = draft
    }

    private static func jsString(_ string: String) -> String {
        String(data: try! JSONEncoder().encode(string), encoding: .utf8)!
    }
}
