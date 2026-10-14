import SwiftUI
import UIKit

// Colors, fonts and icons for the native renderer. Values come from ui.py as
// plain strings: "#rrggbb", "rgb(...)", CSS color names, iOS system colors
// (red, orange, ..., gray) and semantic names (primary, secondary, tint, ...).

enum UIColorParser {
    static func uiColor(_ text: String?) -> UIColor? {
        guard var s = text?.trimmingCharacters(in: .whitespaces).lowercased(), !s.isEmpty else { return nil }
        if let c = semantic[s] { return c }
        if s.hasPrefix("#") {
            s.removeFirst()
            return hex(s)
        }
        if s.hasPrefix("rgb") { return rgb(s) }
        if s.hasPrefix("hsl") { return hsl(s) }
        if let v = named[s] { return hex(v) }
        return nil
    }

    static func color(_ text: String?) -> Color? { uiColor(text).map { Color(uiColor: $0) } }

    /// "#rrggbb" for a color picker's value.
    static func hexString(_ color: UIColor) -> String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        let resolved = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
        func byte(_ x: CGFloat) -> Int { Int((max(0, min(1, x)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(r), byte(g), byte(b))
    }

    private static let semantic: [String: UIColor] = [
        "primary": .label, "label": .label, "secondary": .secondaryLabel, "tertiary": .tertiaryLabel,
        "tint": .tintColor, "accent": .tintColor, "background": .systemGroupedBackground,
        "secondary_background": .secondarySystemGroupedBackground, "separator": .separator,
        "fill": .tertiarySystemFill, "clear": .clear, "transparent": .clear,
        "red": .systemRed, "orange": .systemOrange, "yellow": .systemYellow, "green": .systemGreen,
        "mint": .systemMint, "teal": .systemTeal, "cyan": .systemCyan, "blue": .systemBlue,
        "indigo": .systemIndigo, "purple": .systemPurple, "pink": .systemPink, "brown": .systemBrown,
        "gray": .systemGray, "grey": .systemGray,
    ]

    private static func hex(_ s: String) -> UIColor? {
        var chars = Array(s)
        if chars.count == 3 || chars.count == 4 { chars = chars.flatMap { [$0, $0] } }
        guard chars.count == 6 || chars.count == 8, let v = UInt64(String(chars), radix: 16) else { return nil }
        let hasAlpha = chars.count == 8
        let r = CGFloat((v >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let g = CGFloat((v >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let b = CGFloat((v >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let a = hasAlpha ? CGFloat(v & 0xff) / 255 : 1
        return UIColor(red: r, green: g, blue: b, alpha: a)
    }

    /// The numbers in "rgb(1, 2, 3)", "rgba(1 2 3 / 50%)", "hsl(...)".
    private static func components(_ s: String) -> [(Double, Bool)] {
        guard let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")") else { return [] }
        let inner = s[s.index(after: open)..<close]
        return inner.split(whereSeparator: { ", /".contains($0) }).compactMap { part in
            let percent = part.hasSuffix("%")
            let digits = part.trimmingCharacters(in: CharacterSet(charactersIn: "%deg"))
            return Double(digits).map { ($0, percent) }
        }
    }

    private static func alpha(_ c: [(Double, Bool)]) -> CGFloat {
        guard c.count > 3 else { return 1 }
        return CGFloat(c[3].1 ? c[3].0 / 100 : c[3].0)
    }

    private static func rgb(_ s: String) -> UIColor? {
        let c = components(s)
        guard c.count >= 3 else { return nil }
        func ch(_ i: Int) -> CGFloat { CGFloat(c[i].1 ? c[i].0 / 100 : c[i].0 / 255) }
        return UIColor(red: ch(0), green: ch(1), blue: ch(2), alpha: alpha(c))
    }

    private static func hsl(_ s: String) -> UIColor? {
        let c = components(s)
        guard c.count >= 3 else { return nil }
        let h = c[0].0.truncatingRemainder(dividingBy: 360) / 360
        let sat = c[1].0 / 100, l = c[2].0 / 100
        let q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat
        let p = 2 * l - q
        func hue(_ t0: Double) -> CGFloat {
            var t = t0
            if t < 0 { t += 1 }
            if t > 1 { t -= 1 }
            if t < 1 / 6 { return CGFloat(p + (q - p) * 6 * t) }
            if t < 1 / 2 { return CGFloat(q) }
            if t < 2 / 3 { return CGFloat(p + (q - p) * (2 / 3 - t) * 6) }
            return CGFloat(p)
        }
        return UIColor(red: hue(h + 1 / 3), green: hue(h), blue: hue(h - 1 / 3), alpha: alpha(c))
    }

    private static let named: [String: String] = [
        "aliceblue": "f0f8ff", "antiquewhite": "faebd7", "aqua": "00ffff", "aquamarine": "7fffd4", "azure": "f0ffff",
        "beige": "f5f5dc", "bisque": "ffe4c4", "black": "000000", "blanchedalmond": "ffebcd", "blueviolet": "8a2be2",
        "burlywood": "deb887", "cadetblue": "5f9ea0", "chartreuse": "7fff00", "chocolate": "d2691e", "coral": "ff7f50",
        "cornflowerblue": "6495ed", "cornsilk": "fff8dc", "crimson": "dc143c", "darkblue": "00008b", "darkcyan": "008b8b",
        "darkgoldenrod": "b8860b", "darkgray": "a9a9a9", "darkgreen": "006400", "darkgrey": "a9a9a9", "darkkhaki": "bdb76b",
        "darkmagenta": "8b008b", "darkolivegreen": "556b2f", "darkorange": "ff8c00", "darkorchid": "9932cc", "darkred": "8b0000",
        "darksalmon": "e9967a", "darkseagreen": "8fbc8f", "darkslateblue": "483d8b", "darkslategray": "2f4f4f",
        "darkturquoise": "00ced1", "darkviolet": "9400d3", "deeppink": "ff1493", "deepskyblue": "00bfff", "dimgray": "696969",
        "dodgerblue": "1e90ff", "firebrick": "b22222", "floralwhite": "fffaf0", "forestgreen": "228b22", "fuchsia": "ff00ff",
        "gainsboro": "dcdcdc", "ghostwhite": "f8f8ff", "gold": "ffd700", "goldenrod": "daa520", "greenyellow": "adff2f",
        "honeydew": "f0fff0", "hotpink": "ff69b4", "indianred": "cd5c5c", "ivory": "fffff0", "khaki": "f0e68c",
        "lavender": "e6e6fa", "lavenderblush": "fff0f5", "lawngreen": "7cfc00", "lemonchiffon": "fffacd", "lightblue": "add8e6",
        "lightcoral": "f08080", "lightcyan": "e0ffff", "lightgoldenrodyellow": "fafad2", "lightgray": "d3d3d3",
        "lightgreen": "90ee90", "lightgrey": "d3d3d3", "lightpink": "ffb6c1", "lightsalmon": "ffa07a", "lightseagreen": "20b2aa",
        "lightskyblue": "87cefa", "lightslategray": "778899", "lightsteelblue": "b0c4de", "lightyellow": "ffffe0", "lime": "00ff00",
        "limegreen": "32cd32", "linen": "faf0e6", "magenta": "ff00ff", "maroon": "800000", "mediumaquamarine": "66cdaa",
        "mediumblue": "0000cd", "mediumorchid": "ba55d3", "mediumpurple": "9370db", "mediumseagreen": "3cb371",
        "mediumslateblue": "7b68ee", "mediumspringgreen": "00fa9a", "mediumturquoise": "48d1cc", "mediumvioletred": "c71585",
        "midnightblue": "191970", "mintcream": "f5fffa", "mistyrose": "ffe4e1", "moccasin": "ffe4b5", "navajowhite": "ffdead",
        "navy": "000080", "oldlace": "fdf5e6", "olive": "808000", "olivedrab": "6b8e23", "orangered": "ff4500", "orchid": "da70d6",
        "palegoldenrod": "eee8aa", "palegreen": "98fb98", "paleturquoise": "afeeee", "palevioletred": "db7093",
        "papayawhip": "ffefd5", "peachpuff": "ffdab9", "peru": "cd853f", "plum": "dda0dd", "powderblue": "b0e0e6",
        "rebeccapurple": "663399", "rosybrown": "bc8f8f", "royalblue": "4169e1", "saddlebrown": "8b4513", "salmon": "fa8072",
        "sandybrown": "f4a460", "seagreen": "2e8b57", "seashell": "fff5ee", "sienna": "a0522d", "silver": "c0c0c0",
        "skyblue": "87ceeb", "slateblue": "6a5acd", "slategray": "708090", "snow": "fffafa", "springgreen": "00ff7f",
        "steelblue": "4682b4", "tan": "d2b48c", "thistle": "d8bfd8", "tomato": "ff6347", "turquoise": "40e0d0",
        "violet": "ee82ee", "wheat": "f5deb3", "white": "ffffff", "whitesmoke": "f5f5f5", "yellowgreen": "9acd32",
    ]
}

enum UIFonts {
    static func style(_ name: String?) -> Font.TextStyle {
        switch name {
        case "largeTitle": .largeTitle
        case "title": .title
        case "title2": .title2
        case "title3": .title3
        case "headline": .headline
        case "callout": .callout
        case "subheadline": .subheadline
        case "footnote": .footnote
        case "caption": .caption
        case "caption2": .caption2
        default: .body
        }
    }

    static func weight(_ value: Double?) -> Font.Weight? {
        guard let v = value else { return nil }
        switch v {
        case ..<150: return .ultraLight
        case ..<250: return .thin
        case ..<350: return .light
        case ..<450: return .regular
        case ..<550: return .medium
        case ..<650: return .semibold
        case ..<750: return .bold
        case ..<850: return .heavy
        default: return .black
        }
    }
}

enum UIIcons {
    private static let aliases: [String: String] = [
        "gear": "gearshape", "share": "square.and.arrow.up", "info": "info.circle", "search": "magnifyingglass",
        "x": "xmark", "check": "checkmark", "doc": "doc", "photo": "photo", "list": "list.bullet",
        "stop": "stop.fill", "play": "play.fill", "pause": "pause.fill", "location": "location",
    ]

    /// The SF Symbol for a ui.py icon name, or nil for emoji and text.
    static func symbol(_ name: String?) -> String? {
        guard let name, !name.isEmpty else { return nil }
        var base = name
        var fill = false
        if base.hasSuffix(".fill") {
            base.removeLast(5)
            fill = true
        }
        let mapped = aliases[base] ?? base
        let candidates = fill ? ["\(mapped).fill", mapped] : [mapped]
        return candidates.first { UIImage(systemName: $0) != nil }
    }
}

/// An SF Symbol when the name is one, else the name itself (an emoji).
struct IconImage: View {
    let name: String
    var size: Double?

    var body: some View {
        Group {
            if let symbol = UIIcons.symbol(name) {
                Image(systemName: symbol)
            } else {
                Text(name)
            }
        }
        .font(size.map { Font.system(size: CGFloat($0)) })
    }
}
