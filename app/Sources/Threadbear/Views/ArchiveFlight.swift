import AppKit
import SwiftUI
import ThreadbearCore

/// The open thread's panel dropping into the Archived heading when it's
/// archived. Mike found the panel just flicking to the next thread flat
/// beside the sidebar's sliding row, and picked this, "D2 · Drop", from
/// mockups (30 Oct; docs/archive-transition-design). It falls first and
/// then curves across into the heading's archive box, shrinking and
/// tipping slightly, like a sheet dropped into a drawer. The box bounces
/// and the count rolls on as it lands (`AppModel.flyingToArchive`), and the
/// next thread fades in underneath.
///
/// The transcript is one table that the next thread reuses straight away,
/// so what flies is a picture of it, in a see-through window over the main
/// one (above the sidebar, and nothing in it takes clicks). The flight is
/// a Core Animation keyframe animation, so it runs in the render server:
/// the first version stepped it from the main thread each frame, and Mike
/// saw only a couple of frames of it (30 Oct), as the same click opens the
/// next thread on the main thread. So the path is worked out at the
/// start, aimed at where the heading will be once the archived row has
/// closed up above it. With the heading out of sight (a long inbox, a lazy
/// list that hasn't drawn it) the picture falls off the bottom of the list
/// instead; with no list (another sidebar view) or under Reduce Motion it
/// just fades.
@MainActor
enum ArchiveFlight {
    /// The Archived heading's box, the inbox list and the open thread's
    /// row, while they're drawn (`FlightMarker`).
    fileprivate(set) static weak var archiveBox: NSView?
    fileprivate(set) static weak var inboxList: NSView?
    fileprivate(set) static weak var openRow: NSView?

    static let duration: Double = 0.44
    /// How long the last flight's picture took, for the perf run.
    private(set) static var lastPictureMs = 0.0

    /// Starts a flight from `view` as it looks now, and fades `view` back
    /// in for the thread that replaces it. Calls `landed` at the end.
    /// False, with nothing started, when there's nothing to picture.
    static func launch(from view: NSView, landed: @escaping @MainActor () -> Void) -> Bool {
        let pictureStart = CACurrentMediaTime()
        guard let window = view.window, !view.isHiddenOrHasHiddenAncestor, view.bounds.width > 1, view.bounds.height > 1,
              let picture = picture(of: view) else { return false }
        lastPictureMs = (CACurrentMediaTime() - pictureStart) * 1000
        let overlay = Overlay.shown(over: window)
        let card = CALayer()
        card.contents = picture
        card.contentsScale = window.backingScaleFactor
        card.contentsGravity = .resize
        card.masksToBounds = true
        // The pane's own background, which the table doesn't draw.
        window.effectiveAppearance.performAsCurrentDrawingAppearance {
            card.backgroundColor = Theme.canvas.cgColor
        }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        card.frame = view.convert(view.bounds, to: nil)
        overlay.layer.addSublayer(card)
        CATransaction.setCompletionBlock {
            MainActor.assumeIsolated {
                card.removeFromSuperlayer()
                overlay.flightEnded()
                landed()
            }
        }
        let target = Juice.reduceMotion ? nil : target(in: window)
        if let target {
            let path = ArchiveFlightPath(start: card.position, end: target.point, swing: zoomed(40), onHeading: target.onHeading)
            card.add(flight(along: path), forKey: "flight")
        } else {
            card.add(fade(), forKey: "flight")
        }
        // The next thread comes in under it once it's on its way. Hidden
        // until then, and the fade starts from the main thread, so it waits
        // for the next thread to be laid out: run from the render server
        // instead, it brought the old transcript back into view behind the
        // card while the main thread was busy opening the next one.
        view.alphaValue = 0
        DispatchQueue.main.asyncAfter(deadline: .now() + (Juice.reduceMotion ? 0.05 : 0.2)) {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = Juice.reduceMotion ? 0.15 : 0.28
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                view.animator().alphaValue = 1
            }
        }
        CATransaction.commit()
        // Sends it to the render server now, rather than at the end of this
        // run loop turn, after the next thread has opened: so it's moving
        // from the click, whatever the main thread does next.
        CATransaction.flush()
        return true
    }

    /// The whole flight as keyframes, sampled from the path often enough
    /// that straight lines between them read as the curve.
    private static func flight(along path: ArchiveFlightPath) -> CAAnimationGroup {
        let samples = 32
        var times: [NSNumber] = [], positions: [NSValue] = [], transforms: [NSValue] = []
        var radii: [NSNumber] = [], opacities: [NSNumber] = []
        for i in 0...samples {
            let t = Double(i) / Double(samples)
            let frame = path.frame(at: ArchiveFlightPath.progress(atTime: t))
            times.append(NSNumber(value: t))
            positions.append(NSValue(point: frame.position))
            transforms.append(NSValue(caTransform3D: CATransform3DRotate(CATransform3DMakeScale(frame.scale, frame.scale, 1), frame.tilt, 0, 0, 1)))
            radii.append(NSNumber(value: frame.cornerRadius))
            opacities.append(NSNumber(value: frame.opacity))
        }
        func track(_ keyPath: String, _ values: [Any]) -> CAKeyframeAnimation {
            let animation = CAKeyframeAnimation(keyPath: keyPath)
            animation.values = values
            animation.keyTimes = times
            return animation
        }
        let group = CAAnimationGroup()
        group.animations = [track("position", positions), track("transform", transforms),
                            track("cornerRadius", radii), track("opacity", opacities)]
        group.duration = duration
        finish(group)
        return group
    }

    /// Nowhere to fly to, or Reduce Motion: a quick fade where it is.
    private static func fade() -> CAAnimation {
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.duration = 0.18
        fade.timingFunction = CAMediaTimingFunction(name: .easeIn)
        finish(fade)
        return fade
    }

    /// Holds the last frame until the card's taken away, so it never
    /// flashes back to full size.
    private static func finish(_ animation: CAAnimation) {
        animation.fillMode = .forwards
        animation.isRemovedOnCompletion = false
    }

    /// The view as drawn, transparent where it draws nothing.
    private static func picture(of view: NSView) -> CGImage? {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep.cgImage
    }

    /// Where the card is headed, in window coordinates, and whether that's
    /// the heading itself or just the bottom of the list.
    fileprivate static func target(in window: NSWindow) -> (point: CGPoint, onHeading: Bool)? {
        if let box = archiveBox, box.window === window, !box.visibleRect.isEmpty {
            let frame = box.convert(box.bounds, to: nil)
            var point = CGPoint(x: frame.midX, y: frame.midY)
            // The archived thread's row closes up above the heading as the
            // card flies, lifting the heading by its height (window
            // coordinates run upwards).
            if let row = openRow, row.window === window {
                let rowFrame = row.convert(row.bounds, to: nil)
                if rowFrame.minY > frame.maxY { point.y += rowFrame.height }
            }
            return (point, true)
        }
        if let list = inboxList, list.window === window, !list.visibleRect.isEmpty {
            let frame = list.convert(list.visibleRect, to: nil)
            // Where the heading's box would be, at the list's bottom edge.
            return (CGPoint(x: frame.minX + SidebarMetrics.leading + zoomed(7), y: frame.minY), false)
        }
        return nil
    }
}

/// A see-through, click-through window exactly over the main one, for
/// cards to fly in above the sidebar and the panel alike. One per window,
/// kept between flights (making a window on each click cost time on the
/// click), and only on screen while a card's in it.
@MainActor
private final class Overlay {
    private static var shown: [ObjectIdentifier: Overlay] = [:]

    let panel: NSWindow
    let layer: CALayer
    private weak var parent: NSWindow?
    private var flights = 0

    static func shown(over window: NSWindow) -> Overlay {
        let overlay = shown[ObjectIdentifier(window)] ?? Overlay(over: window)
        shown[ObjectIdentifier(window)] = overlay
        overlay.show()
        return overlay
    }

    private init(over window: NSWindow) {
        panel = NSWindow(contentRect: window.frame, styleMask: .borderless, backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.transient, .ignoresCycle]
        let host = NSView(frame: NSRect(origin: .zero, size: window.frame.size))
        host.wantsLayer = true
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
        layer = host.layer!
        parent = window
    }

    private func show() {
        flights += 1
        guard flights == 1, let parent else { return }
        // Wherever the window is now: it may have moved or changed size
        // since the last flight.
        panel.setFrame(parent.frame, display: false)
        parent.addChildWindow(panel, ordered: .above)
    }

    func flightEnded() {
        flights -= 1
        guard flights == 0 else { return }
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
    }
}

/// Marks where an archive flight can land: an invisible view whose frame
/// `ArchiveFlight` reads when a flight starts.
struct FlightMarker: NSViewRepresentable {
    enum Kind { case archiveBox, inboxList, openRow }
    let kind: Kind

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        register(view)
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        register(view)
    }

    private func register(_ view: NSView) {
        switch kind {
        case .archiveBox: ArchiveFlight.archiveBox = view
        case .inboxList: ArchiveFlight.inboxList = view
        case .openRow: ArchiveFlight.openRow = view
        }
    }
}

extension EnvironmentValues {
    /// Set on the Archived heading only: how many flights have landed in
    /// it, so its box bounces at each, and where the flights aim.
    @Entry var archiveLandings: Int? = nil
}
