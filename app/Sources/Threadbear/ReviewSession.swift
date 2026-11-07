import Foundation
import Observation
import ThreadbearCore

/// The window works against these operations so reconnecting uses the new
/// client, and draft races can be tested without a window or a real runner.
@MainActor
struct ReviewService {
    var load: () async throws -> DesignReview
    var save: (Int, ReviewDraft) async throws -> DesignReview
    var respond: (Int, ReviewDraft) async throws -> DesignReview
    var cancel: (Int) async throws -> DesignReview
    /// Whether pictures can go in the reply box (says why not itself), and
    /// copying one in through the runner (`media.import`), as the composer does.
    var picturesAllowed: () -> Bool = { true }
    var importPicture: (URL) async -> ImageRef? = { _ in nil }
}

/// What the title bar's button and the zoom keys ask of the image on the stage.
enum ReviewZoomStep { case fit, actual, closer, further }

/// The serial makes asking twice two asks, as the same step can follow itself.
struct ReviewZoomRequest: Equatable {
    var serial: Int
    var step: ReviewZoomStep
}

@MainActor
@Observable
final class ReviewSession {
    let threadId: String
    private(set) var review: DesignReview
    private(set) var draft: ReviewDraft
    private(set) var dirty = false
    private(set) var saving = false
    private(set) var submitting = false
    private(set) var conflict = false
    var error: String?
    /// All of them on the stage, or one enlarged. A review that's waiting
    /// opens as a walkthrough, one image at a time from the first, ending on
    /// all of them to choose from (Mike, 2 Nov); one that's over opens on
    /// all of them, as there's nothing left to step towards.
    var mode: ReviewMode
    /// Whether the shot on show is zoomed past fitting its space. The image
    /// says so, as pinching and scrolling happen there.
    var zoomed = false
    private(set) var zoomRequest: ReviewZoomRequest?
    /// The option enlarged in .single, and which of its shots.
    private(set) var focused = 0
    private(set) var shot = 0
    /// Today's version over the shot on show, while Space is held or its
    /// button is on, to flick between them (Mike, 4 Nov). Moving anywhere
    /// turns it off.
    var peeking = false

    @ObservationIgnored private let service: ReviewService
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let cacheKey: String
    @ObservationIgnored private let autosave: Bool
    @ObservationIgnored private let reconnectWait: Duration
    @ObservationIgnored private let cacheOwner = UUID().uuidString
    @ObservationIgnored private var timer: Task<Void, Never>?

    private struct CachedDraft: Codable {
        var revision: Int
        var draft: ReviewDraft
        var owner: String?
        var conflict: Bool?
    }

    init(threadId: String, review: DesignReview, service: ReviewService, defaults: UserDefaults = .standard, autosave: Bool = true, reconnectWait: Duration = .seconds(20)) {
        self.threadId = threadId
        self.review = review
        self.draft = review.response ?? review.draft
        self.service = service
        self.defaults = defaults
        self.autosave = autosave
        self.reconnectWait = reconnectWait
        mode = review.isPending && !review.options.isEmpty ? .single : .all
        cacheKey = "reviewDraft.\(threadId).\(review.id)"
        if let data = defaults.data(forKey: cacheKey), let cached = try? JSONDecoder().decode(CachedDraft.self, from: data), cached.draft != draft {
            draft = cached.draft
            dirty = true
            if cached.conflict == true || cached.revision != review.revision || !review.isPending {
                conflict = true
                error = "This review changed elsewhere. Your unsent notes are kept here."
            }
            cacheDraft(force: true)
        }
    }

    var canSubmit: Bool { review.isPending && !submitting && !conflict && draft.canSubmit(options: review.options) }
    var editable: Bool { review.isPending && !submitting }
    var visibleIndices: [Int] {
        switch mode {
        case .all: return Array(review.options.indices)
        case .single: return review.options.indices.contains(focused) ? [focused] : []
        }
    }

    /// Says what will go, so a pick doesn't look like the end of it: until
    /// now it read as done, with Send at the far end of the window (Mike, 1 Nov).
    var sendLabel: String {
        if submitting { return "Sending…" }
        if !draft.pickedIds.isEmpty { return "Send " + draft.pickedIds.joined(separator: " + ") }
        if draft.none { return "Send none of them" }
        return draft.hasReply || draft.hasNotes ? "Send reply" : "Send"
    }

    /// The option on show and its shot, for the stage.
    var focusedOption: ReviewOption? { review.options.indices.contains(focused) ? review.options[focused] : nil }
    var focusedShot: ReviewShot? {
        guard let shots = focusedOption?.allShots, shots.indices.contains(shot) else { return focusedOption?.allShots.first }
        return shots[shot]
    }

    /// What there is to flick to: the first reference option, which agents
    /// use for today's version.
    var baseline: ReviewOption? { review.options.first(where: \.reference) }
    var canPeek: Bool { mode == .single && baseline != nil && baseline?.id != focusedOption?.id }

    /// What the stage shows: the shot on show, or while peeking, today's
    /// shot of the same name (its first if none has that name).
    var shownOption: ReviewOption? { peeking && canPeek ? baseline : focusedOption }
    var shownShot: ReviewShot? {
        guard peeking, canPeek, let baseline else { return focusedShot }
        let shots = baseline.allShots
        return focusedShot?.title.flatMap { title in shots.first { $0.title == title } } ?? shots.first
    }

    func setReply(_ text: String) {
        guard editable else { return }
        var next = draft
        next.reply = text.isEmpty ? nil : text
        edit(next)
    }

    /// The reply as the box holds it: a chip's mark where each picture's
    /// [Picture N] marker is, and the pictures in that order.
    var replyNote: AskNote {
        let (text, images) = InlinePictures.draft(text: draft.reply ?? "", images: draft.images)
        return AskNote(text: text, images: images)
    }

    /// What's in the reply box, words and chips: the words go as the
    /// reply with [Picture N] markers, the pictures as the draft's images.
    func setReply(_ note: AskNote) {
        guard editable else { return }
        let whole = Draft(text: note.text, images: note.images).normalized
        var next = draft
        let words = whole.words()
        next.reply = words.isEmpty ? nil : words
        next.images = whole.images
        edit(next)
    }

    func picturesAllowed() -> Bool { service.picturesAllowed() }
    func importPicture(_ url: URL) async -> ImageRef? { await service.importPicture(url) }

    func setNote(_ text: String, for id: String) {
        guard editable else { return }
        var next = draft
        next.notes[id] = text
        edit(next)
    }

    /// Adds or takes away one pick. Several can be picked ("A + B's to-do
    /// list", Mike, 2 Nov); they stay in the review's order, as the runner
    /// keeps them, so the draft doesn't look changed after a save.
    func pick(_ id: String) {
        guard editable, review.options.contains(where: { $0.id == id && !$0.reference }) else { return }
        var picked = Set(draft.pickedIds)
        if picked.contains(id) { picked.remove(id) } else { picked.insert(id) }
        var next = draft
        next.pickedIds = review.options.map(\.id).filter(picked.contains)
        next.none = false
        edit(next)
    }

    /// None of them will do: it takes the picks away, and a pick takes it away.
    func toggleNone() {
        guard editable else { return }
        var next = draft
        next.none.toggle()
        if next.none { next.pickedIds = [] }
        edit(next)
    }

    private func edit(_ next: ReviewDraft) {
        guard next != draft else { return }
        draft = next
        dirty = true
        cacheDraft(force: true)
        scheduleSave()
    }

    private func cacheDraft(force: Bool = false) {
        // A closing window may finish its save after a new window has
        // edited this review. Its old session must leave the new cache alone.
        if !force, let existing = cachedDraft(), existing.owner != cacheOwner { return }
        if let data = try? JSONEncoder().encode(CachedDraft(revision: review.revision, draft: draft, owner: cacheOwner, conflict: conflict)) {
            defaults.set(data, forKey: cacheKey)
        }
    }

    private func cachedDraft() -> CachedDraft? {
        defaults.data(forKey: cacheKey).flatMap { try? JSONDecoder().decode(CachedDraft.self, from: $0) }
    }

    private func clearCache() {
        if cachedDraft()?.owner == cacheOwner { defaults.removeObject(forKey: cacheKey) }
    }

    /// Runs a call to the runner, waiting out a runner that's restarting. It
    /// updates itself several times a day and is gone for a few seconds each
    /// time, which isn't worth an error or a second press of Send. Retrying
    /// is safe: an identical answer to a review already answered returns the
    /// original, and never sends twice.
    private func ridingOutRestart<T>(_ call: () async throws -> T) async throws -> T {
        let clock = ContinuousClock()
        let deadline = clock.now + reconnectWait
        while true {
            do {
                return try await call()
            } catch where Self.isRunnerAway(error) && clock.now < deadline {
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    private static func isRunnerAway(_ error: Error) -> Bool {
        switch error as? RPCError {
        case .disconnected, .connectFailed, .timeout: return true
        case .server(let code, _): return code == RPCError.busy
        default: return false
        }
    }

    private func scheduleSave() {
        guard autosave, !conflict else { return }
        timer?.cancel()
        timer = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            await self?.saveNow()
        }
    }

    func saveNow() async {
        guard dirty, review.isPending, !saving, !submitting, !conflict else { return }
        saving = true
        let sent = draft
        let attemptedRevision = review.revision
        do {
            let saved = try await ridingOutRestart { try await service.save(attemptedRevision, sent) }
            if saved.revision >= review.revision { review = saved }
            dirty = normalized(draft) != (review.response ?? review.draft)
            if saved.revision < review.revision && dirty {
                conflict = true
                error = "This review changed elsewhere. Your unsent notes are kept here."
            } else { error = nil }
            if dirty { cacheDraft() } else { clearCache() }
        } catch {
            self.error = "Couldn’t save the draft. Your notes are kept on this Mac. \(error.localizedDescription)"
            saving = false
            if let latest = try? await service.load() {
                receive(latest)
                if latest.revision > attemptedRevision, latest.draft != normalized(sent), latest.draft != normalized(draft) {
                    conflict = true
                    self.error = "This review changed elsewhere. Your unsent notes are kept here."
                    cacheDraft()
                }
            }
        }
        saving = false
        // A newer keystroke may have arrived while the request was in flight.
        if dirty && error == nil { scheduleSave() }
    }

    func receive(_ latest: DesignReview) {
        guard latest.id == review.id, latest.revision >= review.revision else { return }
        let advanced = latest.revision > review.revision
        review = latest
        if !dirty {
            draft = latest.response ?? latest.draft
        } else if advanced && !saving && !submitting {
            conflict = true
            error = latest.isPending
                ? "This review changed elsewhere. Your unsent notes are kept here."
                : "This review was closed elsewhere. Your unsent notes are still shown below."
            cacheDraft()
        }
    }

    func refresh() async {
        do { receive(try await service.load()) }
        catch where Self.isRunnerAway(error) {
            // It polls again in a few seconds; nothing here needs saying.
        } catch { self.error = "Couldn’t load the review. \(error.localizedDescription)" }
    }

    func keepMyDraft() async {
        guard review.isPending else { return }
        conflict = false
        error = nil
        dirty = true
        await saveNow()
    }

    func submit() async {
        guard canSubmit else { return }
        timer?.cancel()
        submitting = true
        // A debounce save already in flight owns the current revision.
        while saving { try? await Task.sleep(for: .milliseconds(10)) }
        defer { submitting = false }
        guard review.isPending, !conflict else { return }
        let submittedRevision = review.revision
        do {
            let sent = draft
            let answered = try await ridingOutRestart { try await service.respond(submittedRevision, sent) }
            review = answered
            draft = answered.response ?? answered.draft
            dirty = false
            conflict = false
            error = nil
            clearCache()
        } catch {
            self.error = "Couldn’t send the reply. Your notes are kept here. \(error.localizedDescription)"
            if let latest = try? await service.load() {
                // An acknowledgement can be lost after the runner committed
                // the reply. Its answered snapshot is the authority.
                if latest.status == "answered", latest.response == normalized(draft) {
                    review = latest
                    dirty = false
                    clearCache()
                    self.error = nil
                } else {
                    submitting = false
                    receive(latest)
                    if latest.isPending, latest.revision > submittedRevision, normalized(draft) != latest.draft {
                        conflict = true
                        self.error = "This review changed elsewhere. Your unsent notes are kept here."
                        cacheDraft()
                    }
                }
            }
        }
    }

    func cancelReview() async {
        guard editable else { return }
        timer?.cancel()
        submitting = true
        while saving { try? await Task.sleep(for: .milliseconds(10)) }
        defer { submitting = false }
        do {
            review = try await service.cancel(review.revision)
            dirty = false
            clearCache()
            error = nil
        } catch { self.error = "Couldn’t cancel the review. \(error.localizedDescription)" }
    }

    func enlarge(_ index: Int, shot: Int = 0) {
        guard review.options.indices.contains(index) else { return }
        focused = index
        self.shot = max(0, min(shot, review.options[index].allShots.count - 1))
        mode = .single
        peeking = false
    }

    func zoom(_ step: ReviewZoomStep) {
        zoomRequest = ReviewZoomRequest(serial: (zoomRequest?.serial ?? 0) + 1, step: step)
    }

    /// Zoom only means anything on an enlarged image, so it doesn't outlive one.
    func showAll() {
        mode = .all
        zoomed = false
        peeking = false
    }

    /// The left and right arrows and the stage's back and next: every shot
    /// of every option in order, then all of them to choose from. It stops
    /// at either end rather than wrapping, so the walkthrough has a start
    /// and an end. From all of them, back goes to the last shot and 0
    /// (Return) to the one last looked at.
    func browse(_ direction: Int) {
        let count = review.options.count
        guard count > 0 else { return }
        if mode == .all {
            if direction < 0 { enlarge(count - 1, shot: review.options[count - 1].allShots.count - 1) }
            else if direction == 0 { enlarge(min(focused, count - 1), shot: shot) }
            return
        }
        let shots = review.options[focused].allShots.count
        if direction > 0 {
            if shot + 1 < shots { enlarge(focused, shot: shot + 1) }
            else if focused + 1 < count { enlarge(focused + 1) }
            else { showAll() }
        } else if direction < 0 {
            if shot > 0 { enlarge(focused, shot: shot - 1) }
            else if focused > 0 { enlarge(focused - 1, shot: review.options[focused - 1].allShots.count - 1) }
        }
    }

    /// The up and down arrows: straight to the previous or next option's
    /// first shot, past the shots in between; down from the last is all of them.
    func jump(_ direction: Int) {
        let count = review.options.count
        guard count > 0 else { return }
        if mode == .all {
            if direction < 0 { enlarge(count - 1) }
            return
        }
        let next = focused + direction
        if next >= count { showAll() } else if next >= 0 { enlarge(next) } else { enlarge(0) }
    }

    var canStepBack: Bool { mode == .all ? !review.options.isEmpty : focused > 0 || shot > 0 }
    var canStepForward: Bool { mode == .single }
    /// The next step is all of them, where the pick happens.
    var nextIsAll: Bool {
        mode == .single && focused == review.options.count - 1 && shot >= (focusedOption?.allShots.count ?? 1) - 1
    }

    /// The runner trims notes and drops blanks. A saved space at the end
    /// must not keep a draft dirty and trigger another save every 500 ms.
    private func normalized(_ draft: ReviewDraft) -> ReviewDraft {
        let reply = (draft.reply ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return ReviewDraft(pickedIds: draft.pickedIds, notes: draft.notes.compactMapValues {
            let note = $0.trimmingCharacters(in: .whitespacesAndNewlines)
            return note.isEmpty ? nil : note
        }, reply: reply.isEmpty ? nil : reply, images: draft.images, none: draft.none)
    }
}

enum ReviewMode: String, CaseIterable {
    case all = "All", single = "Single"
}
