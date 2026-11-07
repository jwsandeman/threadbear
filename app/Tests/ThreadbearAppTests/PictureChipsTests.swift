import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// Pictures as chips among the composer's words (docs/protocol.md,
/// "Pictures in a message"; Mike, 1 Nov 2026).
@MainActor
final class PictureChipsTests: XCTestCase {
    let m = InlinePictures.markString
    let red = ImageRef(path: "/inbox/red.png", mediaType: "image/png")
    let blue = ImageRef(path: "/inbox/blue.png", mediaType: "image/png")

    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// Kept for the test: a chip settles only in a box still in a window.
    private var windows: [NSWindow] = []

    private func composer() -> (NSWindow, ComposerTextView) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 200), styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        let textView = ComposerTextField.makeTextView()
        textView.frame = NSRect(x: 0, y: 0, width: 500, height: 200)
        window.contentView = textView
        windows.append(window)
        return (window, textView)
    }

    override func tearDown() {
        windows.removeAll()
        super.tearDown()
    }

    private func chips(_ textView: NSTextView) -> [PictureAttachment] {
        var found: [PictureAttachment] = []
        textView.textStorage?.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textView.textStorage?.length ?? 0)) { value, _, _ in
            if let chip = value as? PictureAttachment { found.append(chip) }
        }
        return found
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<400 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func testADraftShowsItsMarksAsNumberedChipsAndReadsBack() {
        let (_, textView) = composer()
        let draft = Draft(text: "this \(m) like \(m)", images: [red, blue])
        textView.show(draft)
        XCTAssertEqual(textView.draftNow, draft)
        XCTAssertEqual(chips(textView).map(\.number), [1, 2])
        XCTAssertEqual(chips(textView).map(\.picture), [red, blue])
        // A zoom change restyles the words and keeps the chips.
        textView.applyTypeScale()
        XCTAssertEqual(textView.draftNow, draft)
        // A picture with no mark gets a chip at the end.
        textView.show(Draft(text: "look", images: [red]))
        XCTAssertEqual(textView.draftNow, Draft(text: "look \(m)", images: [red]))
    }

    /// U+FFFC pasted as text isn't a picture.
    func testAStrayMarkInTheWordsIsNoPicture() {
        let (_, textView) = composer()
        textView.replaceText("odd \u{FFFC} text")
        XCTAssertEqual(textView.draftNow, Draft(text: "odd  text"))
    }

    /// A paste goes in where the cursor is, with a space either side;
    /// it's dimmed and left out of the draft until the runner has it.
    func testPastedPicturesGoInWhereTheCursorIs() async throws {
        let (_, textView) = composer()
        textView.replaceText("compare this with that")
        var release: CheckedContinuation<Void, Never>?
        textView.pictures = .init(allowed: { true }, importOne: { url in
            await withCheckedContinuation { release = $0 }
            return ImageRef(path: "/inbox/" + url.lastPathComponent, mediaType: "image/png")
        })
        textView.setSelectedRange(NSRange(location: 12, length: 0))
        textView.insertPictures([URL(fileURLWithPath: "/tmp/shot.png")])
        XCTAssertEqual(textView.string, "compare this \u{FFFC} with that")
        XCTAssertEqual(textView.selectedRange().location, 14, "the cursor goes after the chip")
        XCTAssertEqual(textView.draftNow, Draft(text: "compare this  with that"), "not in the draft until it's in")
        XCTAssertNil(chips(textView).first?.picture)
        try await until { release != nil }
        release?.resume()
        try await until { textView.draftNow.images.count == 1 }
        XCTAssertEqual(textView.draftNow, Draft(text: "compare this \(m) with that",
                                                images: [ImageRef(path: "/inbox/shot.png", mediaType: "image/png")]))

        // Two at the end of the words: spaced, and numbered in order.
        textView.pictures = .init(allowed: { true }, importOne: { url in ImageRef(path: "/inbox/" + url.lastPathComponent, mediaType: "image/png") })
        textView.setSelectedRange(NSRange(location: (textView.string as NSString).length, length: 0))
        textView.insertPictures([URL(fileURLWithPath: "/tmp/a.png"), URL(fileURLWithPath: "/tmp/b.png")])
        try await until { textView.draftNow.images.count == 3 }
        XCTAssertEqual(textView.draftNow.text, "compare this \(m) with that \(m) \(m) ")
        XCTAssertEqual(textView.draftNow.images.map(\.path), ["/inbox/shot.png", "/inbox/a.png", "/inbox/b.png"])
        XCTAssertEqual(chips(textView).map(\.number), [1, 2, 3])
    }

    /// A screenshot on the clipboard is only PNG and TIFF, no words. The
    /// box is plain text, so AppKit's own list had no picture types and it
    /// greyed Paste out: ⌘V did nothing at all (Jason, 7 Nov). The menu
    /// item must validate, and a real paste must make a chip.
    func testAnImageOnlyClipboardCanBePasted() async throws {
        let (window, textView) = composer()
        window.makeFirstResponder(textView)
        textView.replaceText("look ")
        textView.setSelectedRange(NSRange(location: 5, length: 0))
        textView.pictures = .init(allowed: { true }, importOne: { url in ImageRef(path: "/inbox/" + url.lastPathComponent, mediaType: "image/png") })
        let image = NSImage(size: NSSize(width: 2, height: 2), flipped: false) { rect in NSColor.red.setFill(); rect.fill(); return true }
        let png = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation))?.representation(using: .png, properties: [:]))
        // `paste` reads the general pasteboard, so the test uses it and puts
        // back whatever was on it (a run cleared Jason's screenshot, 7 Nov).
        let pasteboard = NSPasteboard.general
        let before = (pasteboard.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
            return copy
        }
        defer { pasteboard.clearContents(); if !before.isEmpty { pasteboard.writeObjects(before) } }
        pasteboard.clearContents()
        pasteboard.setData(png, forType: .png)

        XCTAssertNotNil(pasteboard.availableType(from: textView.readablePasteboardTypes), "Paste stays enabled for a picture alone")
        let item = NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        XCTAssertTrue(textView.validateUserInterfaceItem(item))
        textView.paste(nil)
        try await until { textView.draftNow.images.count == 1 }
        XCTAssertEqual(textView.draftNow.text, "look \(m) ")
        XCTAssertTrue(textView.draftNow.images[0].path.hasPrefix("/inbox/pasted-"))
    }

    /// One that couldn't be read goes again; none go where they aren't allowed.
    func testAPictureThatCouldNotBeReadGoes() async throws {
        let (_, textView) = composer()
        textView.replaceText("hi")
        textView.setSelectedRange(NSRange(location: 2, length: 0))
        textView.pictures = .init(allowed: { true }, importOne: { _ in nil })
        textView.insertPictures([URL(fileURLWithPath: "/tmp/broken.png")])
        try await until { !textView.string.contains("\u{FFFC}") }
        XCTAssertEqual(textView.string, "hi ")
        textView.pictures = .init(allowed: { false }, importOne: { _ in nil })
        textView.insertPictures([URL(fileURLWithPath: "/tmp/a.png")])
        XCTAssertEqual(textView.string, "hi ")
    }

    /// The strip's remove button takes the chip and a space beside it.
    func testRemovingAPictureTakesItsChipOut() {
        let (_, textView) = composer()
        textView.show(Draft(text: "this \(m) like \(m) ok", images: [red, blue]))
        XCTAssertTrue(textView.removePicture(at: 0))
        XCTAssertEqual(textView.draftNow, Draft(text: "this like \(m) ok", images: [blue]))
        XCTAssertEqual(chips(textView).map(\.number), [1])
        XCTAssertFalse(textView.removePicture(at: 1))
        XCTAssertEqual(Draft(text: "a \(m) b \(m)", images: [red, blue]).removingImage(at: 1), Draft(text: "a \(m) b", images: [red]))
    }

    /// Cut or copied chips paste back with their pictures; anywhere else
    /// they read as the markers the agent would get.
    func testCopiedChipsPasteBackWithTheirPictures() {
        let (_, from) = composer()
        from.show(Draft(text: "x \(m) y", images: [red]))
        from.setSelectedRange(NSRange(location: 0, length: (from.string as NSString).length))
        let board = NSPasteboard(name: NSPasteboard.Name("threadbear-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        XCTAssertTrue(from.writeSelection(to: board, types: from.writablePasteboardTypes))
        XCTAssertEqual(board.string(forType: .string), "x [Picture 1] y")

        let (_, to) = composer()
        to.pictures = .init(allowed: { true }, importOne: { _ in nil })
        to.replaceText("> ")
        to.setSelectedRange(NSRange(location: 2, length: 0))
        XCTAssertTrue(to.readSelection(from: board))
        XCTAssertEqual(to.draftNow, Draft(text: "> x \(m) y", images: [red]))
    }

    /// His bubble draws the markers that place a picture as chips; others stay words.
    func testTheBubbleDrawsMarkersAsChips() {
        let text = RowRenderer.userText(UserMessage(text: "see [Picture 1] and [Picture 2], not [Picture 3]", images: [red, blue]))
        XCTAssertEqual(text.string, "see \u{FFFC} and \u{FFFC}, not [Picture 3]")
        var attachments = 0
        text.enumerateAttribute(.attachment, in: NSRange(location: 0, length: text.length)) { value, _, _ in
            if value != nil { attachments += 1 }
        }
        XCTAssertEqual(attachments, 2)
        XCTAssertEqual(RowRenderer.userText(UserMessage(text: "[Picture 1]", images: [])).string, "[Picture 1]")
    }

    /// An ask's Something else box takes pictures as chips too, and its
    /// answer carries them as markers where they sit.
    func testAnAnswerBoxTakesPicturesAsChips() async throws {
        let box = AskAnswerBox(frame: NSRect(x: 0, y: 0, width: 400, height: 80))
        let window = NSWindow(contentRect: box.frame, styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.contentView = box
        windows.append(window)
        var notes: [AskNote] = []
        box.onChange = { notes.append($0) }
        box.pictures = .init(allowed: { true }, importOne: { url in ImageRef(path: "/inbox/" + url.lastPathComponent, mediaType: "image/png") })
        box.show(AskNote(text: "Like this"))
        box.textView.setSelectedRange(NSRange(location: 9, length: 0))
        box.textView.insertPictures([URL(fileURLWithPath: "/tmp/a.png")])
        try await until { notes.last?.images.count == 1 }
        let a = ImageRef(path: "/inbox/a.png", mediaType: "image/png")
        XCTAssertEqual(notes.last, AskNote(text: "Like this \(m) ", images: [a]))
        let ask = Ask(action: "Which layout?", why: "Pick one.")
        let answer = Decisions.answers(asks: [ask], picks: [0: Decisions.ownAnswer], notes: [0: notes.last!]).first?.answer.answer
        XCTAssertEqual(answer, "Like this [Picture 1]")
        // The cross on its thumbnail takes the chip out too.
        box.show(notes.last!)
        notes.removeAll()
        let thumbs = box.subviews.filter { !($0 is NSScrollView) && !($0 is NSButton) }
        XCTAssertEqual(thumbs.count, 1)
        XCTAssertTrue(box.textView.removePicture(at: 0))
        XCTAssertEqual(notes.last, AskNote(text: "Like this ", images: []))
    }

    /// A box leaves room for its chips' width when it measures its lines.
    func testABoxMeasuresChipsAtTheirWidth() {
        XCTAssertEqual(AskBoxMetrics.lines("Like this one", width: 200), 1)
        XCTAssertGreaterThan(AskBoxMetrics.lines("Like \(m) \(m) \(m)", width: 200), 1)
    }

    /// A chip links to its own picture, whichever order the words have them in,
    /// so it hovers, drags and opens as that picture.
    func testABubbleChipIsALinkToItsPicture() {
        let text = RowRenderer.userText(UserMessage(text: "[Picture 2] then [Picture 1]", images: [red, blue]))
        let first = text.attributes(at: 0, effectiveRange: nil)
        XCTAssertEqual(first[.link] as? URL, URL(fileURLWithPath: blue.path))
        XCTAssertEqual(first[.tbPictureChip] as? NSNumber, 1)
        let second = text.attributes(at: text.length - 1, effectiveRange: nil)
        XCTAssertEqual(second[.link] as? URL, URL(fileURLWithPath: red.path))
        XCTAssertEqual(second[.tbPictureChip] as? NSNumber, 0)
    }

    /// Editing a message puts its chips back where its markers were.
    func testEditingAMessagePutsItsChipsBack() {
        let app = AppModel()
        app.startEditing(threadId: "th1", seq: 4, text: "this [Picture 2] like [Picture 1]", images: [red, blue])
        XCTAssertEqual(app.drafts["th1"], Draft(text: "this \(m) like \(m)", images: [blue, red]))
    }
}
