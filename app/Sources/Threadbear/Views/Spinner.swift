import AppKit
import SwiftUI

/// A turning arc, the way T3 and Codex show work in progress. A shape layer
/// turned by a Core Animation rotation, so it animates in the render server
/// with nothing to do on the main thread per frame. The system spinner drew
/// pale grey spokes (about 1.6:1 on white), and the SF Symbol's variable
/// colour effect left most of its spokes faint in any one frame, so the
/// one live signal on screen read as a smudge.
final class SpinnerView: NSView {
    // Clicks count while Threadbear isn't the app in front (FirstClick.swift).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    var color: NSColor = .secondaryLabelColor {
        didSet { if color != oldValue { updateColor() } }
    }

    private let arc = CAShapeLayer()
    private var spinning = false
    /// Grows with the zoom, like an icon's strokes; set again in `layout`,
    /// which a zoom change brings with the new frame.
    static var lineWidth: CGFloat { zoomed(1.6) }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        arc.fillColor = nil
        arc.lineCap = .round
        arc.lineWidth = Self.lineWidth
        // Three quarters of a ring: the gap is what shows it turning.
        arc.strokeEnd = 0.75
        layer?.addSublayer(arc)
        updateColor()
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        arc.frame = bounds
        arc.lineWidth = Self.lineWidth
        let side = min(bounds.width, bounds.height) - zoomed(3)
        let ring = NSRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side)
        arc.path = CGPath(ellipseIn: ring, transform: nil)
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColor()
    }

    private func updateColor() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        arc.strokeColor = color.resolvedCGColor(for: self)
        CATransaction.commit()
    }

    func start() {
        spinning = true
        addSpin()
    }

    func stop() {
        spinning = false
        arc.removeAnimation(forKey: "spin")
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // A layer can lose its animations on the way out of a window (a
        // table cell parked for reuse); put the spin back on the way in.
        if window != nil, spinning { addSpin() }
    }

    private func addSpin() {
        guard window != nil, arc.animation(forKey: "spin") == nil else { return }
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        // Clockwise on screen whichever way this layer's geometry runs.
        let turn = 2 * Double.pi * (arc.contentsAreFlipped() ? 1 : -1)
        spin.fromValue = 0
        spin.toValue = turn
        spin.duration = 0.9
        spin.repeatCount = .infinity
        spin.isRemovedOnCompletion = false
        arc.add(spin, forKey: "spin")
    }
}

/// The spinner in SwiftUI (the sidebar's running rows).
struct SpinnerMark: NSViewRepresentable {
    var color: NSColor = Theme.running

    func makeNSView(context: Context) -> SpinnerView {
        let view = SpinnerView()
        view.color = color
        view.start()
        return view
    }

    func updateNSView(_ view: SpinnerView, context: Context) {
        view.color = color
    }
}

/// Always overlay scrollers. AppKit sets every scroll view back to the
/// system's style when a mouse is connected, which drew a legacy scroller
/// with a full-height track: inside the composer's rounded card, and down
/// the transcript's right edge, where it also pushed the reading column
/// (and the composer under it) off the pane's centre. Codex and Claude
/// show the position only while scrolling.
final class OverlayScrollView: NSScrollView {
    override var scrollerStyle: NSScroller.Style {
        get { .overlay }
        set { super.scrollerStyle = .overlay }
    }
}
