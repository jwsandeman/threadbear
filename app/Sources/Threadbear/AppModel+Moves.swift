import Foundation
import ThreadbearCore

/// Moving a thread to another runner (docs/protocol.md, "Moving a thread to
/// another runner"; the `moveToRunner` experiment). Every move is asked of
/// this Mac's own runner, which holds the owner key, wherever the thread is.
extension AppModel {
    /// What the Move sheet is for: which thread, to which runner.
    struct MoveRequest: Identifiable, Equatable {
        var threadId: String
        var runnerId: String
        var runnerName: String
        var id: String { threadId + ">" + runnerId }
    }

    /// The menu shows: the experiment's on here and there's somewhere to go.
    var canMoveThreads: Bool { experiments.contains("moveToRunner") && client != nil }

    /// Where a thread could go: every runner but the one it's on, in Mike's
    /// order, offline ones included so the menu can grey them.
    func moveTargets(for thread: ThreadSummary) -> [RunnerInfo] {
        let selfId = runners.first(where: \.isSelf)?.id
        let here = thread.runnerId ?? selfId
        return orderedRunners.filter { $0.id != here }
    }

    /// Opens the Move sheet. It asks the target for its guess itself.
    func openMove(_ threadId: String, to runner: RunnerInfo) {
        moveRequest = MoveRequest(threadId: threadId, runnerId: runner.id, runnerName: runner.name)
    }

    /// The sheet's guess, or what's in the way. Read-only: nothing starts.
    func movePreview(_ request: MoveRequest, cwd: String? = nil, accountId: String? = nil) async -> MovePreview {
        guard let client else { return MovePreview(problems: ["This Mac's runner isn't connected."]) }
        do {
            return try await client.movePreview(threadId: request.threadId, runnerId: request.runnerId, cwd: cwd, accountId: accountId)
        } catch {
            return MovePreview(problems: [error.localizedDescription])
        }
    }

    /// Move pressed: the row says "Moving to …" at once, and goes back with
    /// the error if the runner turns it down.
    func startMove(_ request: MoveRequest, cwd: String?, accountId: String?) {
        guard let client else { return }
        let threadId = request.threadId
        let before = threads[threadId]
        if var guess = before {
            guess.moving = ThreadMoving(moveId: "", to: request.runnerId, toName: request.runnerName, state: "asking")
            threads[threadId] = guess
        }
        whileBusy(BusyKey.moveThread(threadId)) { [self] in
            do {
                try await client.moveThread(threadId: threadId, runnerId: request.runnerId, cwd: cwd, accountId: accountId)
            } catch {
                if var now = threads[threadId], now.moving?.moveId == "" {
                    now.moving = before?.moving
                    threads[threadId] = now
                }
                show(error)
            }
        }
    }

    /// Cancel on a moving row, before the thread has gone.
    func cancelMove(_ threadId: String) {
        guard let client else { return }
        whileBusy(BusyKey.moveThread(threadId), note: "Cancelling the move…") { [self] in
            do {
                try await client.cancelMove(threadId: threadId)
            } catch { show(error) }
        }
    }

    /// The thread's old runner let it go during a move. It's on its way to
    /// the other runner, which lists it in a moment: keep its row, its
    /// place and the selection, as that runner's from now on, and let its
    /// transcript open again from there. Any state short of failing counts,
    /// as a move between two other runners only ever shows as starting
    /// here. False when it isn't a move, and the thread should go.
    func movedAway(_ threadId: String) -> Bool {
        guard var thread = threads[threadId], let moving = thread.moving, !moving.ended else { return false }
        let selfId = runners.first(where: \.isSelf)?.id
        thread.runnerId = moving.to == selfId ? nil : moving.to
        thread.moving = nil
        if thread.runnerId != nil { madeRemote.insert(threadId) }
        liveRemote.remove(threadId)
        if let session = sessions.removeValue(forKey: threadId) { session.unsubscribe() }
        threads[threadId] = thread
        return true
    }
}
