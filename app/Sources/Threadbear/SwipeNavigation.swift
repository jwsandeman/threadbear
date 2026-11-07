import AppKit
import SwiftUI
import ThreadbearCore
import WebKit

/// Trackpad swipes going back and forward, as in Safari: two fingers (or a
/// Magic Mouse's one) across the main window, when System Settings has
/// "Swipe between pages" on for scrolling, and three-finger swipes when
/// it's set to three fingers, which AppKit sends as swipe events instead.
/// The mouse's side buttons are `MouseNavigation`.
///
/// The swipe itself is AppKit's own tracking (`trackSwipeEvent`), as
/// Safari's is: its distances, flick speed and spring at an end with
/// nowhere to go. What's ours is deciding, from the first few points of a
/// gesture, whether it's a page swipe or a scroll (`SwipeStart`).
///
/// A gesture that starts out sideways is held back from the view under the
/// pointer while that's decided, and handed on if it turns out to be a
/// scroll, as WebKit does. The first try (6 Nov) let the transcript start
/// scrolling while it decided, and called anything not clearly sideways a
/// scroll: Mike found a long thread's scrolling "takes over quite easily".
///
/// Over a sidebar row nothing's held back, as the row (RowSwipeController)
/// needs the whole gesture: a swipe left is its archive, and it gives up a
/// swipe right to Back while there's somewhere to go back to (`takesBack`).
@MainActor
@Observable
final class SwipeNavigation {
    static let shared = SwipeNavigation()

    enum Direction { case back, forward }

    /// How far along a swipe is, from -1 (Forward) to 1 (Back), for the
    /// arrow at the window's edge; nil with none under way.
    private(set) var amount: Double?
    @ObservationIgnored weak var app: AppModel?
    @ObservationIgnored private var monitor: Any?
    /// When AppKit's tracking last said how far along it was.
    @ObservationIgnored private var tracked = Date.distantPast
    @ObservationIgnored private var start = SwipeStart()
    /// The events held back while deciding, to hand on if it's a scroll.
    @ObservationIgnored private var held: [NSEvent] = []
    /// Decided (a scroll, or a swipe AppKit is tracking): the rest of the
    /// gesture is left alone until the next one starts.
    @ObservationIgnored private var settled = true
    /// System Settings' "Swipe between pages" with two fingers; a test's own.
    @ObservationIgnored var scrollSwipesOn: () -> Bool = { NSEvent.isSwipeTrackingFromScrollEventsEnabled }

    func install(app: AppModel) {
        guard monitor == nil else { return }
        self.app = app
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .swipe]) { [weak self] event in
            guard let self else { return event }
            return self.handle(event, in: event.window) ? nil : event
        }
    }

    /// Whether a swipe right goes Back just now: a row deciding what a
    /// swipe is asks, so the two never both take it.
    var takesBack: Bool {
        scrollSwipesOn() && (app?.canGoBack ?? false)
    }

    /// Whether the event was ours (held back, or a page swipe's).
    func handle(_ event: NSEvent, in window: NSWindow?) -> Bool {
        guard let app, let window, window === MainWindowFrame.window else { return false }
        if event.type == .swipe { return threeFingers(event, app: app) }
        // A mouse wheel has no phases, and Shift-scrolling one sideways
        // isn't a swipe. Momentum comes after the fingers lift.
        guard event.hasPreciseScrollingDeltas, event.momentumPhase.isEmpty, !event.phase.isEmpty else { return false }
        if event.phase.contains(.began) {
            // AppKit's tracking always finishes, but if it ever didn't say
            // so, swipes would stop for good: a quiet one is long over.
            if amount != nil, Date().timeIntervalSince(tracked) > 2 { amount = nil }
            release(in: window)
            settled = amount != nil || !scrollSwipesOn()
            // A row needs the whole gesture, so nothing's held back over
            // one, and it only ever lets a swipe right by.
            let overRow = RowSwipeController.listening != nil
            let ways = ways(at: event.locationInWindow, in: window, app: app)
            start.begin(allowed: overRow ? ways.intersection([.back]) : ways, hold: !overRow)
        }
        guard !settled else { return false }
        // The fingers' way, right positive, whichever way the system
        // scrolls: with natural scrolling the delta already goes with them.
        let sign: CGFloat = event.isDirectionInvertedFromDevice ? 1 : -1
        let ended = event.phase.contains(.ended) || event.phase.contains(.cancelled)
        switch start.move(dx: Double(event.scrollingDeltaX * sign), dy: Double(event.scrollingDeltaY), ended: ended) {
        case .wait:
            guard start.holds else { return false }
            held.append(event)
            return true
        case .scroll:
            settled = true
            release(in: window)
            return false
        case .swipe(let direction):
            settled = true
            held = []
            track(event, direction)
            return true
        }
    }

    /// Hands the held events on to the view under the pointer, in order,
    /// before the one that showed it's a scroll. Straight to the window, as
    /// the app (and so every monitor) has already had them.
    private func release(in window: NSWindow) {
        let events = held
        held = []
        for e in events { window.sendEvent(e) }
    }

    private func track(_ event: NSEvent, _ direction: Direction) {
        guard let app else { return }
        // A positive amount is Back: it follows the content the way the
        // system scrolls it (isDirectionInvertedFromDevice), as Safari's.
        let back = app.canGoBack, forward = app.canGoForward
        amount = 0
        tracked = Date()
        event.trackSwipeEvent(options: [.lockDirection, .clampGestureAmount],
                              dampenAmountThresholdMin: forward ? -1 : 0,
                              max: back ? 1 : 0) { [weak self] gestureAmount, _, isComplete, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.amount = Double(gestureAmount)
                self.tracked = Date()
                guard isComplete else { return }
                // It settles at -1, 0 or 1 once the fingers lift and its
                // spring's done: only a whole page goes anywhere.
                let to: Direction? = gestureAmount >= 0.99 ? .back : gestureAmount <= -0.99 ? .forward : nil
                withAnimation(.easeOut(duration: 0.12)) { self.amount = nil }
                self.go(to)
            }
        }
    }

    /// AppKit's swipe event, one per gesture: a positive deltaX is the
    /// fingers going left, which is Forward, as Safari has it.
    private func threeFingers(_ event: NSEvent, app: AppModel) -> Bool {
        if event.deltaX < 0, app.canGoBack { go(.back); return true }
        if event.deltaX > 0, app.canGoForward { go(.forward); return true }
        return false
    }

    private func go(_ direction: Direction?) {
        switch direction {
        case .back: app?.goBack()
        case .forward: app?.goForward()
        case nil: break
        }
    }

    /// The ways a swipe at `point` can go: somewhere in the history that
    /// way, and nothing under the pointer that scrolls sideways that way
    /// first (a wide table, a row of chips), as Safari leaves a wide page
    /// to scroll until it's at its edge. A web page in a panel keeps every
    /// swipe, as it scrolls (and goes back) by itself.
    private func ways(at point: NSPoint, in window: NSWindow, app: AppModel) -> Set<Direction> {
        var ways: Set<Direction> = []
        if app.canGoBack { ways.insert(.back) }
        if app.canGoForward { ways.insert(.forward) }
        // The frame view has no superview, so the window's point is its own.
        var view = (window.contentView?.superview ?? window.contentView)?.hitTest(point)
        while let v = view, !ways.isEmpty {
            if v is WKWebView { return [] }
            if let scroll = v as? NSScrollView, let document = scroll.documentView {
                let shown = scroll.contentView.bounds
                if document.frame.width > shown.width + 1 {
                    if shown.minX > 0.5 { ways.remove(.back) }
                    if shown.maxX < document.frame.width - 0.5 { ways.remove(.forward) }
                }
            }
            view = v.superview
        }
        return ways
    }
}

/// Decides from a gesture's first few points whether it's a page swipe or
/// a scroll. Kept apart from the events so it can be tested without a
/// trackpad.
struct SwipeStart {
    enum Verdict: Equatable {
        /// Not clear yet.
        case wait
        /// A scroll: let it, and the rest of the gesture, by.
        case scroll
        case swipe(SwipeNavigation.Direction)
    }

    private var allowed: Set<SwipeNavigation.Direction> = []
    /// Holding the events back while it decides; not over a row.
    private(set) var holds = true
    private var sumX = 0.0
    private var sumY = 0.0

    /// How far across before it's a swipe. Small, as AppKit's tracking
    /// then takes it from there, springing back if it goes no further.
    static let across = 5.0
    /// How far up or down before it's a scroll after all.
    static let upAndDown = 4.0

    mutating func begin(allowed: Set<SwipeNavigation.Direction>, hold: Bool) {
        self.allowed = allowed
        holds = hold
        sumX = 0
        sumY = 0
    }

    /// `dx` right positive. `ended`: the fingers lifted with this event.
    mutating func move(dx: Double, dy: Double, ended: Bool) -> Verdict {
        guard !allowed.isEmpty, !ended else { return .scroll }
        sumX += dx
        sumY += dy
        // A start that's more up and down than across goes straight to the
        // scroll, so ordinary scrolling never waits on this.
        if abs(sumY) > abs(sumX) { return .scroll }
        // Over a row: the row's own rule, on the same events, so the two
        // always agree whether it's across.
        let ratio = holds ? 1.0 : RowSwipe.across
        let needed = holds ? Self.across : RowSwipe.decideAfter
        if abs(sumY) >= Self.upAndDown, abs(sumY) * ratio >= abs(sumX) { return .scroll }
        guard abs(sumX) >= needed else { return .wait }
        guard abs(sumX) > abs(sumY) * ratio else { return holds ? .wait : .scroll }
        let way: SwipeNavigation.Direction = sumX > 0 ? .back : .forward
        return allowed.contains(way) ? .swipe(way) : .scroll
    }
}

/// The arrow at the window's edge while a page swipe is under way: it
/// slides in with the fingers, and fills once it's most of the way.
struct SwipeNavigationArrow: View {
    var body: some View {
        if let amount = SwipeNavigation.shared.amount, abs(amount) > 0.01 {
            let back = amount > 0
            let along = min(1, abs(amount))
            let full = along > 0.5
            Image(systemName: back ? "chevron.left" : "chevron.right")
                .font(.system(size: zoomed(15), weight: .semibold))
                .foregroundStyle(full ? Color.white : Color.secondary)
                .frame(width: zoomed(36), height: zoomed(36))
                .background(Circle().fill(full ? Theme.accentColor : Color(nsColor: .controlBackgroundColor)))
                .overlay(Circle().strokeBorder(Color.primary.opacity(full ? 0 : 0.1)))
                .shadow(color: .black.opacity(0.18), radius: 6, y: 1)
                .animation(Juice.hover, value: full)
                // From just off the edge to 16 points in.
                .offset(x: (back ? 1 : -1) * (CGFloat(along) * zoomed(52) - zoomed(36)))
                .opacity(min(1, along * 3))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: back ? .leading : .trailing)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}
