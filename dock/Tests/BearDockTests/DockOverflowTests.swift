import AppKit
import SwiftUI
import Testing
@testable import BearDock

@MainActor private final class ToolbarBounds {
    var frame: CGRect?
}

/// A narrow group must fit its tabs and toolbar without displacing the
/// app's icon rail. Testing the rendered dock catches overflow that the
/// layout's saved fractions alone cannot show.
@MainActor @Test func narrowTabbedPanelsLeaveTheOuterRailVisible() throws {
    _ = NSApplication.shared
    let three = ["Highlights", "Patches", "Files"]
    let six = three + ["Previews", "Worktrees", "Build Results"]
    let cases: [(CGFloat, [String])] = [(325, three), (240, three), (600, three), (325, six), (240, six)]
    for (groupWidth, tabs) in cases {
        let railWidth: CGFloat = 44
        let dockWidth = groupWidth / 0.24 + 1
        let size = CGSize(width: dockWidth + railWidth, height: 400)
        let controller = DockController(layout: DockLayout(root: .split(DockSplit(
            id: "root", axis: .horizontal, children: [
                .group(DockGroup(id: "main", panels: ["Conversation"])),
                .group(DockGroup(id: "right", panels: tabs, selected: "Files")),
            ], fractions: [0.76, 0.24]
        ))))
        var options = DockOptions()
        options.panelBackground = .black
        options.headerBackground = .black
        let toolbar = ToolbarBounds()
        let content = DockContent(
            title: { $0 },
            symbol: { _ in "folder" },
            accessory: { panel in
                panel == "Files" ? AnyView(Color.white.frame(width: 96, height: 20)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(DockSpace.name)) }
                    action: { toolbar.frame = $0 }) : nil
            },
            view: { _ in AnyView(Color.black) }
        )
        let host = NSHostingView(rootView: HStack(spacing: 0) {
            DockView(controller: controller, options: options, content: content)
            Color(nsColor: .magenta).frame(width: railWidth)
        })
        host.sizingOptions = []
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = host
        host.frame = CGRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        host.layoutSubtreeIfNeeded()

        let group = try #require(controller.frames["right"])
        #expect(abs(group.width - groupWidth) < 1, "group exceeds its allotted width: \(group)")
        #expect(group.maxX <= dockWidth + 1, "group must stop before the outer rail")
        let buttons = try #require(toolbar.frame)
        #expect(buttons.width >= 95, "the toolbar must stay visible, not be squeezed away")
        #expect(buttons.minX >= group.minX - 1 && buttons.maxX <= group.maxX + 1,
                "the toolbar must remain inside the narrow group: \(buttons), group \(group)")
        let image = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: image)
        let scale = CGFloat(image.pixelsWide) / host.bounds.width
        let x = Int((size.width - railWidth / 2) * scale)
        let y = Int(size.height / 2 * scale)
        let sampled = image.colorAt(x: x, y: y)?.usingColorSpace(.sRGB)
        let rail = try #require(sampled)
        #expect(rail.redComponent > 0.9 && rail.blueComponent > 0.9 && rail.greenComponent < 0.4,
                "the panel covered the outer rail at group width \(groupWidth): \(rail)")
    }
}
