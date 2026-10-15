import UIKit
import WebKit

/// Pythonista-style extra keys that are part of the keyboard: a UIInputView
/// with the keyboard's own material, installed as the inputAccessoryView of
/// WKWebView's content view. It also replaces the default prev/next/done bar.
///
/// The web app tells us which kind of field has focus (`keyboard.mode`):
/// "code" (editor) and "console" (>>>, input()) show the keys and get plain
/// keyboard traits (no capitalization, autocorrect or smart punctuation);
/// "plain" (file search, UI apps) shows nothing and keeps the element's traits.
@MainActor
final class KeyboardAccessory: NSObject, UIInputViewAudioFeedback {
    /// code: the editor (keys + code actions), console: >>> and input() (keys), plain: anything else.
    enum Mode: String { case code, console, plain }

    struct Key {
        let label: String
        let action: String  // "insert:<text>:<cursor>" or a command name
        var alternate: String? = nil  // long-press action
        var symbol: String? = nil  // SF Symbol instead of a label
    }

    static let keys: [Key] = [
        Key(label: "⇥", action: "indent", alternate: "dedent", symbol: "arrow.right.to.line"),
        Key(label: "undo", action: "undo", alternate: "redo", symbol: "arrow.uturn.backward"),
        Key(label: "(", action: "insert:():1", alternate: "insert:)"),
        Key(label: ")", action: "insert:)"),
        Key(label: "[", action: "insert:[]:1", alternate: "insert:]"),
        Key(label: "]", action: "insert:]"),
        Key(label: "{", action: "insert:{}:1", alternate: "insert:}"),
        Key(label: "}", action: "insert:}"),
        Key(label: ":", action: "insert::"),
        Key(label: "=", action: "insert:=", alternate: "insert:=="),
        Key(label: "\"", action: "insert:\"\":1", alternate: "insert:'':1"),
        Key(label: "'", action: "insert:'':1", alternate: "insert:\"\"\"\"\"\":3"),
        Key(label: "_", action: "insert:_", alternate: "insert:__"),
        Key(label: ".", action: "insert:."),
        Key(label: ",", action: "insert:, "),
        Key(label: "#", action: "insert:# ", alternate: "comment"),
        Key(label: "+", action: "insert:+", alternate: "insert:+="),
        Key(label: "-", action: "insert:-", alternate: "insert:-="),
        Key(label: "*", action: "insert:*", alternate: "insert:**"),
        Key(label: "/", action: "insert:/", alternate: "insert://"),
        Key(label: "<", action: "insert:<", alternate: "insert:<="),
        Key(label: ">", action: "insert:>", alternate: "insert:>="),
        Key(label: "!", action: "insert:!", alternate: "insert:!="),
        Key(label: "%", action: "insert:%"),
        Key(label: "←", action: "left", symbol: "arrow.left"),
        Key(label: "→", action: "right", symbol: "arrow.right"),
    ]

    static let shared = KeyboardAccessory()
    weak var webView: WKWebView?
    private(set) var mode: Mode = .plain
    private lazy var codeBar: UIInputView = makeBar()

    var enableInputClicksWhenVisible: Bool { true }

    /// What WKContentView's inputAccessoryView returns.
    var currentView: UIView? { mode == .plain ? nil : codeBar }

    func setMode(_ mode: Mode) {
        guard mode != self.mode else { return }
        self.mode = mode
        contentView?.reloadInputViews()
    }

    /// Self-test hook: type like the software keyboard does, one character at
    /// a time. "keyboard" goes through UIKeyboardImpl (the keyboard's own
    /// input handling: shift, autocorrection, prediction), "insert" calls
    /// UIKeyInput.insertText on WKContentView directly.
    func typeForTesting(_ text: String, via: String) async -> String {
        guard let content = contentView else { return "no content view" }
        var notes = [content.isFirstResponder ? "first responder" : "NOT first responder"]
        if !content.isFirstResponder {
            // What a tap on the field does: the content view takes the keyboard.
            notes.append(content.becomeFirstResponder() ? "became first responder" : "could not become first responder")
            try? await Task.sleep(nanoseconds: 700_000_000)
        }
        let impl: NSObject? = {
            guard via == "keyboard", let cls = NSClassFromString("UIKeyboardImpl") as? NSObject.Type else { return nil }
            let sel = NSSelectorFromString("activeInstance")
            guard cls.responds(to: sel) else { return nil }
            return cls.perform(sel)?.takeUnretainedValue() as? NSObject
        }()
        if via == "keyboard" { notes.append(impl == nil ? "no UIKeyboardImpl" : "UIKeyboardImpl") }
        // The traits the keyboard sees (BrowserEngineKit or legacy).
        for name in ["extendedTraitsDelegate", "textInputTraits"] {
            let sel = NSSelectorFromString(name)
            guard content.responds(to: sel), let traits = content.perform(sel)?.takeUnretainedValue() as? NSObject else { continue }
            let get = { (key: String) in (traits.value(forKey: key) as? Int).map(String.init) ?? "?" }
            notes.append("traits(\(name)) autocap=\(get("autocapitalizationType")) autocorrect=\(get("autocorrectionType")) quotes=\(get("smartQuotesType"))")
            break
        }
        for ch in text {
            if let impl, impl.responds(to: NSSelectorFromString("addInputString:")) {
                impl.perform(NSSelectorFromString("addInputString:"), with: String(ch))
            } else if let input = content as? UIKeyInput {
                input.insertText(String(ch))
            }
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
        return notes.joined(separator: ", ")
    }

    // MARK: installing

    private var contentView: UIView? {
        webView?.scrollView.subviews.first { NSStringFromClass(type(of: $0)).hasPrefix("WKContent") }
    }

    /// Swap WKContentView's class for a subclass whose inputAccessoryView is ours.
    func install(on webView: WKWebView) {
        self.webView = webView
        guard let content = contentView else { return }
        Self.allowProgrammaticFocus(contentClass: object_getClass(content)!)
        let base: AnyClass = object_getClass(content)!
        // install runs again after each navigation: the view may already be ours
        // (subclassing it again would chain every override twice).
        if NSStringFromClass(base).hasSuffix("_PyslopAccessory") { return }
        let name = "\(NSStringFromClass(base))_PyslopAccessory"
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let created = objc_allocateClassPair(base, name, 0) {
            let block: @convention(block) (AnyObject) -> UIView? = { _ in
                MainActor.assumeIsolated { KeyboardAccessory.shared.currentView }
            }
            let selector = #selector(getter: UIResponder.inputAccessoryView)
            class_addMethod(created, selector, imp_implementationWithBlock(block), "@@:")
            Self.addPlainTraits(to: created, base: base)
            objc_registerClassPair(created)
            subclass = created
        }
        if let subclass { object_setClass(content, subclass) }
    }

    /// Code fields (editor, >>>, input()) get no auto-capitalization, autocorrection,
    /// spell checking or smart punctuation, whatever WebKit derived from the
    /// element: WKContentView builds the keyboard traits in _updateTextInputTraits:
    /// (legacy and BrowserEngineKit traits alike), so we adjust them after it.
    private static func addPlainTraits(to subclass: AnyClass, base: AnyClass) {
        let selector = sel_getUid("_updateTextInputTraits:")
        guard let method = class_getInstanceMethod(base, selector) else {
            WebHost.appendDocument(".probe-log.txt", "[keyboard] _updateTextInputTraits: not found\n")
            return
        }
        typealias Original = @convention(c) (AnyObject, Selector, AnyObject) -> Void
        let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
        let block: @convention(block) (AnyObject, AnyObject) -> Void = { me, traits in
            original(me, selector, traits)
            guard MainActor.assumeIsolated({ KeyboardAccessory.shared.mode != .plain }), let traits = traits as? NSObject else { return }
            let values: [(String, Int)] = [
                ("autocapitalizationType", UITextAutocapitalizationType.none.rawValue),
                ("autocorrectionType", UITextAutocorrectionType.no.rawValue),
                ("spellCheckingType", UITextSpellCheckingType.no.rawValue),
                ("smartQuotesType", UITextSmartQuotesType.no.rawValue),
                ("smartDashesType", UITextSmartDashesType.no.rawValue),
                ("smartInsertDeleteType", UITextSmartInsertDeleteType.no.rawValue),
            ]
            for (key, value) in values {
                let setter = sel_getUid("set\(key.prefix(1).uppercased())\(key.dropFirst()):")
                guard traits.responds(to: setter) else { continue }
                // Only write a changed value: setting a trait can make UIKit ask for
                // the traits again, which must not turn into a loop.
                if (traits.value(forKey: key) as? Int) != value { traits.setValue(value, forKey: key) }
            }
        }
        class_addMethod(subclass, selector, imp_implementationWithBlock(block), method_getTypeEncoding(method))
    }

    /// Let element.focus() from JavaScript show the keyboard without a tap (for
    /// input() and new files), like Capacitor's keyboardDisplayRequiresUserAction.
    private static var focusPatched = false
    private static func allowProgrammaticFocus(contentClass: AnyClass) {
        guard !focusPatched else { return }
        let selector = sel_getUid("_elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:")
        guard let method = class_getInstanceMethod(contentClass, selector) else {
            // Log candidates so a WebKit change is easy to diagnose.
            var count: UInt32 = 0
            let names = (class_copyMethodList(contentClass, &count).map { list in
                (0..<Int(count)).map { NSStringFromSelector(method_getName(list[$0])) }
            } ?? []).filter { $0.contains("lementDidFocus") }
            WebHost.appendDocument(".probe-log.txt", "[keyboard] focus selector not found; candidates: \(names)\n")
            return
        }
        WebHost.appendDocument(".probe-log.txt", "[keyboard] programmatic focus enabled\n")
        focusPatched = true
        // WebKit: _elementDidFocus:(const FocusedElementInformation&) userIsInteracting:(BOOL)
        //   blurPreviousNode:(BOOL) activityStateChanges:(OptionSet<ActivityState>) userObject:(id)
        // The option set is forwarded untouched as a full register.
        typealias Original = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer?, Bool, Bool, UInt64, AnyObject?) -> Void
        let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
        let block: @convention(block) (AnyObject, UnsafeMutableRawPointer?, Bool, Bool, UInt64, AnyObject?) -> Void = { me, node, _, blur, changes, user in
            original(me, selector, node, true, blur, changes, user)
        }
        method_setImplementation(method, imp_implementationWithBlock(block))
    }

    // MARK: the bar

    /// Launch hook (`focus`): what a tap on the editor does, so screenshots
    /// can show the keyboard.
    @discardableResult
    func focusForTesting() -> Bool {
        guard let content = contentView else { return false }
        if content.isFirstResponder { return true }
        let ok = content.becomeFirstResponder()
        WebHost.appendDocument(".probe-log.txt", "[keyboard] focus hook: \(ok ? "first responder" : "could not become first responder")\n")
        return ok
    }

    private func makeBar() -> UIInputView {
        // A transparent input view holding two glass platters (iOS 26 style):
        // the scrolling keys and the dismiss button. Above the software keyboard
        // they float over the app like the system's bars; alone at the bottom of
        // the screen (hardware keyboard, undocked keyboard) the bar grows by the
        // bottom safe area so nothing sits under the home indicator or corners.
        let bar = AccessoryBar(frame: CGRect(x: 0, y: 0, width: 0, height: Self.barHeight), inputViewStyle: .default)
        bar.allowsSelfSizing = true
        bar.backgroundColor = .clear

        let keys = Self.glass()
        let dismiss = Self.glass()
        bar.addSubview(keys)
        bar.addSubview(dismiss)

        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        scroll.delaysContentTouches = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        keys.contentView.addSubview(scroll)

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        for (index, key) in Self.keys.enumerated() {
            stack.addArrangedSubview(makeKey(key, tag: index))
        }
        scroll.addSubview(stack)

        let hide = makeKey(Key(label: "Hide Keyboard", action: "dismiss", symbol: "keyboard.chevron.compact.down"), tag: -1)
        hide.translatesAutoresizingMaskIntoConstraints = false
        dismiss.contentView.addSubview(hide)

        let platter = Self.barHeight - 2 * Self.margin
        let inner: CGFloat = 4
        NSLayoutConstraint.activate([
            keys.heightAnchor.constraint(equalToConstant: platter),
            keys.topAnchor.constraint(equalTo: bar.topAnchor, constant: Self.margin),
            keys.leadingAnchor.constraint(equalTo: bar.safeAreaLayoutGuide.leadingAnchor, constant: Self.margin),
            keys.trailingAnchor.constraint(equalTo: dismiss.leadingAnchor, constant: -Self.margin),
            dismiss.trailingAnchor.constraint(equalTo: bar.safeAreaLayoutGuide.trailingAnchor, constant: -Self.margin),
            dismiss.topAnchor.constraint(equalTo: keys.topAnchor),
            dismiss.heightAnchor.constraint(equalToConstant: platter),
            dismiss.widthAnchor.constraint(equalToConstant: platter),

            scroll.leadingAnchor.constraint(equalTo: keys.contentView.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: keys.contentView.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: keys.contentView.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: keys.contentView.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: inner + 4),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -inner - 4),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: inner),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -inner),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor, constant: -2 * inner),

            hide.topAnchor.constraint(equalTo: dismiss.contentView.topAnchor, constant: inner),
            hide.bottomAnchor.constraint(equalTo: dismiss.contentView.bottomAnchor, constant: -inner),
            hide.leadingAnchor.constraint(equalTo: dismiss.contentView.leadingAnchor, constant: inner),
            hide.trailingAnchor.constraint(equalTo: dismiss.contentView.trailingAnchor, constant: -inner),
        ])
        return bar
    }

    fileprivate static let barHeight: CGFloat = 60
    private static let margin: CGFloat = 6

    private static func glass() -> UIVisualEffectView {
        let effect = UIGlassEffect()
        effect.isInteractive = true
        let view = UIVisualEffectView(effect: effect)
        view.cornerConfiguration = .capsule()
        view.translatesAutoresizingMaskIntoConstraints = false
        return view
    }

    private static let pressed = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.18) : UIColor(white: 0, alpha: 0.1) }

    private func makeKey(_ key: Key, tag: Int) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8)
        config.baseForegroundColor = .label
        config.cornerStyle = .capsule
        if let symbol = key.symbol {
            config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular))
        } else {
            var title = AttributedString(key.label)
            title.font = UIFont.monospacedSystemFont(ofSize: 19, weight: .regular)
            config.attributedTitle = title
        }
        let button = UIButton(configuration: config)
        button.tag = tag
        // Our own pressed state (the plain style would only dim the glyph).
        button.configurationUpdateHandler = { button in
            var config = button.configuration
            config?.background.backgroundColor = button.isHighlighted ? Self.pressed : .clear
            button.configuration = config
        }
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 38).isActive = true
        button.accessibilityLabel = key.label
        button.addTarget(self, action: #selector(keyDown(_:)), for: .touchDown)
        button.addTarget(self, action: #selector(keyUp(_:)), for: .touchUpInside)
        // Scrolling the bar cancels the touch: no key.
        button.addTarget(self, action: #selector(keyCancel(_:)), for: [.touchUpOutside, .touchCancel])
        if key.alternate != nil {
            // A long press does more: a small dot in the corner, inside the key.
            let dot = UIView()
            dot.isUserInteractionEnabled = false
            dot.backgroundColor = .tertiaryLabel
            dot.layer.cornerRadius = 1.5
            dot.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(dot)
            NSLayoutConstraint.activate([
                dot.widthAnchor.constraint(equalToConstant: 3), dot.heightAnchor.constraint(equalToConstant: 3),
                dot.topAnchor.constraint(equalTo: button.topAnchor, constant: 5),
                dot.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -5),
            ])
            let press = UILongPressGestureRecognizer(target: self, action: #selector(longPress(_:)))
            press.minimumPressDuration = 0.35
            button.addGestureRecognizer(press)
        }
        return button
    }

    // MARK: actions

    private var longPressed = Set<Int>()

    @objc private func keyDown(_ sender: UIButton) {
        UIDevice.current.playInputClick()
    }

    @objc private func keyCancel(_ sender: UIButton) {
        longPressed.remove(sender.tag)
    }

    @objc private func keyUp(_ sender: UIButton) {
        if longPressed.remove(sender.tag) != nil { return }
        if sender.tag == -1 {
            send("dismiss")
        } else if Self.keys.indices.contains(sender.tag) {
            send(Self.keys[sender.tag].action)
        }
    }

    @objc private func longPress(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, let button = gesture.view as? UIButton,
              Self.keys.indices.contains(button.tag), let alternate = Self.keys[button.tag].alternate else { return }
        longPressed.insert(button.tag)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        send(alternate)
    }

    private func send(_ action: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [action]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__pyslopKey?.(\(json)[0])")
    }
}

/// The bar's height: the keys, plus the screen's bottom safe area when the bar
/// sits alone at the bottom of the screen (hardware keyboard, undocked
/// keyboard). The input accessory's own safe area is always zero there, so it
/// would end up under the home indicator and the rounded corners.
private final class AccessoryBar: UIInputView {
    private var bottomInset: CGFloat = 0

    override init(frame: CGRect, inputViewStyle: UIInputView.Style) {
        super.init(frame: frame, inputViewStyle: inputViewStyle)
        // The keyboard moves the bar without laying it out again.
        for name in [UIResponder.keyboardDidShowNotification, UIResponder.keyboardDidHideNotification,
                     UIResponder.keyboardDidChangeFrameNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(update), name: name, object: nil)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: KeyboardAccessory.barHeight + bottomInset)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        update()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        update()
    }

    @objc private func update() {
        guard let window, bounds.height > 0 else { return }
        let frame = convert(bounds, to: window)
        // Off screen (before the keyboard animates it in) says nothing.
        guard frame.minY < window.bounds.maxY else { return }
        let atBottom = frame.maxY >= window.bounds.maxY - 1
        let screenInset = window.windowScene?.windows.map(\.safeAreaInsets.bottom).max() ?? 0
        let inset = atBottom ? max(safeAreaInsets.bottom, screenInset) : 0
        guard inset != bottomInset else { return }
        bottomInset = inset
        invalidateIntrinsicContentSize()
        // The keyboard host measured the bar once, into a height constraint of
        // its own; it does not measure again while the bar stays installed.
        for constraint in constraints where constraint.identifier == "_UIKBAutolayoutHeightConstraint" {
            constraint.constant = KeyboardAccessory.barHeight + inset
        }
    }
}
