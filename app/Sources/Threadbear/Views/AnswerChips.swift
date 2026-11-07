import SwiftUI
import ThreadbearCore

/// The answers Mike picked on the open card of asks (in the transcript,
/// under the agent's message), waiting over the composer to go with his
/// next message: the ask's number and the answer, × to unpick it. A
/// Something else answer is written in its own box on the card; its chip
/// shows the start of it (docs/protocol.md, "Needs you", Answering).
struct AnswerChips: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    let picks: [Int: Int]

    var body: some View {
        // "Something else" shows as a chip too, before he's written it.
        let notes = app.notes(for: thread)
        let answers = thread.asks.indices.compactMap { index -> (index: Int, answer: AskAnswer)? in
            guard let pick = picks[index] else { return nil }
            let ask = thread.asks[index]
            if pick == Decisions.ownAnswer {
                let note = notes[index] ?? AskNote()
                let text = note.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let shown = !text.isEmpty ? text : note.images.isEmpty ? "Your answer above" : note.images.count == 1 ? "1 picture" : "\(note.images.count) pictures"
                return (index, AskAnswer(action: ask.action, answer: shown))
            }
            let options = Decisions.choices(for: ask)
            return options.indices.contains(pick) ? (index, AskAnswer(action: ask.action, answer: options[pick])) : nil
        }
        // In a row that scrolls, like the action chips.
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: zoomed(6)) {
                ForEach(answers, id: \.index) { index, answer in
                    chip(index: index, answer: answer)
                }
            }
        }
    }

    private func chip(index: Int, answer: AskAnswer) -> some View {
        HStack(spacing: zoomed(6)) {
            if thread.asks.count > 1 {
                Text("\(index + 1)").foregroundStyle(.secondary).monospacedDigit()
            }
            if picks[index] == Decisions.ownAnswer {
                Image(systemName: "pencil").font(.system(size: zoomed(10), weight: .medium)).foregroundStyle(.secondary)
            }
            Text(answer.answer).foregroundStyle(.primary).lineLimit(1)
            Button {
                if let option = picks[index] { app.pickAnswer(thread: thread, ask: index, option: option) }
            } label: {
                Image(systemName: "xmark").font(.system(size: zoomed(9), weight: .semibold)).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .tip("Take this answer back")
        }
        .font(.system(size: TypeScale.chip))
        .padding(.horizontal, zoomed(9))
        .padding(.vertical, zoomed(4))
        .background(Capsule().fill(Theme.accentColor.opacity(0.14)))
        .overlay(Capsule().strokeBorder(Theme.accentColor.opacity(0.45), lineWidth: 0.5))
        .tip(PreviewText.plain(answer.action))
    }
}
