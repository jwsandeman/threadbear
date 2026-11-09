import SwiftUI
import ThreadbearCore

/// The Move sheet (docs/move-plan.md): where a thread will run on the
/// other runner and on which login, both filled in with that runner's own
/// guess (threads.movePreview), a line for what won't come, then Move.
/// Changing the folder or login asks the other runner again, so what it
/// says can't be done shows before the thread freezes.
struct MoveSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let request: AppModel.MoveRequest

    @State private var preview: MovePreview?
    @State private var asking = false
    @State private var folder = ""
    @State private var login = ""
    /// What the runner guessed, so only Mike's own changes are sent.
    @State private var guessedFolder = ""
    @State private var guessedLogin = ""

    private var thread: ThreadSummary? { app.threads[request.threadId] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Move \u{201C}\(title)\u{201D} to \(request.runnerName)")
                    .font(.headline)
                    .lineLimit(2)
                Text(subtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 8) {
                GridRow {
                    Text("Folder").foregroundStyle(.secondary).gridColumnAlignment(.trailing)
                    TextField("Folder on \(request.runnerName)", text: $folder)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                        .onSubmit { ask() }
                        .tip(preview?.worktree == true
                             ? "The repo on \(request.runnerName) it gets a new worktree of its own in. Press Return to check another folder."
                             : "Where it runs on \(request.runnerName). Press Return to check another folder.")
                }
                GridRow {
                    Text("Login").foregroundStyle(.secondary)
                    Picker("Login", selection: $login) {
                        ForEach(preview?.accounts ?? []) { account in
                            Text(account.email.map { "\(account.title) (\($0))" } ?? account.title).tag(account.id)
                        }
                    }
                    .labelsHidden()
                    .disabled((preview?.accounts ?? []).isEmpty)
                    .onChange(of: login) { old, new in if !old.isEmpty, new != guessedLogin { ask() } }
                    .tip("The login on \(request.runnerName) it carries on with")
                }
            }
            lines
            HStack {
                if asking {
                    ProgressView().controlSize(.small)
                    Text("Asking \(request.runnerName)…").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .tip("Close without moving it")
                Button("Move") { move() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canMove)
                    .tip(canMove ? "Move it to \(request.runnerName) once this turn ends" : "Fix what's in the way first")
            }
        }
        .padding(20)
        .frame(width: 460)
        .task { await load(cwd: nil, accountId: nil, first: true) }
    }

    @ViewBuilder
    private var lines: some View {
        if let preview {
            ForEach(Array(preview.problems.enumerated()), id: \.offset) { _, line in
                Label(line, systemImage: "xmark.octagon")
                    .font(.callout)
                    .foregroundStyle(Color(nsColor: Theme.failed))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let clone = preview.clone {
                Text("\(request.runnerName) has no copy of its repo, so it's cloned to \(clone) first.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(preview.leftBehind.enumerated()), id: \.offset) { _, line in
                Text("Won't come: \(line)")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var title: String {
        let t = thread?.title ?? ""
        return t.isEmpty ? "Untitled" : t
    }

    private var subtitle: String {
        if thread?.status.isBusy == true { return "It goes once this turn ends. Messages sent meanwhile go with it." }
        return "Its whole conversation and its git work go with it, and it carries on there."
    }

    private var canMove: Bool {
        guard let preview, !asking else { return false }
        return preview.problems.isEmpty && !folder.isEmpty && !login.isEmpty
    }

    /// Asks again for Mike's folder and login.
    private func ask() {
        let cwd = folder == guessedFolder ? nil : folder
        let accountId = login == guessedLogin ? nil : login
        Task { await load(cwd: cwd, accountId: accountId, first: false) }
    }

    private func load(cwd: String?, accountId: String?, first: Bool) async {
        asking = true
        defer { asking = false }
        let answer = await app.movePreview(request, cwd: cwd, accountId: accountId)
        preview = answer
        if first {
            guessedFolder = answer.cwd ?? ""
            guessedLogin = answer.accountId ?? ""
            folder = guessedFolder
            login = guessedLogin
        } else if cwd == nil, let guess = answer.cwd {
            folder = guess
        }
    }

    private func move() {
        let cwd = folder == guessedFolder ? nil : folder
        let accountId = login == guessedLogin ? nil : login
        app.startMove(request, cwd: cwd, accountId: accountId)
        dismiss()
    }
}
