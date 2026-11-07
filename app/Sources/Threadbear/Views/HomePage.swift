import AppKit
import SwiftUI
import ThreadbearCore

/// The page a view in the activity bar opens in the detail area (the
/// Librarian's, Scheduled's): a picture of the bear at the job, a few
/// lines on what the view is for, its numbers in tiles, and anything else
/// under them (the Librarian's settings).
struct HomePage<About: View, Below: View>: View {
    let picture: NSImage?
    let pictureLabel: String
    let stats: [HomeStat]
    @ViewBuilder let about: () -> About
    @ViewBuilder var below: () -> Below

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: zoomed(32)) {
                VStack(alignment: .leading, spacing: zoomed(20)) {
                    // Nothing when the picture didn't ship (a build that left
                    // the resource bundle out), rather than a gap.
                    if let picture {
                        Image(nsImage: picture)
                            .resizable()
                            .interpolation(.high)
                            .aspectRatio(contentMode: .fit)
                            // Capped in height too, so a tall picture (the
                            // alarm clock) is no bigger than a wide one.
                            .frame(maxWidth: zoomed(280), maxHeight: zoomed(260), alignment: .leading)
                            .accessibilityLabel(pictureLabel)
                    }
                    about()
                        .frame(maxWidth: zoomed(620), alignment: .leading)
                }
                if !stats.isEmpty {
                    // Three across at most, so six tiles make even rows.
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: zoomed(170)), spacing: zoomed(14), alignment: .top)],
                        alignment: .leading,
                        spacing: zoomed(14)
                    ) {
                        ForEach(stats) { HomeStatTile(stat: $0) }
                    }
                    .frame(maxWidth: zoomed(620), alignment: .leading)
                }
                below()
                    .frame(maxWidth: zoomed(620), alignment: .leading)
            }
            .frame(maxWidth: zoomed(1000), alignment: .leading)
            .padding(.horizontal, zoomed(32))
            .padding(.top, zoomed(28))
            .padding(.bottom, zoomed(48))
            .frame(maxWidth: .infinity)
        }
    }
}

extension HomePage where Below == EmptyView {
    init(picture: NSImage?, pictureLabel: String, stats: [HomeStat], @ViewBuilder about: @escaping () -> About) {
        self.init(picture: picture, pictureLabel: pictureLabel, stats: stats, about: about) { EmptyView() }
    }
}

/// A page's title, with more behind the ⓘ, and the line under it.
struct HomeTitle: View {
    let title: String
    let line: String
    let more: String

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(12)) {
            HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
                Text(title)
                    .font(.system(size: zoomed(24), weight: .semibold))
                InfoTip(more)
            }
            Text(line)
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// What it's doing now, under a page's title: a dot, accent while busy.
struct HomeStatusLine: View {
    let text: String
    let busy: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
            Circle()
                .fill(busy ? Color(nsColor: Theme.running) : Color(nsColor: Theme.faintText))
                .frame(width: zoomed(7), height: zoomed(7))
            Text(text)
                .font(.system(size: TypeScale.label))
                .lineLimit(1)
        }
        .padding(.top, zoomed(4))
    }
}

/// One number on a page, what it counts, and more in its tooltip.
struct HomeStat: Identifiable, Equatable {
    var id: String { label }
    let value: String
    let label: String
    let help: String
}

private struct HomeStatTile: View {
    let stat: HomeStat

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(4)) {
            Text(stat.value)
                .font(.system(size: zoomed(22), weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
            Text(stat.label)
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, zoomed(14))
        .padding(.vertical, zoomed(12))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: zoomed(10), style: .continuous))
        .tip(stat.help)
        .accessibilityElement(children: .combine)
    }
}

/// Pictures that ship in the app's resource bundle (Package.swift,
/// Resources/Art). Found by hand rather than through Bundle.module, which
/// stops the app when the bundle isn't there (CodeHighlighter does the
/// same): build-app.sh copies it into Contents/Resources, and `swift run`
/// and `swift test` have it beside the binary.
enum Art {
    @MainActor static let librarian: NSImage? = image("librarian")
    @MainActor static let scheduled: NSImage? = image("scheduled")

    private static let bundle: Bundle? = {
        let name = "Threadbear_Threadbear.bundle"
        return [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent()]
            .compactMap { $0?.appendingPathComponent(name) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
            .flatMap(Bundle.init(url:))
    }()

    private static func image(_ name: String) -> NSImage? {
        guard let url = bundle?.url(forResource: name, withExtension: "png", subdirectory: "Art") else { return nil }
        return NSImage(contentsOf: url)
    }
}
