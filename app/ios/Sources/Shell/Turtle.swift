import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

// Turtle screens (D29), drawn natively in the console (D31). The engine keeps
// the authoritative scene (turtle.ts: items in Tk's canvas model, and the
// queue of events the program reads); it forwards the ops, which this mirror
// applies, and taps and keys go back to it.

@MainActor @Observable
final class TurtleScene {
    struct Item {
        let type: String // line, polygon, image, text
        var xy: [Double]
        var o: [String: JSONValue]
    }

    let key: String
    var title = "Python Turtle Graphics"
    var width: Double = 600
    var height: Double = 600
    var region: [Double] = [-200, -150, 200, 150]
    var background = "#ffffff"
    var live = true
    var active = true
    var pointer = false
    var keys = false
    /// Bumped on every change, so views redraw.
    var version = 0
    @ObservationIgnored private(set) var order: [Int] = []
    @ObservationIgnored private(set) var items: [Int: Item] = [:]
    @ObservationIgnored private(set) var images: [Int: UIImage] = [:]

    init(key: String) {
        self.key = key
    }

    var accepting: Bool { live && active }

    func apply(_ json: String) {
        guard let ops = JSONValue.parse(json)?.array else { return }
        for op in ops {
            guard let a = op.array, let name = a.first?.string else { continue }
            let id = a.count > 1 ? a[1].int : nil
            switch name {
            case "open", "screen":
                if let info = a.count > 1 ? a[1].object : nil { setInfo(info) }
            case "new":
                guard let id, a.count > 4 else { continue }
                if items[id] == nil { order.append(id) }
                items[id] = Item(type: a[2].string ?? "", xy: a[3].array?.compactMap(\.double) ?? [], o: a[4].object ?? [:])
            case "xy":
                if let id, a.count > 2 { items[id]?.xy = a[2].array?.compactMap(\.double) ?? [] }
            case "set":
                if let id, a.count > 2, let patch = a[2].object { for (k, v) in patch { items[id]?.o[k] = v } }
            case "top":
                if let id { order.removeAll { $0 == id }; order.append(id) }
            case "bottom":
                if let id { order.removeAll { $0 == id }; order.insert(id, at: 0) }
            case "del":
                if a.count > 1, a[1].string == "all" {
                    order = []
                    items = [:]
                } else if let id {
                    order.removeAll { $0 == id }
                    items.removeValue(forKey: id)
                }
            case "img":
                guard let id, a.count > 2, let url = a[2].string, let comma = url.firstIndex(of: ","),
                      let data = Data(base64Encoded: String(url[url.index(after: comma)...])), let image = UIImage(data: data, scale: 1)
                else { continue }
                images[id] = image
            default:
                break
            }
        }
        version += 1
    }

    private func setInfo(_ info: [String: JSONValue]) {
        if let t = info["title"]?.string { title = t }
        if let w = info["w"]?.double { width = max(1, w) }
        if let h = info["h"]?.double { height = max(1, h) }
        if let r = info["region"]?.array?.compactMap(\.double), r.count == 4 { region = r }
        if let bg = info["bg"]?.string { background = bg }
    }

    func setState(live: Bool, active: Bool, pointer: Bool, keys: Bool) {
        self.live = live
        self.active = active
        self.pointer = pointer
        self.keys = keys
        version += 1
    }

    // MARK: coordinates

    /// Canvas units (Tk's: y down) for a point in a view `size` wide.
    func canvasPoint(_ p: CGPoint, in size: CGSize) -> CGPoint {
        let s = size.width / width
        return CGPoint(x: p.x / s - width / 2 + (region[0] + region[2]) / 2, y: p.y / s - height / 2 + (region[1] + region[3]) / 2)
    }

    /// The view point for canvas units.
    func viewPoint(_ c: CGPoint, in size: CGSize) -> CGPoint {
        let s = size.width / width
        return CGPoint(x: (c.x + width / 2 - (region[0] + region[2]) / 2) * s, y: (c.y + height / 2 - (region[1] + region[3]) / 2) * s)
    }

    // MARK: drawing

    func draw(in ctx: CGContext, size: CGSize) {
        ctx.setFillColor((UIColorParser.uiColor(background) ?? .white).cgColor)
        ctx.fill(CGRect(origin: .zero, size: size))
        let k = size.width / width
        let cx = (region[0] + region[2]) / 2, cy = (region[1] + region[3]) / 2
        ctx.saveGState()
        ctx.concatenate(CGAffineTransform(a: k, b: 0, c: 0, d: k, tx: (width / 2 - cx) * k, ty: (height / 2 - cy) * k))
        for id in order {
            guard let item = items[id] else { continue }
            let xy = item.xy, o = item.o
            func color(_ key: String) -> CGColor? { o[key]?.string.flatMap { $0.isEmpty ? nil : UIColorParser.uiColor($0)?.cgColor } }
            let width = max(1, o["width"]?.double ?? 1)
            switch item.type {
            case "line":
                guard let fill = color("fill"), xy.count >= 4 else { continue }
                if xy.enumerated().allSatisfy({ $0.element == xy[$0.offset % 2] }) {
                    // A zero-length line with round caps: dot()
                    ctx.setFillColor(fill)
                    ctx.fillEllipse(in: CGRect(x: xy[0] - width / 2, y: xy[1] - width / 2, width: width, height: width))
                    continue
                }
                ctx.setStrokeColor(fill)
                ctx.setLineWidth(width)
                ctx.setLineCap(.round)
                ctx.setLineJoin(.round)
                ctx.addPath(Self.path(xy, close: false))
                ctx.strokePath()
            case "polygon":
                guard xy.count >= 6 else { continue }
                let path = Self.path(xy, close: true)
                if let fill = color("fill") {
                    ctx.setFillColor(fill)
                    ctx.addPath(path)
                    ctx.fillPath(using: .evenOdd) // like Tk: a star's middle stays open
                }
                if let outline = color("outline") {
                    ctx.setStrokeColor(outline)
                    ctx.setLineWidth(width)
                    ctx.setLineJoin(.miter)
                    ctx.addPath(path)
                    ctx.strokePath()
                }
            case "image":
                guard let id = o["image"]?.int, let image = images[id], xy.count >= 2 else { continue }
                UIGraphicsPushContext(ctx)
                image.draw(at: CGPoint(x: xy[0] - image.size.width / 2, y: xy[1] - image.size.height / 2))
                UIGraphicsPopContext()
            case "text":
                guard let text = o["text"]?.string, !text.isEmpty, xy.count >= 2 else { continue }
                let font = CanvasPainter.font(Self.cssFont(o["font"]?.string)) ?? .systemFont(ofSize: 10.7)
                var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor(cgColor: color("fill") ?? UIColor.black.cgColor)]
                if o["underline"]?.truthy == true { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
                let lines = text.components(separatedBy: "\n")
                let anchor = o["anchor"]?.string
                UIGraphicsPushContext(ctx)
                for (i, line) in lines.enumerated() {
                    let s = NSAttributedString(string: line, attributes: attributes)
                    let w = s.size().width
                    let x = anchor == "se" ? xy[0] - w : anchor == "s" ? xy[0] - w / 2 : xy[0]
                    let y = xy[1] - Double(lines.count - i) * font.lineHeight
                    s.draw(at: CGPoint(x: x, y: y))
                }
                UIGraphicsPopContext()
            default:
                break
            }
        }
        ctx.restoreGState()
    }

    /// Tk fonts arrive as CSS ("bold 16pt Arial") from the backend.
    private static func cssFont(_ font: String?) -> String {
        guard let font, !font.isEmpty else { return "8pt Arial" }
        // Points to pixels like the browser (1pt = 4/3 px).
        return font.split(separator: " ").map { part -> String in
            if part.hasSuffix("pt"), let v = Double(part.dropLast(2)) { return "\(v * 4 / 3)px" }
            return String(part)
        }.joined(separator: " ")
    }

    private static func path(_ xy: [Double], close: Bool) -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: xy[0], y: xy[1]))
        var i = 2
        while i + 1 < xy.count {
            p.addLine(to: CGPoint(x: xy[i], y: xy[i + 1]))
            i += 2
        }
        if close { p.closeSubpath() }
        return p
    }

    /// The scene as an image (self-test: pixel checks).
    func render(scale: CGFloat = 1) -> UIImage {
        let size = CGSize(width: width, height: height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        return UIGraphicsImageRenderer(size: size, format: format).image { draw(in: $0.cgContext, size: size) }
    }
}

/// Tk keysyms for keys (what onkey() takes).
@MainActor
enum Keysym {
    static func name(_ key: UIKey) -> String? {
        switch key.keyCode {
        case .keyboardUpArrow: return "Up"
        case .keyboardDownArrow: return "Down"
        case .keyboardLeftArrow: return "Left"
        case .keyboardRightArrow: return "Right"
        case .keyboardSpacebar: return "space"
        case .keyboardReturnOrEnter: return "Return"
        case .keyboardDeleteOrBackspace: return "BackSpace"
        case .keyboardEscape: return "Escape"
        case .keyboardTab: return "Tab"
        default: break
        }
        let chars = key.charactersIgnoringModifiers
        guard let ch = chars.first, chars.count == 1 else { return nil }
        let symbols: [Character: String] = [
            "+": "plus", "-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", ";": "semicolon",
            "'": "apostrophe", "[": "bracketleft", "]": "bracketright", "\\": "backslash", "`": "grave",
        ]
        return symbols[ch] ?? String(ch)
    }
}

/// A turtle screen in the console: fits the width, never scaled up.
struct TurtleView: View {
    let scene: TurtleScene
    var maxHeight: CGFloat = .infinity
    let send: (TurtleScene, [String: Any]) -> Void

    var body: some View {
        let _ = scene.version
        let height = min(scene.height, max(160, maxHeight))
        VStack(alignment: .leading, spacing: 4) {
            if scene.title != "Python Turtle Graphics", !scene.title.isEmpty {
                Text(scene.title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
            }
            TurtleCanvas(scene: scene, version: scene.version, send: send)
                .aspectRatio(scene.width / scene.height, contentMode: .fit)
                .frame(maxWidth: scene.width * height / scene.height, maxHeight: height)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(.separator), lineWidth: 0.5))
        }
        .padding(.vertical, 4)
    }
}

private struct TurtleCanvas: UIViewRepresentable {
    let scene: TurtleScene
    let version: Int
    let send: (TurtleScene, [String: Any]) -> Void

    func makeUIView(context: Context) -> TurtleUIView {
        let view = TurtleUIView()
        view.scene = scene
        view.send = send
        return view
    }

    func updateUIView(_ view: TurtleUIView, context: Context) {
        view.scene = scene
        view.send = send
        view.setNeedsDisplay()
    }
}

final class TurtleUIView: UIView, UIGestureRecognizerDelegate {
    var scene: TurtleScene?
    var send: (TurtleScene, [String: Any]) -> Void = { _, _ in }
    private var pressed = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentMode = .redraw
        isOpaque = true
        let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0
        press.delegate = self
        addGestureRecognizer(press)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext(), let scene else { return }
        scene.draw(in: ctx, size: bounds.size)
    }

    override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        scene.map { $0.pointer && $0.accepting } ?? false
    }

    @objc private func pressed(_ g: UILongPressGestureRecognizer) {
        guard let scene else { return }
        let p = scene.canvasPoint(g.location(in: self), in: bounds.size)
        let event: String
        switch g.state {
        case .began:
            pressed = true
            event = "down"
            becomeFirstResponder()
        case .changed: event = "move"
        case .ended, .cancelled:
            guard pressed else { return }
            pressed = false
            event = "up"
        default: return
        }
        send(scene, ["t": event, "x": p.x, "y": p.y, "b": 1])
    }

    /// Tap at canvas coordinates (y up, like turtle's) as a finger would (self-test).
    func tap(turtleX: Double, turtleY: Double) {
        guard let scene else { return }
        for t in ["down", "up"] { send(scene, ["t": t, "x": turtleX, "y": -turtleY, "b": 1]) }
    }

    // Hardware keys go to the program while it listens.
    override var canBecomeFirstResponder: Bool { scene?.keys == true }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard let scene, scene.keys, scene.accepting else { return super.pressesBegan(presses, with: event) }
        for press in presses { if let key = press.key, let name = Keysym.name(key) { send(scene, ["t": "key", "k": name]) } }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard let scene, scene.keys, scene.accepting else { return super.pressesEnded(presses, with: event) }
        for press in presses { if let key = press.key, let name = Keysym.name(key) { send(scene, ["t": "keyup", "k": name]) } }
    }
}
