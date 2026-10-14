import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

// ui.Canvas: the drawing commands Python records (the browser's canvas 2D API,
// camelCase) replayed into Core Graphics, plus pointer events and a frame loop
// (one frame in flight at a time, acknowledged by a "frame" op).

struct CanvasNode: View {
    let node: UINode
    @Environment(UIStore.self) private var store

    var body: some View {
        let cw = max(1, node.double("cw") ?? 300)
        let ch = max(1, node.double("ch") ?? 300)
        CanvasRepresentable(
            node: node, store: store, commands: node.props["cmds"]?.array ?? [], width: cw, height: ch,
            frames: node.bool("on_frame"),
            pointers: node.bool("on_pointer_down") || node.bool("on_pointer_move") || node.bool("on_pointer_up")
        )
        .aspectRatio(cw / ch, contentMode: .fit)
        .frame(maxWidth: cw)
    }
}

private struct CanvasRepresentable: UIViewRepresentable {
    let node: UINode
    let store: UIStore
    let commands: [JSONValue]
    let width: Double
    let height: Double
    let frames: Bool
    let pointers: Bool

    func makeUIView(context: Context) -> CanvasUIView {
        let view = CanvasUIView()
        configure(view)
        return view
    }

    func updateUIView(_ view: CanvasUIView, context: Context) {
        configure(view)
    }

    static func dismantleUIView(_ view: CanvasUIView, coordinator: ()) {
        view.stopFrames()
    }

    private func configure(_ view: CanvasUIView) {
        let node = node, store = store
        view.canvasSize = CGSize(width: width, height: height)
        view.commands = commands
        view.pointersEnabled = pointers
        view.onPointer = { event, x, y, id, buttons in
            guard node.has("on_\(event)") else { return }
            store.emit(node, event, [["x": x, "y": y, "id": id, "buttons": buttons]])
        }
        view.onFrame = { dt in store.emit(node, "frame", [dt]) }
        store.frameAcks[node.id] = { [weak view] in view?.frameAcknowledged() }
        if frames { view.startFrames() } else { view.stopFrames() }
    }
}

final class CanvasUIView: UIView, UIGestureRecognizerDelegate {
    var canvasSize = CGSize(width: 300, height: 300)
    var commands: [JSONValue] = [] {
        didSet { if commands != oldValue { setNeedsDisplay() } }
    }
    var pointersEnabled = false
    var onPointer: (String, Double, Double, Int, Int) -> Void = { _, _, _, _, _ in }
    var onFrame: (Double) -> Void = { _ in }

    private var link: CADisplayLink?
    private var lastTick: CFTimeInterval?
    private var waiting = false
    private var sentAt: CFTimeInterval = 0
    private var touchIDs: [ObjectIdentifier: Int] = [:]
    private var nextTouchID = 1

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        let tracker = TouchTracker(target: nil, action: nil)
        tracker.delegate = self
        tracker.owner = self
        addGestureRecognizer(tracker)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext(), canvasSize.width > 0 else { return }
        let scale = bounds.width / canvasSize.width
        ctx.scaleBy(x: scale, y: scale)
        CanvasPainter(ctx: ctx, size: canvasSize).run(commands)
    }

    // MARK: frames

    func startFrames() {
        guard link == nil else { return }
        let link = CADisplayLink(target: DisplayLinkProxy(self), selector: #selector(DisplayLinkProxy.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        lastTick = nil
        waiting = false
    }

    func stopFrames() {
        link?.invalidate()
        link = nil
    }

    func frameAcknowledged() {
        waiting = false
    }

    fileprivate func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        // One frame in flight; never wait forever on a lost acknowledgement.
        guard !waiting || now - sentAt > 1 else { return }
        let dt = lastTick.map { min(0.1, now - $0) } ?? 1.0 / 60
        lastTick = now
        waiting = true
        sentAt = now
        onFrame(dt)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { stopFrames() }
    }

    // MARK: pointers

    fileprivate func touches(_ touches: Set<UITouch>, _ event: String) {
        guard pointersEnabled, bounds.width > 0 else { return }
        for touch in touches {
            let key = ObjectIdentifier(touch)
            if touchIDs[key] == nil {
                touchIDs[key] = nextTouchID
                nextTouchID += 1
            }
            let id = touchIDs[key]!
            let p = touch.location(in: self)
            let x = Double(p.x * canvasSize.width / bounds.width)
            let y = Double(p.y * canvasSize.height / bounds.height)
            onPointer(event, x, y, id, event == "pointer_up" ? 0 : 1)
            if event == "pointer_up" { touchIDs.removeValue(forKey: key) }
        }
    }

    /// While drawing, the list around the canvas must not scroll or swipe.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        pointersEnabled && other.view !== self && other is UIPanGestureRecognizer && !(other is UIScreenEdgePanGestureRecognizer)
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}

private final class DisplayLinkProxy {
    weak var view: CanvasUIView?
    init(_ view: CanvasUIView) { self.view = view }
    @MainActor @objc func tick(_ link: CADisplayLink) {
        if let view { view.tick(link) } else { link.invalidate() }
    }
}

/// Reports raw touches on the canvas and keeps scroll views from taking them.
private final class TouchTracker: UIGestureRecognizer {
    weak var owner: CanvasUIView?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard owner?.pointersEnabled == true else {
            state = .failed
            return
        }
        owner?.touches(touches, "pointer_down")
        if state == .possible { state = .began }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        owner?.touches(touches, "pointer_move")
        if state == .began || state == .changed { state = .changed }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        owner?.touches(touches, "pointer_up")
        if numberOfTouches <= touches.count { state = .ended }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        owner?.touches(touches, "pointer_up")
        state = .cancelled
    }
}

// MARK: - painter

/// Replays canvas 2D commands. The current path is kept in canvas units (with
/// the transform at the time each point was added), like the browser does, so
/// fill() followed by stroke() works on the same path.
struct CanvasPainter {
    let ctx: CGContext
    let size: CGSize

    private struct State {
        var transform = CGAffineTransform.identity
        var fill: CGColor = UIColor.black.cgColor
        var stroke: CGColor = UIColor.black.cgColor
        var lineWidth: CGFloat = 1
        var lineCap: CGLineCap = .butt
        var lineJoin: CGLineJoin = .miter
        var miterLimit: CGFloat = 10
        var alpha: CGFloat = 1
        var font = UIFont.systemFont(ofSize: 10)
        var textAlign = "start"
        var textBaseline = "alphabetic"
        var dash: [CGFloat] = []
        var dashOffset: CGFloat = 0
        var shadowColor: CGColor?
        var shadowBlur: CGFloat = 0
        var shadowOffset = CGSize.zero
    }

    init(ctx: CGContext, size: CGSize) {
        self.ctx = ctx
        self.size = size
    }

    func run(_ commands: [JSONValue]) {
        var state = State()
        var stack: [State] = []
        var current = CGMutablePath()
        for command in commands {
            guard let a = command.array, let name = a.first?.string else { continue }
            let args = Array(a.dropFirst())
            func n(_ i: Int, _ fallback: Double = 0) -> CGFloat { CGFloat(i < args.count ? args[i].double ?? fallback : fallback) }
            func s(_ i: Int) -> String? { i < args.count && !args[i].isNull ? args[i].string : nil }
            let t = state.transform
            switch name {
            case "=":
                set(&state, s(0) ?? "", args.count > 1 ? args[1] : .null)
            case "save":
                stack.append(state)
                ctx.saveGState()
            case "restore":
                if let saved = stack.popLast() {
                    state = saved
                    ctx.restoreGState()
                }
            case "translate": state.transform = CGAffineTransform(translationX: n(0), y: n(1)).concatenating(t)
            case "rotate": state.transform = CGAffineTransform(rotationAngle: n(0)).concatenating(t)
            case "scale": state.transform = CGAffineTransform(scaleX: n(0, 1), y: n(1, 1)).concatenating(t)
            case "transform":
                state.transform = CGAffineTransform(a: n(0), b: n(1), c: n(2), d: n(3), tx: n(4), ty: n(5)).concatenating(t)
            case "setTransform":
                state.transform = args.isEmpty ? .identity : CGAffineTransform(a: n(0), b: n(1), c: n(2), d: n(3), tx: n(4), ty: n(5))
            case "resetTransform": state.transform = .identity
            case "beginPath":
                current = CGMutablePath()
            case "closePath": if !current.isEmpty { current.closeSubpath() }
            case "moveTo": current.move(to: CGPoint(x: n(0), y: n(1)), transform: t)
            case "lineTo":
                if current.isEmpty { current.move(to: CGPoint(x: n(0), y: n(1)), transform: t) } else { current.addLine(to: CGPoint(x: n(0), y: n(1)), transform: t) }
            case "quadraticCurveTo":
                current.addQuadCurve(to: CGPoint(x: n(2), y: n(3)), control: CGPoint(x: n(0), y: n(1)), transform: t)
            case "bezierCurveTo":
                current.addCurve(to: CGPoint(x: n(4), y: n(5)), control1: CGPoint(x: n(0), y: n(1)), control2: CGPoint(x: n(2), y: n(3)), transform: t)
            case "arc":
                current.addArc(center: CGPoint(x: n(0), y: n(1)), radius: max(0, n(2)), startAngle: n(3), endAngle: n(4),
                               clockwise: args.count > 5 && args[5].truthy, transform: t)
            case "arcTo":
                if current.isEmpty { current.move(to: CGPoint(x: n(0), y: n(1)), transform: t) }
                current.addArc(tangent1End: CGPoint(x: n(0), y: n(1)), tangent2End: CGPoint(x: n(2), y: n(3)), radius: max(0, n(4)), transform: t)
            case "ellipse":
                let e = CGAffineTransform(translationX: n(0), y: n(1)).rotated(by: n(4)).scaledBy(x: max(1e-6, n(2)), y: max(1e-6, n(3))).concatenating(t)
                current.addArc(center: .zero, radius: 1, startAngle: n(5), endAngle: n(6), clockwise: args.count > 7 && args[7].truthy, transform: e)
            case "rect":
                current.addRect(CGRect(x: n(0), y: n(1), width: n(2), height: n(3)), transform: t)
            case "roundRect":
                let r = args.count > 4 ? (args[4].array?.first?.double ?? args[4].double ?? 0) : 0
                let rect = CGRect(x: n(0), y: n(1), width: n(2), height: n(3)).standardized
                let radius = min(CGFloat(r), rect.width / 2, rect.height / 2)
                current.addRoundedRect(in: rect, cornerWidth: radius, cornerHeight: radius, transform: t)
            case "fill":
                fill(current, state, evenOdd: s(0) == "evenodd")
            case "stroke":
                stroke(current, state)
            case "clip":
                ctx.addPath(current)
                ctx.clip(using: s(0) == "evenodd" ? .evenOdd : .winding)
            case "fillRect":
                let p = CGPath(rect: CGRect(x: n(0), y: n(1), width: n(2), height: n(3)), transform: [t])
                fill(p, state)
            case "strokeRect":
                let p = CGMutablePath()
                p.addRect(CGRect(x: n(0), y: n(1), width: n(2), height: n(3)), transform: t)
                stroke(p, state)
            case "clearRect":
                ctx.saveGState()
                ctx.setBlendMode(.clear)
                ctx.addPath(CGPath(rect: CGRect(x: n(0), y: n(1), width: n(2), height: n(3)), transform: [t]))
                ctx.fillPath()
                ctx.restoreGState()
            case "fillText", "strokeText":
                text(s(0) ?? "", n(1), n(2), state, stroke: name == "strokeText")
            case "setLineDash":
                state.dash = (args.first?.array ?? []).compactMap { $0.double.map { CGFloat($0) } }
            case "$clear":
                ctx.saveGState()
                ctx.setBlendMode(.clear)
                ctx.fill(CGRect(origin: .zero, size: size))
                ctx.restoreGState()
                if let color = UIColorParser.uiColor(s(0)) {
                    ctx.setFillColor(color.cgColor)
                    ctx.fill(CGRect(origin: .zero, size: size))
                }
            case "$circle":
                let p = CGMutablePath()
                p.addEllipse(in: CGRect(x: n(0) - n(2), y: n(1) - n(2), width: n(2) * 2, height: n(2) * 2), transform: t)
                var st = state
                if let fill = UIColorParser.uiColor(s(3)) {
                    st.fill = fill.cgColor
                    self.fill(p, st)
                }
                if s(4) != nil || s(3) == nil {
                    if let c = UIColorParser.uiColor(s(4)) { st.stroke = c.cgColor }
                    if args.count > 5, let w = args[5].double { st.lineWidth = CGFloat(w) }
                    stroke(p, st)
                }
            case "$line":
                let p = CGMutablePath()
                p.move(to: CGPoint(x: n(0), y: n(1)), transform: t)
                p.addLine(to: CGPoint(x: n(2), y: n(3)), transform: t)
                var st = state
                if let c = UIColorParser.uiColor(s(4)) { st.stroke = c.cgColor }
                if args.count > 5, let w = args[5].double { st.lineWidth = CGFloat(w) }
                stroke(p, st)
            case "$text":
                var st = state
                if let c = UIColorParser.uiColor(s(3)) { st.fill = c.cgColor }
                if let f = s(4) { st.font = Self.font(f) ?? st.font }
                if let align = s(5) { st.textAlign = align }
                text(s(0) ?? "", n(1), n(2), st, stroke: false)
            default:
                break
            }
        }
    }

    private func set(_ state: inout State, _ key: String, _ value: JSONValue) {
        switch key {
        case "fillStyle": if let c = UIColorParser.uiColor(value.string) { state.fill = c.cgColor }
        case "strokeStyle": if let c = UIColorParser.uiColor(value.string) { state.stroke = c.cgColor }
        case "lineWidth": if let w = value.double, w > 0 { state.lineWidth = CGFloat(w) }
        case "lineCap": state.lineCap = ["round": .round, "square": .square][value.string ?? ""] ?? .butt
        case "lineJoin": state.lineJoin = ["round": .round, "bevel": .bevel][value.string ?? ""] ?? .miter
        case "miterLimit": if let m = value.double { state.miterLimit = CGFloat(m) }
        case "globalAlpha": if let a = value.double { state.alpha = CGFloat(min(max(a, 0), 1)) }
        case "font": if let f = Self.font(value.string ?? "") { state.font = f }
        case "textAlign": state.textAlign = value.string ?? "start"
        case "textBaseline": state.textBaseline = value.string ?? "alphabetic"
        case "lineDashOffset": state.dashOffset = CGFloat(value.double ?? 0)
        case "shadowColor": state.shadowColor = UIColorParser.uiColor(value.string)?.cgColor
        case "shadowBlur": state.shadowBlur = CGFloat(value.double ?? 0)
        case "shadowOffsetX": state.shadowOffset.width = CGFloat(value.double ?? 0)
        case "shadowOffsetY": state.shadowOffset.height = CGFloat(value.double ?? 0)
        default: break
        }
    }

    private func applyCommon(_ state: State) {
        ctx.setAlpha(state.alpha)
        if let shadow = state.shadowColor, state.shadowBlur > 0 || state.shadowOffset != .zero {
            ctx.setShadow(offset: state.shadowOffset, blur: state.shadowBlur, color: shadow)
        }
    }

    private func fill(_ path: CGPath, _ state: State, evenOdd: Bool = false) {
        guard !path.isEmpty else { return }
        ctx.saveGState()
        applyCommon(state)
        ctx.setFillColor(state.fill)
        ctx.addPath(path)
        ctx.fillPath(using: evenOdd ? .evenOdd : .winding)
        ctx.restoreGState()
    }

    private func stroke(_ path: CGPath, _ state: State) {
        guard !path.isEmpty else { return }
        ctx.saveGState()
        applyCommon(state)
        // The path is in canvas units; stroke it in the current transform so
        // the line width scales with it.
        ctx.concatenate(state.transform)
        var inverse = state.transform.inverted()
        if let local = path.copy(using: &inverse) { ctx.addPath(local) }
        ctx.setStrokeColor(state.stroke)
        ctx.setLineWidth(state.lineWidth)
        ctx.setLineCap(state.lineCap)
        ctx.setLineJoin(state.lineJoin)
        ctx.setMiterLimit(state.miterLimit)
        if !state.dash.isEmpty { ctx.setLineDash(phase: state.dashOffset, lengths: state.dash) }
        ctx.strokePath()
        ctx.restoreGState()
    }

    private func text(_ string: String, _ x: CGFloat, _ y: CGFloat, _ state: State, stroke: Bool) {
        let color = UIColor(cgColor: stroke ? state.stroke : state.fill)
        var attributes: [NSAttributedString.Key: Any] = [.font: state.font, .foregroundColor: color]
        if stroke {
            attributes[.strokeColor] = color
            attributes[.strokeWidth] = state.lineWidth / state.font.pointSize * 100
        }
        let text = NSAttributedString(string: string, attributes: attributes)
        let width = text.size().width
        let font = state.font
        let dx: CGFloat = switch state.textAlign {
        case "center": -width / 2
        case "right", "end": -width
        default: 0
        }
        // UIKit draws from the top of the line; the canvas default is the baseline.
        let dy: CGFloat = switch state.textBaseline {
        case "top", "hanging": 0
        case "middle": -(font.ascender + font.descender) / 2 - (font.lineHeight - font.ascender + font.descender) / 2
        case "bottom", "ideographic": -font.lineHeight
        default: -font.ascender
        }
        ctx.saveGState()
        applyCommon(state)
        ctx.concatenate(state.transform)
        UIGraphicsPushContext(ctx)
        text.draw(at: CGPoint(x: x + dx, y: y + dy))
        UIGraphicsPopContext()
        ctx.restoreGState()
    }

    /// A CSS font shorthand: "bold 20px sans-serif", "15px system-ui", "italic 12px monospace".
    static func font(_ spec: String) -> UIFont? {
        var size: CGFloat = 10
        var weight = UIFont.Weight.regular
        var italic = false
        var family: [String] = []
        var seenSize = false
        for token in spec.split(separator: " ") {
            let t = token.lowercased()
            if !seenSize {
                if t.hasSuffix("px") || t.hasSuffix("pt"), let v = Double(t.dropLast(2)) {
                    size = CGFloat(v)
                    seenSize = true
                } else if t == "bold" || t == "bolder" {
                    weight = .bold
                } else if let w = Int(t) {
                    weight = w >= 700 ? .bold : w >= 600 ? .semibold : w >= 500 ? .medium : w <= 300 ? .light : .regular
                } else if t == "italic" || t == "oblique" {
                    italic = true
                }
            } else {
                family.append(String(token))
            }
        }
        let families = family.joined(separator: " ").split(separator: ",").map {
            $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")).lowercased()
        }
        var font: UIFont
        if families.first == "monospace" || families.first == "ui-monospace" {
            font = .monospacedSystemFont(ofSize: size, weight: weight)
        } else if let name = families.first, !["sans-serif", "system-ui", "-apple-system", "serif", ""].contains(name),
                  let custom = UIFont(name: name, size: size) {
            font = custom
        } else {
            font = .systemFont(ofSize: size, weight: weight)
            if families.first == "serif", let d = font.fontDescriptor.withDesign(.serif) { font = UIFont(descriptor: d, size: size) }
        }
        if italic, let d = font.fontDescriptor.withSymbolicTraits(.traitItalic) { font = UIFont(descriptor: d, size: size) }
        return font
    }
}
