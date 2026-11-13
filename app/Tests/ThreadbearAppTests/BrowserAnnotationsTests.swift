import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

@MainActor
final class BrowserAnnotationsTests: XCTestCase {
    override func setUp() { super.setUp(); _ = NSApplication.shared }
    private func payload() -> [String: Any] {
        ["url": "http://localhost:3000/settings", "title": "Settings", "comment": "Make this button wider",
         "elements": [["selector": "#save", "tagName": "button", "outerHTML": "<button id=\"save\">Save</button>",
                       "text": "Save", "styles": ["width": "80px"], "rect": ["x": 12, "y": 30, "width": 80, "height": 24]]],
         "regions": [], "strokes": [], "viewport": ["width": 1200, "height": 800, "scrollX": 0, "scrollY": 0]]
    }

    func testCapturesContextAndKeepsExistingPicturesInTheOriginatingDraft() throws {
        let annotation = try BrowserAnnotationPayload.decode(payload())
        let app = AppModel()
        app.threads["origin"] = ThreadSummary(id: "origin", title: "Original")
        app.threads["other"] = ThreadSummary(id: "other", title: "Other")
        let existing = ImageRef(path: "/inbox/existing.png", mediaType: "image/png")
        let captured = ImageRef(path: "/inbox/annotation.png", mediaType: "image/png")
        app.drafts["origin"] = Draft(text: "Keep my words \(InlinePictures.markString)", images: [existing])
        app.drafts["other"] = Draft(text: "Unrelated")
        app.select("other")
        BrowserAnnotations.append(annotation, images: [captured], to: "origin", app: app)
        XCTAssertTrue(app.drafts["origin"]!.text.hasPrefix("Keep my words"))
        XCTAssertTrue(app.drafts["origin"]!.text.contains("Make this button wider"))
        XCTAssertTrue(app.drafts["origin"]!.text.contains("#save"))
        XCTAssertTrue(app.drafts["origin"]!.text.contains("http://localhost:3000/settings"))
        XCTAssertEqual(app.drafts["other"]?.text, "Unrelated")
        XCTAssertEqual(app.drafts["origin"]?.images, [existing, captured])
        XCTAssertTrue(app.drafts["origin"]!.words().contains("[Picture 1]"))
        XCTAssertTrue(app.drafts["origin"]!.words().contains("[Picture 2]"))
    }

    func testRejectsOversizedAndMalformedPageResults() {
        var tooMany = payload()
        tooMany["elements"] = Array(repeating: (payload()["elements"] as! [[String: Any]])[0], count: 21)
        XCTAssertThrowsError(try BrowserAnnotationPayload.decode(tooMany))
        var tooLong = payload()
        tooLong["comment"] = String(repeating: "x", count: 16001)
        XCTAssertThrowsError(try BrowserAnnotationPayload.decode(tooLong))
        var malformed = payload()
        malformed["viewport"] = ["width": -10, "height": 200, "scrollX": 0, "scrollY": 0]
        XCTAssertThrowsError(try BrowserAnnotationPayload.decode(malformed))
        var empty = payload()
        empty["elements"] = []
        XCTAssertThrowsError(try BrowserAnnotationPayload.decode(empty))
    }

    func testPageTextCannotIntroducePictureChips() throws {
        var value = payload()
        value["comment"] = "Comment \(InlinePictures.markString) here"
        let annotation = try BrowserAnnotationPayload.decode(value)
        XCTAssertFalse(annotation.draftText(screenshotAvailable: true).contains(InlinePictures.markString))
    }

    func testDrawingOnlyCaptureFailureKeepsMarkedLocationsAndComment() throws {
        var value = payload()
        value["elements"] = []
        value["comment"] = "Move this circled area down"
        value["strokes"] = [["points": [["x": 321, "y": 456], ["x": 654, "y": 789]]]]
        let annotation = try BrowserAnnotationPayload.decode(value)
        let app = AppModel()
        app.threads["origin"] = ThreadSummary(id: "origin", title: "Original")
        BrowserAnnotations.append(annotation, images: [], to: "origin", app: app)
        let text = try XCTUnwrap(app.drafts["origin"]?.text)
        XCTAssertTrue(text.contains("Move this circled area down"))
        XCTAssertFalse(text.contains("shown in the screenshot"))
        let json = try XCTUnwrap(text.components(separatedBy: "```json\n").last?.components(separatedBy: "\n```").first)
        let context = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let strokes = try XCTUnwrap(context["strokes"] as? [[String: Any]])
        let points = try XCTUnwrap(strokes.first?["points"] as? [[String: Int]])
        XCTAssertEqual(points, [["x": 321, "y": 456], ["x": 654, "y": 789]])
        XCTAssertTrue((context["screenshot"] as? String)?.hasPrefix("Unavailable") == true)
        XCTAssertEqual(app.drafts["origin"]?.images, [])
    }

    func testDebuggerEndpointMustBeTheExactLocalTarget() throws {
        let target = "ABC123"
        let good = "ws://127.0.0.1:9222/devtools/page/\(target)"
        XCTAssertEqual(try BrowserAnnotationCDP.endpoint(good, target: target, port: 9222).absoluteString, good)
        for bad in ["ws://example.com:9222/devtools/page/ABC123", "ws://127.0.0.1:9223/devtools/page/ABC123",
                    "ws://127.0.0.1:9222/devtools/page/OTHER", "ws://user@127.0.0.1:9222/devtools/page/ABC123",
                    "ws://127.0.0.1:9222/devtools/page/ABC123?next=other"] {
            XCTAssertThrowsError(try BrowserAnnotationCDP.endpoint(bad, target: target, port: 9222))
        }
    }

    func testOwnershipReadsTheExactThreadTargetAndPortFromDiskEachTime() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("browser-annotation-owner-\(UUID().uuidString)")
        let agent = home.appendingPathComponent("agent")
        try FileManager.default.createDirectory(at: agent, withIntermediateDirectories: true)
        let before = ProcessInfo.processInfo.environment["BROWSERBEAR_HOME"]
        setenv("BROWSERBEAR_HOME", home.path, 1)
        defer {
            if let before { setenv("BROWSERBEAR_HOME", before, 1) } else { unsetenv("BROWSERBEAR_HOME") }
            try? FileManager.default.removeItem(at: home)
        }
        var record: [String: Any] = ["tabId": 7, "targetId": "TARGET", "thread": "origin", "url": "https://example.com", "title": "Example"]
        func save() throws {
            let state: [String: Any] = ["port": 9222, "socket": home.appendingPathComponent("browser.sock").path, "tabs": [record]]
            try JSONSerialization.data(withJSONObject: state).write(to: agent.appendingPathComponent("tabs.json"), options: .atomic)
        }
        try save()
        let tab = try JSONDecoder().decode(AgentTab.self, from: JSONSerialization.data(withJSONObject: record))
        let model = AgentBrowserModel.shared
        XCTAssertTrue(model.annotationTargetIsCurrent(tab, thread: "origin", port: 9222))
        XCTAssertFalse(model.annotationTargetIsCurrent(tab, thread: "origin", port: 9223))
        XCTAssertFalse(model.annotationTargetIsCurrent(tab, thread: "other", port: 9222))
        var otherTarget = tab
        otherTarget.targetId = "OTHER"
        XCTAssertFalse(model.annotationTargetIsCurrent(otherTarget, thread: "origin", port: 9222))
        var profileTab = tab
        profileTab.profile = "personal"
        XCTAssertFalse(model.annotationTargetIsCurrent(profileTab, thread: "origin", port: 9222))
        var bridgedTab = tab
        bridgedTab.bridge = true
        XCTAssertFalse(model.annotationTargetIsCurrent(bridgedTab, thread: "origin", port: 9222))
        record["thread"] = "other"
        try save()
        XCTAssertFalse(model.annotationTargetIsCurrent(tab, thread: "origin", port: 9222), "A reassignment is read immediately, without waiting for the panel poll")
    }

    func testDisconnectedDebuggerResumesItsRequest() async throws {
        let connection = BrowserAnnotationCDP(url: URL(string: "ws://127.0.0.1:1/devtools/page/TEST")!, timeout: 0.1)
        defer { connection.close() }
        do {
            _ = try await connection.call("Runtime.evaluate", ["expression": "1"])
            XCTFail("An unavailable browser must fail the request")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }
    }
}
