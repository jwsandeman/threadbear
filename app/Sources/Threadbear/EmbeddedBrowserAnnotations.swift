import AppKit
import Combine
import ThreadbearCore
import WebKit

/// Annotation runs in the existing panel's web view; it never opens or controls a browser window.
@MainActor
final class EmbeddedBrowserAnnotations: ObservableObject {
    static let shared = EmbeddedBrowserAnnotations()
    static let world = WKContentWorld.world(name: "Threadbear embedded annotations")
    @Published private(set) var activeViewID: ObjectIdentifier?
    @Published private(set) var threadID: String?
    @Published private(set) var sourceURL: URL?
    @Published private(set) var message: String?
    private(set) weak var activeWebView: WKWebView?
    private var task: Task<Void, Never>?
    private var navigationWatch: NSKeyValueObservation?
    private var addressWatch: NSKeyValueObservation?
    private let source: @MainActor () -> String?
    private let importImages: @MainActor ([URL], AppModel) async -> [ImageRef]

    init(source: @escaping @MainActor () -> String? = { BrowserAnnotations.source },
         importImages: @escaping @MainActor ([URL], AppModel) async -> [ImageRef] = { files, app in await app.importImages(files) }) {
        self.source = source
        self.importImages = importImages
    }

    func start(webView: WKWebView, sourceURL: URL, thread: String, app: AppModel) {
        guard task == nil else { return }
        threadID = thread
        self.sourceURL = sourceURL
        guard app.experiments.contains("browserAnnotations"), app.threads[thread] != nil, !app.isRemote(thread) else {
            message = "Annotations are available in this Mac's threads."
            return
        }
        guard !webView.isLoading, webView.bounds.width > 0, webView.bounds.height > 0 else {
            message = "Wait for the page to finish loading, then try Annotate again."
            return
        }
        guard let source = source() else { message = "The annotation tools are missing from this app build."; return }
        let id = UUID().uuidString
        let address = webView.url
        activeWebView = webView
        activeViewID = ObjectIdentifier(webView)
        message = "Opening annotation tools…"
        navigationWatch = webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            MainActor.assumeIsolated {
                if view.isLoading { self?.pageChanged() }
            }
        }
        addressWatch = webView.observe(\.url, options: [.new]) { [weak self] view, _ in
            MainActor.assumeIsolated {
                if view.url != address { self?.pageChanged() }
            }
        }
        task = Task { [weak self, weak webView, weak app] in
            guard let self, let webView, let app else { return }
            do {
                // App-owned script still runs when a local preview's own JavaScript is disabled.
                _ = try await webView.callAsyncJavaScript("return (\(source))(sessionID);", arguments: ["sessionID": id], contentWorld: Self.world)
                try Task.checkCancellation()
                self.message = "Select, mark or draw here, then choose Attach."
                while !Task.isCancelled {
                    guard app.experiments.contains("browserAnnotations"), app.threads[thread] != nil, !app.isRemote(thread) else {
                        throw BrowserAnnotationError.message("The original local thread is no longer available.")
                    }
                    let value = try await self.read(webView, session: id)
                    switch value["status"] as? String {
                    case "active": break
                    case "cancelled": self.message = nil; throw CancellationError()
                    case "ready":
                        guard let object = value["annotation"] as? [String: Any] else {
                            throw BrowserAnnotationError.message("The page returned no annotation.")
                        }
                        var annotation = try BrowserAnnotationPayload.decode(object)
                        // The private preview scheme is an implementation detail, not the file to change.
                        if sourceURL.isFileURL { annotation.url = sourceURL.absoluteString }
                        self.message = "Attaching annotation…"
                        var images: [ImageRef] = []
                        var warning: String?
                        do {
                            let image = try await webView.takeSnapshot(configuration: nil)
                            guard let tiff = image.tiffRepresentation,
                                  let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]),
                                  png.count <= 14 * 1024 * 1024 else {
                                throw BrowserAnnotationError.message("The screenshot couldn't be captured.")
                            }
                            try Task.checkCancellation()
                            _ = try await self.read(webView, session: id, ready: true)
                            let file = FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-embedded-annotation-\(id).png")
                            try png.write(to: file, options: .atomic)
                            defer { try? FileManager.default.removeItem(at: file) }
                            images = await self.importImages([file], app)
                            if images.isEmpty { warning = "The screenshot couldn't be attached; your comment and page context are in the draft." }
                        } catch is CancellationError { throw CancellationError() }
                        catch { warning = "The screenshot couldn't be attached; your comment and page context are in the draft." }
                        try Task.checkCancellation()
                        _ = try await self.read(webView, session: id, ready: true)
                        guard app.threads[thread] != nil, !app.isRemote(thread), app.experiments.contains("browserAnnotations") else {
                            throw BrowserAnnotationError.message("The original local thread is no longer available.")
                        }
                        BrowserAnnotations.append(annotation, images: images, to: thread, app: app)
                        self.message = warning ?? "Annotation attached to this thread's draft. Review it, then send."
                        app.focusComposer(thread)
                        await self.finish(webView, session: id)
                        self.clear()
                        return
                    default: throw BrowserAnnotationError.message("The annotation tools stopped responding. Try Annotate again.")
                    }
                    try await Task.sleep(for: .milliseconds(200))
                }
            } catch is CancellationError {
                // Cancel and navigation already set their own message.
            } catch { if !Task.isCancelled { self.message = error.localizedDescription } }
            // Cleanup must run outside the cancelled task's cancellation state.
            await Task { await self.finish(webView, session: id) }.value
            self.clear()
        }
    }

    func cancel() { message = nil; task?.cancel() }

    func cancel(webView: WKWebView) {
        if activeWebView === webView { cancel() }
    }

    private func pageChanged() {
        message = "The page changed. Open Annotate again when it finishes loading."
        task?.cancel()
    }

    private func read(_ webView: WKWebView, session: String, ready: Bool = false) async throws -> [String: Any] {
        let result = try await webView.callAsyncJavaScript("return window.__threadbearAnnotation?.read() ?? {status:'missing'};", contentWorld: Self.world)
        guard let value = result as? [String: Any], value["sessionId"] as? String == session else {
            throw BrowserAnnotationError.message("The page changed and its annotation session ended.")
        }
        if ready, value["status"] as? String != "ready" { throw CancellationError() }
        return value
    }

    private func finish(_ webView: WKWebView, session: String) async {
        _ = try? await webView.callAsyncJavaScript("if (window.__threadbearAnnotation?.sessionId === sessionID) window.__threadbearAnnotation.finish(); return true;",
                                                 arguments: ["sessionID": session], contentWorld: Self.world)
    }

    private func clear() {
        navigationWatch = nil
        addressWatch = nil
        activeWebView = nil
        activeViewID = nil
        task = nil
    }
}
