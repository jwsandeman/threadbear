import AppKit
import WebKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

@MainActor
final class EmbeddedBrowserAnnotationsTests: XCTestCase {
    private let world = WKContentWorld.world(name: "Threadbear embedded annotations")
    private let page = URL(string: "https://annotation.test/preview")!

    override func setUp() { super.setUp(); _ = NSApplication.shared }

    private func source() throws -> String {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Sources/Threadbear/Resources/Annotations/annotation.js").standardizedFileURL
        return try String(contentsOf: file, encoding: .utf8)
    }

    private func waitFor(_ description: String, _ check: () async -> Bool) async throws {
        for _ in 0..<100 {
            if await check() { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        XCTFail("Timed out: \(description)")
    }

    private func fixture() async throws -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700), configuration: config)
        view.loadHTMLString("""
        <!doctype html><title>Embedded test</title><style>body{margin:100px}button{padding:20px}</style>
        <button id="target">Save changes</button><script>window.pageScriptRan = true</script>
        """, baseURL: page)
        try await waitFor("page loaded") {
            guard !view.isLoading else { return false }
            return (try? await view.evaluateJavaScript("document.readyState") as? String) == "complete"
        }
        // Keep a test-only handle to the real closed root in the same isolated world.
        _ = try await view.callAsyncJavaScript("""
        const original = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(options) {
          const root = original.call(this, options); window.testAnnotationRoot = root; return root;
        }; return true;
        """, contentWorld: world)
        return view
    }

    private func app() -> AppModel {
        let app = AppModel()
        app.experiments.insert("browserAnnotations")
        app.threads["origin"] = ThreadSummary(id: "origin", title: "Original")
        app.threads["other"] = ThreadSummary(id: "other", title: "Other")
        app.drafts["origin"] = Draft(text: "Keep this draft")
        app.drafts["other"] = Draft(text: "Unrelated")
        return app
    }

    private func ready(_ controller: EmbeddedBrowserAnnotations, view: WKWebView) async throws {
        try await waitFor("annotation tools active: \(controller.message ?? "")") {
            (try? await view.callAsyncJavaScript("return window.__threadbearAnnotation?.read().status", contentWorld: self.world) as? String) == "active"
        }
    }

    private func submit(in view: WKWebView) async throws {
        _ = try await view.callAsyncJavaScript("""
        const rect = document.getElementById('target').getBoundingClientRect();
        window.dispatchEvent(new PointerEvent('pointerdown', {clientX: rect.x + 10, clientY: rect.y + 10, button: 0, bubbles: true}));
        window.testAnnotationRoot.querySelector('textarea').value = 'Make this action clearer';
        window.testAnnotationRoot.querySelector('.attach').click();
        return true;
        """, contentWorld: world)
    }

    func testEmbeddedCaptureWorksWithPageScriptsOffAndKeepsOriginatingDraft() async throws {
        let source = try source(), view = try await fixture(), app = app()
        var captured = false
        let controller = EmbeddedBrowserAnnotations(source: { source }, importImages: { files, _ in
            captured = files.count == 1 && NSImage(contentsOf: files[0]) != nil
            return [ImageRef(path: "/inbox/embedded.png", mediaType: "image/png")]
        })
        controller.start(webView: view, sourceURL: page, thread: "origin", app: app)
        defer { controller.cancel() }
        try await ready(controller, view: view)
        let pageScript = try await view.evaluateJavaScript("typeof window.pageScriptRan") as? String
        let pageAPI = try await view.evaluateJavaScript("typeof window.__threadbearAnnotation") as? String
        XCTAssertEqual(pageScript, "undefined")
        XCTAssertEqual(pageAPI, "undefined")
        XCTAssertFalse(view.configuration.defaultWebpagePreferences.allowsContentJavaScript)
        app.select("other")
        try await submit(in: view)
        try await waitFor("annotation attached") { controller.activeWebView == nil }
        XCTAssertTrue(captured, controller.message ?? "No captured image")
        XCTAssertTrue(app.drafts["origin"]?.text.hasPrefix("Keep this draft") == true)
        XCTAssertTrue(app.drafts["origin"]?.text.contains("Make this action clearer") == true)
        XCTAssertTrue(app.drafts["origin"]?.text.contains(page.absoluteString) == true)
        XCTAssertEqual(app.drafts["origin"]?.images.count, 1)
        XCTAssertEqual(app.drafts["other"]?.text, "Unrelated")
        let overlays = try await view.evaluateJavaScript("document.querySelectorAll('[data-threadbear-annotation-ui]').length") as? Int
        XCTAssertEqual(overlays, 0)
    }

    func testCancelAndNavigationRemoveToolsWithoutChangingDraft() async throws {
        let source = try source(), view = try await fixture(), app = app()
        let controller = EmbeddedBrowserAnnotations(source: { source })
        controller.start(webView: view, sourceURL: page, thread: "origin", app: app)
        try await ready(controller, view: view)
        controller.cancel(webView: view)
        try await waitFor("cancel cleanup") { controller.activeWebView == nil }
        XCTAssertEqual(app.drafts["origin"]?.text, "Keep this draft")
        let overlays = try await view.evaluateJavaScript("document.querySelectorAll('[data-threadbear-annotation-ui]').length") as? Int
        XCTAssertEqual(overlays, 0)

        controller.start(webView: view, sourceURL: page, thread: "origin", app: app)
        try await ready(controller, view: view)
        view.loadHTMLString("<title>Next page</title>", baseURL: URL(string: "https://annotation.test/next")!)
        try await waitFor("navigation cancels annotation") { controller.activeWebView == nil }
        XCTAssertEqual(app.drafts["origin"]?.text, "Keep this draft")
        XCTAssertTrue(controller.message?.contains("page") == true)
    }

    func testEvictingPooledLocalPreviewCancelsItsAnnotation() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("EmbeddedAnnotationEviction-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("index.html")
        try "<!doctype html><title>Local preview</title><button>Save</button>".write(to: file, atomically: true, encoding: .utf8)
        let pool = WebPanelPool(), app = app()
        let view = pool.webView(for: file)
        view.frame = NSRect(x: 0, y: 0, width: 900, height: 700)
        try await waitFor("local preview loaded") {
            guard !view.isLoading, view.url?.scheme == LocalPreviewSchemeHandler.scheme else { return false }
            return (try? await view.evaluateJavaScript("document.readyState") as? String) == "complete"
        }
        let controller = EmbeddedBrowserAnnotations.shared
        controller.start(webView: view, sourceURL: file, thread: "origin", app: app)
        defer { controller.cancel() }
        try await ready(controller, view: view)
        for index in 0..<WebPanelPool.capacity {
            _ = pool.webView(for: URL(string: "about:blank#annotation-eviction-\(index)")!)
        }
        try await waitFor("eviction cancels the original annotation") { controller.activeWebView == nil }
        XCTAssertEqual(app.drafts["origin"]?.text, "Keep this draft")
        let overlays = try await view.evaluateJavaScript("document.querySelectorAll('[data-threadbear-annotation-ui]').length") as? Int
        XCTAssertEqual(overlays, 0)
    }
}
