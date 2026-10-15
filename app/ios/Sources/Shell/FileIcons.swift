import SwiftUI

/// The file browser's icons, drawn from the same SVG paths the web app used:
/// a page with the Python logo for .py files, the extension in color for
/// others, and a two-tone folder.
struct FileIcon: View {
    let name: String
    var size: CGFloat = 30
    @Environment(\.colorScheme) private var scheme

    private static let page = SVGPath.parse("M3 1.5h12.5L22.5 8.5v18.5a2 2 0 0 1-2 2H3.5a2 2 0 0 1-2-2V3.5a2 2 0 0 1 2-2z")
    private static let fold = SVGPath.parse("M15.5 1.5v5a2 2 0 0 0 2 2h5")
    private static let snakeTop = SVGPath.parse("M11.9 1c-5.6 0-5.3 2.4-5.3 2.4v2.5h5.4v.8H4.5S1 6.3 1 11.8s3.1 5.3 3.1 5.3H6v-2.6s-.1-3.1 3-3.1h5.3s2.9 0 2.9-2.8V4.1S17.6 1 11.9 1zM9 2.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z")
    private static let snakeBottom = SVGPath.parse("M12.1 23c5.6 0 5.3-2.4 5.3-2.4v-2.5H12v-.8h7.5s3.5.4 3.5-5.1-3.1-5.3-3.1-5.3H18v2.6s.1 3.1-3 3.1H9.7s-2.9 0-2.9 2.8v4.5S6.4 23 12.1 23zm2.9-1.6a1 1 0 1 1 0-2 1 1 0 0 1 0 2z")

    private static let palette: [String: (UInt32, UInt32)] = [
        "py": (0x3776ab, 0xffd43b),
        "pyi": (0x3776ab, 0xffd43b),
        "txt": (0x8e8e93, 0xc7c7cc),
        "md": (0x5856d6, 0xa5a3f5),
        "json": (0xff9500, 0xffcc80),
        "csv": (0x34c759, 0xa8e6b5),
        "toml": (0xaf52de, 0xd9a8f0),
    ]

    var body: some View {
        let ext = (name as NSString).pathExtension.lowercased()
        let (ink, accent) = Self.palette[ext] ?? (0x8e8e93, 0xc7c7cc)
        let dark = scheme == .dark
        let background = dark ? Color(hex: 0x2c2c2e) : .white
        let stroke = dark ? Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255, opacity: 0.25)
                          : Color(red: 60 / 255, green: 60 / 255, blue: 67 / 255, opacity: 0.28)
        Canvas { ctx, canvasSize in
            ctx.scaleBy(x: canvasSize.width / 24, y: canvasSize.height / 30)
            ctx.fill(Self.page, with: .color(background))
            ctx.stroke(Self.page, with: .color(stroke), lineWidth: 1)
            ctx.stroke(Self.fold, with: .color(stroke), lineWidth: 1)
            if ext == "py" || ext == "pyi" {
                var logo = ctx
                logo.translateBy(x: 5.2, y: 11.5)
                logo.scaleBy(x: 0.6, y: 0.6)
                logo.fill(Self.snakeTop, with: .color(Color(hex: ink)))
                logo.fill(Self.snakeBottom, with: .color(Color(hex: accent)))
            } else {
                let label = String((ext.isEmpty ? "file" : ext).prefix(4)).uppercased()
                ctx.draw(Text(label).font(.system(size: 6.2, weight: .bold)).foregroundStyle(Color(hex: ink)),
                         at: CGPoint(x: 12, y: 22), anchor: UnitPoint(x: 0.5, y: 0.8))
            }
        }
        .frame(width: size * 0.8, height: size)
        .accessibilityHidden(true)
    }
}

struct FolderIcon: View {
    var size: CGFloat = 30

    private static let back = SVGPath.parse("M1.5 4A2.5 2.5 0 0 1 4 1.5h7.1a2 2 0 0 1 1.5.7l1.9 2.3H26A2.5 2.5 0 0 1 28.5 7v14.5A2.5 2.5 0 0 1 26 24H4a2.5 2.5 0 0 1-2.5-2.5z")
    private static let front = SVGPath.parse("M1.5 8.5h27v13A2.5 2.5 0 0 1 26 24H4a2.5 2.5 0 0 1-2.5-2.5z")

    var body: some View {
        Canvas { ctx, canvasSize in
            ctx.scaleBy(x: canvasSize.width / 30, y: canvasSize.height / 25)
            ctx.fill(Self.back, with: .color(Color(hex: 0x2f9bf5)))
            ctx.fill(Self.front, with: .color(Color(hex: 0x5ab3fa)))
        }
        .frame(width: size, height: size * 0.82)
        .accessibilityHidden(true)
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255)
    }
}

/// A small SVG path data parser (M L H V C S Q T A Z, absolute and relative),
/// enough for icons kept as SVG.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        var tokens = Tokens(Array(d.utf8))
        var current = CGPoint.zero, start = CGPoint.zero
        var lastControl: CGPoint?  // reflected by S and T
        var command: UInt8 = 0
        while true {
            // A command repeats while numbers follow it (`l1 2 3 4`).
            if let next = tokens.command() {
                command = next
            } else if command == 0 || !tokens.hasNumber() {
                break
            }
            let relative = command >= UInt8(ascii: "a")
            func point() -> CGPoint {
                let x = tokens.number(), y = tokens.number()
                return relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
            }
            var control: CGPoint?
            switch command | 0x20 {  // lowercase
            case UInt8(ascii: "m"):
                current = point()
                start = current
                path.move(to: current)
                command = relative ? UInt8(ascii: "l") : UInt8(ascii: "L")  // further pairs are lines
            case UInt8(ascii: "l"):
                current = point()
                path.addLine(to: current)
            case UInt8(ascii: "h"):
                let x = tokens.number()
                current.x = relative ? current.x + x : x
                path.addLine(to: current)
            case UInt8(ascii: "v"):
                let y = tokens.number()
                current.y = relative ? current.y + y : y
                path.addLine(to: current)
            case UInt8(ascii: "c"):
                let c1 = point(), c2 = point(), end = point()
                path.addCurve(to: end, control1: c1, control2: c2)
                control = c2
                current = end
            case UInt8(ascii: "s"):
                let c1 = reflect(lastControl, current), c2 = point(), end = point()
                path.addCurve(to: end, control1: c1, control2: c2)
                control = c2
                current = end
            case UInt8(ascii: "q"):
                let c = point(), end = point()
                path.addQuadCurve(to: end, control: c)
                control = c
                current = end
            case UInt8(ascii: "t"):
                let c = reflect(lastControl, current), end = point()
                path.addQuadCurve(to: end, control: c)
                control = c
                current = end
            case UInt8(ascii: "a"):
                let rx = tokens.number(), ry = tokens.number(), angle = tokens.number()
                let large = tokens.flag(), sweep = tokens.flag()
                let end = point()
                addArc(&path, from: current, to: end, rx: rx, ry: ry, degrees: angle, large: large, sweep: sweep)
                current = end
            case UInt8(ascii: "z"):
                path.closeSubpath()
                current = start
            default:
                return path
            }
            lastControl = control
            if command | 0x20 == UInt8(ascii: "z") { command = 0 }
        }
        return path
    }

    private static func reflect(_ control: CGPoint?, _ current: CGPoint) -> CGPoint {
        guard let control else { return current }
        return CGPoint(x: 2 * current.x - control.x, y: 2 * current.y - control.y)
    }

    /// SVG's endpoint arc as cubic Béziers (SVG 1.1, F.6.5).
    private static func addArc(_ path: inout Path, from p1: CGPoint, to p2: CGPoint, rx: CGFloat, ry: CGFloat,
                               degrees: CGFloat, large: Bool, sweep: Bool) {
        var rx = abs(rx), ry = abs(ry)
        guard rx > 0, ry > 0, p1 != p2 else { path.addLine(to: p2); return }
        let phi = degrees * .pi / 180, cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p1.x - p2.x) / 2, dy = (p1.y - p2.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy, y1 = -sinPhi * dx + cosPhi * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { rx *= lambda.squareRoot(); ry *= lambda.squareRoot() }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        let coef = (large == sweep ? -1 : 1) * max(0, num / den).squareRoot()
        let cxp = coef * rx * y1 / ry, cyp = -coef * ry * x1 / rx
        let cx = cosPhi * cxp - sinPhi * cyp + (p1.x + p2.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (p1.y + p2.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        }
        let theta = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
        var delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }
        func onEllipse(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: cx + cosPhi * rx * x - sinPhi * ry * y, y: cy + sinPhi * rx * x + cosPhi * ry * y)
        }
        let segments = max(1, Int((abs(delta) / (.pi / 2)).rounded(.up)))
        let step = delta / CGFloat(segments)
        let t = 4 / 3 * tan(step / 4)
        var a = theta
        for _ in 0..<segments {
            let b = a + step
            path.addCurve(to: onEllipse(cos(b), sin(b)),
                          control1: onEllipse(cos(a) - t * sin(a), sin(a) + t * cos(a)),
                          control2: onEllipse(cos(b) + t * sin(b), sin(b) - t * cos(b)))
            a = b
        }
    }

    private struct Tokens {
        let bytes: [UInt8]
        var i = 0

        init(_ bytes: [UInt8]) { self.bytes = bytes }

        mutating func skip() {
            while i < bytes.count, bytes[i] == 0x20 || bytes[i] == 0x2c || bytes[i] == 0x0a || bytes[i] == 0x09 || bytes[i] == 0x0d { i += 1 }
        }

        mutating func command() -> UInt8? {
            skip()
            guard i < bytes.count else { return nil }
            let c = bytes[i]
            guard (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a), c != UInt8(ascii: "e"), c != UInt8(ascii: "E") else { return nil }
            i += 1
            return c
        }

        mutating func hasNumber() -> Bool {
            skip()
            guard i < bytes.count else { return false }
            let c = bytes[i]
            return c == UInt8(ascii: "-") || c == UInt8(ascii: "+") || c == UInt8(ascii: ".") || (c >= 0x30 && c <= 0x39)
        }

        mutating func flag() -> Bool {
            skip()
            guard i < bytes.count else { return false }
            defer { i += 1 }
            return bytes[i] == UInt8(ascii: "1")
        }

        mutating func number() -> CGFloat {
            skip()
            let begin = i
            if i < bytes.count, bytes[i] == UInt8(ascii: "-") || bytes[i] == UInt8(ascii: "+") { i += 1 }
            var dot = false
            while i < bytes.count {
                let c = bytes[i]
                if c >= 0x30 && c <= 0x39 { i += 1 }
                else if c == UInt8(ascii: "."), !dot { dot = true; i += 1 }
                else { break }
            }
            if i < bytes.count, bytes[i] == UInt8(ascii: "e") || bytes[i] == UInt8(ascii: "E") {
                i += 1
                if i < bytes.count, bytes[i] == UInt8(ascii: "-") || bytes[i] == UInt8(ascii: "+") { i += 1 }
                while i < bytes.count, bytes[i] >= 0x30 && bytes[i] <= 0x39 { i += 1 }
            }
            return CGFloat(Double(String(decoding: bytes[begin..<i], as: UTF8.self)) ?? 0)
        }
    }
}
