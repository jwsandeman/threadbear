import SwiftUI

/// Drawn over the dock while a panel is moving: where it would land, the
/// compass in the middle of a group, and the panel itself under the pointer.
struct DragOverlay: View {
    @Environment(DockController.self) private var controller

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            if let target = controller.drag?.target, target.drop != nil {
                DropPreview(rect: target.preview, isTab: Self.isTab(target.drop), inBar: target.inBar, panel: controller.drag?.panel)
                    .transition(.opacity)
            }
            if let ghost = ghost {
                Ghost(panel: ghost.panel, sourceSize: ghost.sourceSize, rect: ghost.rect, lifted: ghost.lifted)
                    .id(ghost.panel)
                    // See-through over the compass, so its choices stay
                    // readable, and gone while it would open as a window:
                    // the window's outline shows where instead.
                    .opacity(controller.drag?.target?.compass != nil ? 0.45 : controller.drag?.target?.float != nil ? 0 : 1)
                    .transition(.opacity)
            }
            // Over the ghost: the pointer is on it, so the ghost would hide it.
            if let compass = controller.drag?.target?.compass {
                CompassView(state: compass)
                    .transition(.scale(scale: 0.85).combined(with: .opacity))
                    .id(compass.group)
            }
        }
    }

    private var ghost: (panel: PanelID, sourceSize: CGSize, rect: CGRect, lifted: Bool)? {
        if let d = controller.drag {
            // A window's panel: the window itself is what's moving.
            if d.window != nil { return nil }
            return (d.panel, d.sourceFrame.size, controller.ghostRect(for: d), d.lifted)
        }
        if let l = controller.landing {
            return (l.panel, l.sourceSize, l.to, false)
        }
        return nil
    }

    static func isTab(_ drop: DockDrop?) -> Bool {
        if case .tab = drop { return true }
        return false
    }
}

/// The accent-tinted space the panel would take.
private struct DropPreview: View {
    let rect: CGRect
    let isTab: Bool
    /// The new tab itself, in a bar, with the dragged panel's name in it.
    var inBar = false
    var panel: PanelID?
    @Environment(\.dockContent) private var content
    @Environment(\.dockOptions) private var options

    var body: some View {
        if inBar {
            HStack(spacing: 6) {
                if let panel, let symbol = content.symbol(panel) {
                    Image(systemName: symbol).font(.system(size: options.titleSize - 1, weight: .medium))
                }
                if let panel {
                    Text(content.title(panel)).font(.system(size: options.titleSize, weight: .semibold)).lineLimit(1)
                }
            }
            .foregroundStyle(DockTheme.headerText)
            .padding(.horizontal, 8)
            .frame(width: max(rect.width, 0), height: max(rect.height, 0))
            .background(RoundedRectangle(cornerRadius: 6).fill(DockTheme.accent.opacity(0.22)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(DockTheme.accent.opacity(0.85), lineWidth: 1.5))
                .offset(x: rect.minX, y: rect.minY)
        } else {
            area
        }
    }

    private var area: some View {
        let r = rect.insetBy(dx: 4, dy: 4)
        return ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 8)
                .fill(DockTheme.accent.opacity(0.14))
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(DockTheme.accent.opacity(0.75), lineWidth: 1.5)
            if isTab {
                // A tab-shaped nub, so "join as a tab" reads differently from "replace".
                RoundedRectangle(cornerRadius: 5)
                    .fill(DockTheme.accent.opacity(0.55))
                    .frame(width: min(90, r.width * 0.4), height: 18)
                    .offset(x: 8, y: 6)
            }
        }
        .frame(width: max(r.width, 0), height: max(r.height, 0))
        .offset(x: r.minX, y: r.minY)
    }
}

/// The cross of choices that appears in the middle of a group: dock to a
/// side of it, join it as a tab, or swap places.
private struct CompassView: View {
    let state: CompassState

    var body: some View {
        let items = DockController.compassItems(center: state.center)
        let area = items.reduce(CGRect.null) { $0.union($1.1) }
        let caption = (state.hovered ?? .tab).label
        let plate = area.insetBy(dx: -10, dy: -10).union(CGRect(x: area.midX - 70, y: area.maxY + 4, width: 140, height: 26))

        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 14)
                .fill(.regularMaterial)
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.primary.opacity(0.1)))
                .shadow(color: .black.opacity(0.45), radius: 18, y: 8)
                .frame(width: plate.width, height: plate.height)
                .offset(x: plate.minX, y: plate.minY)
            ForEach(items, id: \.0) { item, rect in
                CompassButton(item: item, hovered: state.hovered == item || (state.hovered == nil && item == .tab), disabled: state.disabled.contains(item))
                    .frame(width: rect.width, height: rect.height)
                    .offset(x: rect.minX, y: rect.minY)
            }
            Text(caption)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(DockTheme.secondary)
                .frame(width: 140)
                .offset(x: area.midX - 70, y: area.maxY + 10)
                .contentTransition(.opacity)
        }
    }
}

private struct CompassButton: View {
    let item: CompassItem
    let hovered: Bool
    let disabled: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(hovered && !disabled ? DockTheme.accent.opacity(0.9) : Color.primary.opacity(0.07))
            glyph
                .foregroundStyle(hovered && !disabled ? Color.white : DockTheme.secondary)
        }
        .opacity(disabled ? 0.3 : 1)
        .scaleEffect(hovered && !disabled ? 1.08 : 1)
        .animation(.snappy(duration: 0.14), value: hovered)
    }

    @ViewBuilder private var glyph: some View {
        switch item {
        case .swap:
            Label("Swap", systemImage: "arrow.left.arrow.right")
                .font(.system(size: 11, weight: .semibold))
                .labelStyle(.titleAndIcon)
        case .window:
            Label("Window", systemImage: "macwindow.badge.plus")
                .font(.system(size: 11, weight: .semibold))
                .labelStyle(.titleAndIcon)
        case .tab:
            // A little window with a tab on top.
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 2.5).strokeBorder(lineWidth: 1.4).frame(width: 18, height: 14).offset(y: 4)
                RoundedRectangle(cornerRadius: 1.5).frame(width: 8, height: 5).offset(x: 1)
            }
            .frame(width: 18, height: 18)
        case .split(let edge):
            // A little window with the half it would take filled in.
            ZStack {
                RoundedRectangle(cornerRadius: 2.5).strokeBorder(lineWidth: 1.4)
                GeometryReader { g in
                    let r = DockController.slice(CGRect(origin: .zero, size: g.size), edge, 0.5).insetBy(dx: 2.5, dy: 2.5)
                    RoundedRectangle(cornerRadius: 1).frame(width: r.width, height: r.height).offset(x: r.minX, y: r.minY)
                }
            }
            .frame(width: 18, height: 16)
        }
    }
}

/// The panel itself, picked up: drawn at its real size and scaled, so it
/// shrinks rather than reflowing, with the grab point kept under the pointer.
private struct Ghost: View {
    let panel: PanelID
    let sourceSize: CGSize
    let rect: CGRect
    let lifted: Bool
    @Environment(\.dockContent) private var content
    @Environment(\.dockOptions) private var options

    var body: some View {
        let sx = rect.width / max(sourceSize.width, 1), sy = rect.height / max(sourceSize.height, 1)
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                if let symbol = content.symbol(panel) {
                    Image(systemName: symbol).font(.system(size: 11, weight: .medium)).foregroundStyle(DockTheme.secondary)
                }
                Text(content.title(panel)).font(.system(size: 12, weight: .semibold)).foregroundStyle(DockTheme.headerText)
                Spacer()
            }
            .padding(.horizontal, 14)
            .frame(height: options.headerHeight)
            .background(options.headerBackground ?? options.panelBackground)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.primary.opacity(0.07)).frame(height: 1) }
            content.view(panel)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
                .environment(\.isDockGhost, true)
        }
        .frame(width: sourceSize.width, height: sourceSize.height)
        .background(options.panelBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10 / max(min(sx, sy), 0.2)))
        .overlay(RoundedRectangle(cornerRadius: 10 / max(min(sx, sy), 0.2)).strokeBorder(Color.primary.opacity(0.14), lineWidth: 1 / max(min(sx, sy), 0.2)))
        .scaleEffect(x: sx, y: sy, anchor: .topLeading)
        .frame(width: rect.width, height: rect.height, alignment: .topLeading)
        .shadow(color: .black.opacity(lifted ? 0.5 : 0), radius: lifted ? 24 : 0, y: lifted ? 12 : 0)
        .rotationEffect(.degrees(lifted ? -1.2 : 0))
        .offset(x: rect.minX, y: rect.minY)
    }
}
