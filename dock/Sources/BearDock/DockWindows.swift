import AppKit
import SwiftUI

/// A panel's window of its own, so the app can tell it from its main window.
public final class DockPanelWindow: NSWindow {
    public internal(set) var panel: PanelID = ""
}

/// The windows of panels taken out of the dock, kept in step with the
/// layout's `floating`, and the outline shown while a drag would make one.
@MainActor
final class DockWindows: NSObject, NSWindowDelegate {
    private unowned let controller: DockController
    private var windows: [PanelID: DockPanelWindow] = [:]
    private var outline: NSPanel?
    /// What the dock view draws panels with; set by it before the first sync.
    var content: DockContent?
    var options = DockOptions()
    /// The panel whose window just opened from a drag or the menu: brought
    /// to the front and made key, where windows restored at launch aren't.
    var focusNext: PanelID?

    init(controller: DockController) {
        self.controller = controller
    }

    func window(for panel: PanelID) -> DockPanelWindow? { windows[panel] }

    /// Opens a window for each floating panel without one, closes those
    /// whose panel went back into the dock or was closed, and moves any the
    /// layout says are somewhere else. A panel with nothing to show right
    /// now (a thread's patch panel while another thread is on show) keeps
    /// its window, hidden, until it has something again.
    func sync() {
        guard let content else { return }
        let floating = controller.layout.floating
        for (panel, window) in windows where !floating.contains(where: { $0.panel == panel }) {
            window.delegate = nil
            window.orderOut(nil)
            window.close()
            windows[panel] = nil
        }
        for f in floating {
            let shows = content.available(f.panel)
            if let window = windows[f.panel] {
                if window.frame != f.frame, controller.drag?.panel != f.panel { window.setFrame(f.frame, display: true) }
                window.title = content.title(f.panel)
                if !shows, window.isVisible {
                    window.orderOut(nil)
                } else if shows, !window.isVisible, !window.isMiniaturized {
                    window.orderFront(nil)
                }
                continue
            }
            let window = makeWindow(f, content: content)
            windows[f.panel] = window
            if !shows {
                // Made now, so it's there in its place when the panel is back.
                focusNext = focusNext == f.panel ? nil : focusNext
            } else if focusNext == f.panel {
                window.makeKeyAndOrderFront(nil)
                focusNext = nil
            } else {
                window.orderFront(nil)
            }
        }
    }

    private func makeWindow(_ f: DockFloat, content: DockContent) -> DockPanelWindow {
        let window = DockPanelWindow(
            contentRect: f.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.panel = f.panel
        window.isReleasedWhenClosed = false
        // The panel's own bar is the top of the window, as in the main one.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = content.title(f.panel)
        window.minSize = CGSize(width: 240, height: 160)
        window.animationBehavior = .documentWindow
        // Only the strip beside the traffic lights moves it (WindowGrip).
        window.isMovable = false
        var options = options
        // Room for the traffic lights, and the strip beside them moves the
        // window natively; the rest of the bar drags it with the dock's
        // targets showing, to put it back.
        options.trafficLights = 78
        options.cornerMovesWindow = true
        let root = FloatingPanelView(panel: f.panel)
            .environment(controller)
            .environment(\.dockContent, content)
            .environment(\.dockOptions, options)
        let host = NSHostingView(rootView: options.windowContent(AnyView(root)))
        // The window's size is Mike's, not the content's.
        host.sizingOptions = []
        window.contentView = host
        window.setFrame(Self.onScreen(f.frame), display: false)
        window.delegate = self
        options.prepareWindow(window)
        return window
    }

    /// A frame saved on a display that's since gone comes back on the main one.
    static func onScreen(_ frame: CGRect) -> CGRect {
        if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) }) { return frame }
        guard let screen = NSScreen.main?.visibleFrame else { return frame }
        return CGRect(x: screen.midX - frame.width / 2, y: screen.midY - frame.height / 2, width: frame.width, height: frame.height)
    }

    // MARK: The outline of a window about to open

    func showOutline(panel: PanelID, frame: CGRect?) {
        guard let frame, let content else {
            outline?.orderOut(nil)
            return
        }
        let panelWindow = outline ?? makeOutline()
        outline = panelWindow
        let outlineView = WindowOutline(title: content.title(panel), symbol: content.symbol(panel), headerHeight: options.headerHeight)
        panelWindow.contentView = NSHostingView(rootView: options.windowContent(AnyView(outlineView)))
        panelWindow.setFrame(frame, display: true)
        panelWindow.orderFront(nil)
    }

    private func makeOutline() -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.level = .floating
        p.isReleasedWhenClosed = false
        return p
    }

    // MARK: NSWindowDelegate

    /// The red button: closes the panel, as its × would, or puts back one
    /// the app always keeps (Threadbear's thread). The sync closes the window.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let panel = (sender as? DockPanelWindow)?.panel else { return true }
        if content?.closable(panel) ?? true { controller.close(panel) } else { controller.putBack(panel) }
        return false
    }

    func windowDidMove(_ notification: Notification) { saveFrame(notification) }
    func windowDidEndLiveResize(_ notification: Notification) { saveFrame(notification) }

    private func saveFrame(_ notification: Notification) {
        // A drag by the title saves where it ends up when it's let go.
        guard let window = notification.object as? DockPanelWindow, controller.drag?.panel != window.panel,
              controller.layout.isFloating(window.panel) else { return }
        controller.layout.float(window.panel, frame: window.frame)
    }
}

/// A panel in a window of its own: its bar (title, buttons, menu) over it,
/// the bar dragging it back into the dock.
struct FloatingPanelView: View {
    let panel: PanelID
    @Environment(\.dockContent) private var content
    @Environment(\.dockOptions) private var options

    var body: some View {
        VStack(spacing: 0) {
            GroupHeader(group: DockGroup(id: "window:" + panel, panels: [panel]), leading: options.trafficLights, movesWindow: true)
            content.view(panel)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
                .contentShape(Rectangle())
                .contextMenu { PanelMenu(panel: panel, tabbed: false) }
        }
        .background(options.panelBackground)
        .ignoresSafeArea(.container, edges: .top)
        .coordinateSpace(.named(DockSpace.name))
    }
}

/// Where a panel would open as a window of its own, drawn while it's dragged
/// out of the dock: the window's outline with its bar, see-through.
private struct WindowOutline: View {
    let title: String
    let symbol: String?
    let headerHeight: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                if let symbol { Image(systemName: symbol).font(.system(size: 11, weight: .medium)) }
                Text(title).font(.system(size: 12, weight: .semibold))
                Spacer()
            }
            .foregroundStyle(DockTheme.accent)
            .padding(.leading, 78)
            .frame(height: headerHeight)
            .background(DockTheme.accent.opacity(0.14))
            Label("New window", systemImage: "macwindow.badge.plus")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(DockTheme.accent)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(DockTheme.accent.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(DockTheme.accent.opacity(0.75), lineWidth: 1.5))
    }
}

/// Fills the dock, so the controller can turn the dock's coordinates into
/// the screen's: flipped, like SwiftUI's.
/// With `locksWindow`, also keeps the window from moving except by the
/// strip beside the traffic lights (WindowGrip) or a bar's drag (HoldDrag).
struct DockAnchor: NSViewRepresentable {
    let controller: DockController
    var locksWindow = false

    func makeNSView(context: Context) -> NSView {
        let view = FlippedView()
        view.locksWindow = locksWindow
        controller.anchor = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        (view as? FlippedView)?.locksWindow = locksWindow
        controller.anchor = view
    }

    private final class FlippedView: NSView {
        var locksWindow = false {
            didSet { if locksWindow { window?.isMovable = false } }
        }
        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if locksWindow { window?.isMovable = false }
        }
    }
}
