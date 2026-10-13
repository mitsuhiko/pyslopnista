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
            Coordinator.appendDocument(".probe-log.txt", "[keyboard] _updateTextInputTraits: not found\n")
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
            Coordinator.appendDocument(".probe-log.txt", "[keyboard] focus selector not found; candidates: \(names)\n")
            return
        }
        Coordinator.appendDocument(".probe-log.txt", "[keyboard] programmatic focus enabled\n")
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

    private func makeBar() -> UIInputView {
        let bar = UIInputView(frame: CGRect(x: 0, y: 0, width: 0, height: 52), inputViewStyle: .keyboard)
        bar.allowsSelfSizing = true

        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        for (index, key) in Self.keys.enumerated() {
            stack.addArrangedSubview(makeKey(key, tag: index))
        }

        let dismiss = makeKey(Key(label: "hide", action: "dismiss", symbol: "keyboard.chevron.compact.down"), tag: -1)
        dismiss.translatesAutoresizingMaskIntoConstraints = false

        scroll.addSubview(stack)
        bar.addSubview(scroll)
        bar.addSubview(dismiss)
        NSLayoutConstraint.activate([
            bar.heightAnchor.constraint(equalToConstant: 52),
            scroll.leadingAnchor.constraint(equalTo: bar.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: dismiss.leadingAnchor, constant: -6),
            scroll.topAnchor.constraint(equalTo: bar.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bar.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 7),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -7),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor, constant: -14),
            dismiss.trailingAnchor.constraint(equalTo: bar.safeAreaLayoutGuide.trailingAnchor, constant: -6),
            dismiss.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            dismiss.heightAnchor.constraint(equalToConstant: 38),
        ])
        return bar
    }

    private func makeKey(_ key: Key, tag: Int) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8)
        config.baseForegroundColor = .label
        if let symbol = key.symbol {
            config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .medium))
        } else {
            var title = AttributedString(key.label)
            title.font = UIFont.monospacedSystemFont(ofSize: 20, weight: .regular)
            config.attributedTitle = title
        }
        let button = UIButton(configuration: config)
        button.tag = tag
        button.backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.42, alpha: 1) : .white }
        button.layer.cornerRadius = 8
        button.layer.cornerCurve = .continuous
        button.layer.shadowColor = UIColor.black.cgColor
        button.layer.shadowOpacity = 0.28
        button.layer.shadowOffset = CGSize(width: 0, height: 1)
        button.layer.shadowRadius = 0
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: key.symbol != nil ? 44 : 34).isActive = true
        button.accessibilityLabel = key.label
        button.addTarget(self, action: #selector(keyDown(_:)), for: .touchDown)
        button.addTarget(self, action: #selector(keyUp(_:)), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        if key.alternate != nil {
            let corner = UIView()
            corner.isUserInteractionEnabled = false
            corner.backgroundColor = UIColor.secondaryLabel.withAlphaComponent(0.5)
            corner.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(corner)
            NSLayoutConstraint.activate([
                corner.widthAnchor.constraint(equalToConstant: 6), corner.heightAnchor.constraint(equalToConstant: 6),
                corner.topAnchor.constraint(equalTo: button.topAnchor, constant: 3),
                corner.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -3),
            ])
            let triangle = CAShapeLayer()
            let path = UIBezierPath()
            path.move(to: .zero)
            path.addLine(to: CGPoint(x: 6, y: 0))
            path.addLine(to: CGPoint(x: 6, y: 6))
            path.close()
            triangle.path = path.cgPath
            corner.layer.mask = triangle
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
        sender.backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.55, alpha: 1) : UIColor(white: 0.8, alpha: 1) }
    }

    @objc private func keyUp(_ sender: UIButton) {
        sender.backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.42, alpha: 1) : .white }
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
