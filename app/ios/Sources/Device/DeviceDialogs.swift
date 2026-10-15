import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Dialogs and console services for the device modules (D40): alerts, text
/// input, the HUD and spinner, Quick Look, the share sheet, the document
/// picker, and the `dialogs` module's sheets (list, edit list, form, text,
/// date).
@MainActor
final class DeviceDialogs {
    unowned let bridge: DeviceBridge
    private var hud: UIView?
    private var spinner: UIView?

    init(bridge: DeviceBridge) {
        self.bridge = bridge
    }

    func perform(_ op: String, _ v: [String: Any]) async throws -> Any? {
        switch op {
        case "alert": return await alert(v)
        case "input": return await input(v)
        case "hud": await showHUD(v.string("message") ?? "", error: v.string("icon") == "error", duration: v.double("duration") ?? 1.8); return nil
        case "activity": setSpinner(v.bool("show") ?? false); return nil
        case "console.clear": await bridge.model?.command("clear"); return nil
        case "console.hide":
            if let model = bridge.model { if model.wide { model.consoleDocked = false } else { model.consoleDetent = .peek } }
            return nil
        case "quicklook": return try await quickLook((v["files"] as? [Any] ?? []).map { try bridge.fileURL($0, mount: v.mount) })
        case "share": return try await share(v["items"] as? [[String: Any]] ?? [], mount: v.mount)
        case "pickDocument": return await pickDocument(v["types"] as? [String] ?? ["public.data"])
        case "list": return await sheet { ListDialog(title: v.string("title") ?? "", items: v["items"] as? [String] ?? [], multiple: v.bool("multiple") ?? false, done: $0) }
        case "editList": return await sheet { EditListDialog(title: v.string("title") ?? "", items: v["items"] as? [String] ?? [], move: v.bool("move") ?? true, delete: v.bool("delete") ?? true, done: $0) }
        case "form": return await sheet { FormDialog(title: v.string("title") ?? "", sections: FormDialog.parse(v["sections"]), done: $0) }
        case "text": return await sheet { TextDialog(title: v.string("title") ?? "", text: v.string("text") ?? "", size: v.double("size") ?? 16, monospaced: v.bool("monospaced") ?? false, done: $0) }
        case "date": return await sheet(detents: true) { DateDialog(title: v.string("title") ?? "", mode: v.string("mode") ?? "datetime", done: $0) }
        case "openURL": return await bridge.openURL(v.string("url") ?? "")
        case "idleTimer": UIApplication.shared.isIdleTimerDisabled = v.bool("disabled") ?? false; return nil
        case "background": return UIApplication.shared.applicationState != .active
        default: throw DeviceBridge.Failure(kind: "NotImplementedError", message: "device.\(op)")
        }
    }

    func programEnded() {
        setSpinner(false)
    }

    // MARK: alerts

    private func alert(_ v: [String: Any]) async -> Any? {
        await bridge.modal { finish in
            let a = UIAlertController(title: v.string("title"), message: (v.string("message") ?? "").isEmpty ? nil : v.string("message"), preferredStyle: .alert)
            for (i, title) in (v["buttons"] as? [String] ?? ["OK"]).enumerated() {
                a.addAction(UIAlertAction(title: title, style: .default) { _ in finish(i + 1) })
            }
            if v.bool("cancel") ?? true { a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in finish(nil) }) }
            return a
        }
    }

    private func input(_ v: [String: Any]) async -> Any? {
        let fields = v["fields"] as? [[String: Any]] ?? [[:]]
        return await bridge.modal { finish in
            let a = UIAlertController(title: v.string("title"), message: (v.string("message") ?? "").isEmpty ? nil : v.string("message"), preferredStyle: .alert)
            for f in fields {
                a.addTextField { field in
                    field.text = f.string("text")
                    field.placeholder = f.string("placeholder")
                    field.isSecureTextEntry = f.bool("secure") ?? false
                    field.autocapitalizationType = .none
                    field.autocorrectionType = .no
                }
            }
            if v.bool("cancel") ?? true { a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in finish(nil) }) }
            let ok = UIAlertAction(title: v.string("ok") ?? "OK", style: .default) { [weak a] _ in
                finish((a?.textFields ?? []).map { $0.text ?? "" })
            }
            a.addAction(ok)
            a.preferredAction = ok
            return a
        }
    }

    // MARK: HUD and spinner

    private var window: UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
    }

    private func showHUD(_ message: String, error: Bool, duration: Double) async {
        hud?.removeFromSuperview()
        guard let window else { return }
        let content = UIHostingController(rootView: HUDView(message: message, error: error)).view!
        content.backgroundColor = .clear
        content.translatesAutoresizingMaskIntoConstraints = false
        content.isUserInteractionEnabled = false
        window.addSubview(content)
        NSLayoutConstraint.activate([content.centerXAnchor.constraint(equalTo: window.centerXAnchor), content.centerYAnchor.constraint(equalTo: window.centerYAnchor)])
        content.alpha = 0
        hud = content
        UIView.animate(withDuration: 0.15) { content.alpha = 1 }
        try? await Task.sleep(for: .seconds(duration))
        UIView.animate(withDuration: 0.2, animations: { content.alpha = 0 }) { _ in content.removeFromSuperview() }
        if hud === content { hud = nil }
    }

    private func setSpinner(_ show: Bool) {
        if !show {
            spinner?.removeFromSuperview()
            spinner = nil
            return
        }
        guard spinner == nil, let window else { return }
        let view = UIHostingController(rootView: SpinnerView()).view!
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        view.translatesAutoresizingMaskIntoConstraints = false
        window.addSubview(view)
        NSLayoutConstraint.activate([view.centerXAnchor.constraint(equalTo: window.centerXAnchor), view.topAnchor.constraint(equalTo: window.safeAreaLayoutGuide.topAnchor, constant: 4)])
        spinner = view
    }

    // MARK: Quick Look, sharing, documents

    private func quickLook(_ urls: [URL]) async throws -> Any? {
        guard !urls.isEmpty else { return nil }
        let source = PreviewSource(urls: urls)
        _ = await bridge.modal { finish in
            let ql = QLPreviewController()
            ql.dataSource = source
            source.onDismiss = { finish(nil) }
            ql.delegate = source
            objc_setAssociatedObject(ql, &PreviewSource.key, source, .OBJC_ASSOCIATION_RETAIN)
            return ql
        }
        return nil
    }

    private func share(_ items: [[String: Any]], mount: String?) async throws -> Any? {
        var things: [Any] = []
        for item in items {
            if let text = item.string("text") { things.append(text) }
            if let url = item.string("url").flatMap(URL.init(string:)) { things.append(url) }
            if let b64 = item.string("image"), let data = Data(base64Encoded: b64), let image = UIImage(data: data) { things.append(image) }
            if let file = item["file"] { things.append(try bridge.fileURL(file, mount: mount)) }
        }
        return await bridge.modal { finish in
            let vc = UIActivityViewController(activityItems: things, applicationActivities: nil)
            vc.completionWithItemsHandler = { type, completed, _, _ in finish(completed ? type?.rawValue : nil) }
            return vc
        }
    }

    private func pickDocument(_ types: [String]) async -> Any? {
        let delegate = DocumentPickerDelegate()
        return await bridge.modal { finish in
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types.compactMap { UTType($0) }.nonEmpty ?? [.data], asCopy: true)
            delegate.onPick = { url in
                guard let url, let data = try? Data(contentsOf: url) else { return finish(nil) }
                finish(["data": data.base64EncodedString(), "name": url.lastPathComponent])
            }
            picker.delegate = delegate
            objc_setAssociatedObject(picker, &DocumentPickerDelegate.key, delegate, .OBJC_ASSOCIATION_RETAIN)
            return picker
        }
    }

    // MARK: SwiftUI sheets

    private func sheet<V: View>(detents: Bool = false, _ make: (@escaping (Any?) -> Void) -> V) async -> Any? {
        await bridge.modal { finish in
            let host = UIHostingController(rootView: make(finish))
            if detents, let sheet = host.sheetPresentationController { sheet.detents = [.medium(), .large()] }
            return host
        }
    }
}

private extension Array {
    var nonEmpty: Self? { isEmpty ? nil : self }
}

final class PreviewSource: NSObject, @preconcurrency QLPreviewControllerDataSource, @preconcurrency QLPreviewControllerDelegate {
    nonisolated(unsafe) static var key: UInt8 = 0
    let urls: [URL]
    var onDismiss: () -> Void = {}
    init(urls: [URL]) { self.urls = urls }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { urls.count }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { urls[index] as NSURL }
    func previewControllerDidDismiss(_ controller: QLPreviewController) { onDismiss() }
}

final class DocumentPickerDelegate: NSObject, UIDocumentPickerDelegate {
    nonisolated(unsafe) static var key: UInt8 = 0
    var onPick: (URL?) -> Void = { _ in }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { onPick(urls.first) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onPick(nil) }
}

// MARK: - views

private struct HUDView: View {
    let message: String
    let error: Bool

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: error ? "xmark" : "checkmark").font(.system(size: 34, weight: .semibold))
            if !message.isEmpty { Text(message).font(.headline).multilineTextAlignment(.center) }
        }
        .padding(22)
        .frame(minWidth: 130, minHeight: 110)
        .frame(maxWidth: 260)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct SpinnerView: View {
    var body: some View {
        ProgressView().padding(10).background(.regularMaterial, in: Capsule())
    }
}

/// Toolbar with Cancel and an optional Done.
private struct DialogChrome: ViewModifier {
    let title: String
    let cancel: () -> Void
    let done: (() -> Void)?

    func body(content: Content) -> some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                    if let done { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done).fontWeight(.semibold) } }
                }
        }
    }
}

private struct ListDialog: View {
    let title: String
    let items: [String]
    let multiple: Bool
    let done: (Any?) -> Void
    @State private var selected = Set<Int>()

    var body: some View {
        List(items.indices, id: \.self) { i in
            Button {
                if multiple {
                    if selected.contains(i) { selected.remove(i) } else { selected.insert(i) }
                } else {
                    done([i])
                }
            } label: {
                HStack {
                    Text(items[i]).foregroundStyle(.primary)
                    Spacer()
                    if selected.contains(i) { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                }
            }
        }
        .modifier(DialogChrome(title: title, cancel: { done(nil) }, done: multiple ? { done(selected.sorted()) } : nil))
    }
}

private struct EditListDialog: View {
    let title: String
    let items: [String]
    let move: Bool
    let delete: Bool
    let done: (Any?) -> Void
    @State private var order: [Int] = []

    var body: some View {
        List {
            ForEach(order, id: \.self) { i in Text(items[i]) }
                .onMove(perform: move ? { order.move(fromOffsets: $0, toOffset: $1) } : nil)
                .onDelete(perform: delete ? { order.remove(atOffsets: $0) } : nil)
        }
        .environment(\.editMode, .constant(.active))
        .onAppear { if order.isEmpty { order = Array(items.indices) } }
        .modifier(DialogChrome(title: title, cancel: { done(nil) }, done: { done(order) }))
    }
}

private struct TextDialog: View {
    let title: String
    @State var text: String
    let size: Double
    let monospaced: Bool
    let done: (Any?) -> Void
    @FocusState private var focused: Bool

    init(title: String, text: String, size: Double, monospaced: Bool, done: @escaping (Any?) -> Void) {
        self.title = title
        _text = State(initialValue: text)
        self.size = size
        self.monospaced = monospaced
        self.done = done
    }

    var body: some View {
        TextEditor(text: $text)
            .font(.system(size: size, design: monospaced ? .monospaced : .default))
            .focused($focused)
            .padding(.horizontal, 8)
            .onAppear { focused = true }
            .modifier(DialogChrome(title: title, cancel: { done(nil) }, done: { done(text) }))
    }
}

private struct DateDialog: View {
    let title: String
    let mode: String
    let done: (Any?) -> Void
    @State private var date = Date()
    @State private var hours = 0
    @State private var minutes = 5

    var body: some View {
        Form {
            if mode == "duration" {
                HStack {
                    Picker("Hours", selection: $hours) { ForEach(0..<24, id: \.self) { Text("\($0) h").tag($0) } }
                    Picker("Minutes", selection: $minutes) { ForEach(0..<60, id: \.self) { Text("\($0) min").tag($0) } }
                }
                .pickerStyle(.wheel)
            } else if mode == "time" {
                DatePicker(title.isEmpty ? "Time" : title, selection: $date, displayedComponents: [.hourAndMinute])
                    .datePickerStyle(.wheel)
                    .labelsHidden()
            } else {
                DatePicker(title.isEmpty ? "Date" : title, selection: $date, displayedComponents: mode == "date" ? [.date] : [.date, .hourAndMinute])
                    .datePickerStyle(.graphical)
                    .labelsHidden()
            }
        }
        .modifier(DialogChrome(title: title, cancel: { done(nil) }, done: {
            if mode == "duration" { done(Double(hours * 3600 + minutes * 60)) }
            else if mode == "date" { done(ISODate.format(Calendar.current.startOfDay(for: date))) }
            else { done(ISODate.format(date)) }
        }))
    }
}

struct FormDialog: View {
    struct Field: Identifiable {
        let id: String // key
        let type: String
        let title: String
        let placeholder: String
        let initial: Any?
    }

    struct Section: Identifiable {
        let id: Int
        let title: String
        let footer: String
        let fields: [Field]
    }

    let title: String
    let sections: [Section]
    let done: (Any?) -> Void
    @State private var texts: [String: String] = [:]
    @State private var flags: [String: Bool] = [:]
    @State private var dates: [String: Date] = [:]

    static func parse(_ any: Any?) -> [Section] {
        (any as? [[String: Any]] ?? []).enumerated().map { i, s in
            Section(id: i, title: s.string("title") ?? "", footer: s.string("footer") ?? "",
                    fields: (s["fields"] as? [[String: Any]] ?? []).map {
                        Field(id: $0.string("key") ?? UUID().uuidString, type: $0.string("type") ?? "text", title: $0.string("title") ?? "",
                              placeholder: $0.string("placeholder") ?? "", initial: $0["value"])
                    })
        }
    }

    var body: some View {
        Form {
            ForEach(sections) { section in
                SwiftUI.Section {
                    ForEach(section.fields) { field($0) }
                } header: {
                    if !section.title.isEmpty { Text(section.title) }
                } footer: {
                    if !section.footer.isEmpty { Text(section.footer) }
                }
            }
        }
        .onAppear(perform: load)
        .modifier(DialogChrome(title: title, cancel: { done(nil) }, done: { done(values()) }))
    }

    @ViewBuilder
    private func field(_ f: Field) -> some View {
        switch f.type {
        case "switch":
            Toggle(f.title, isOn: Binding(get: { flags[f.id] ?? false }, set: { flags[f.id] = $0 }))
        case "check":
            Button { flags[f.id] = !(flags[f.id] ?? false) } label: {
                HStack {
                    Text(f.title).foregroundStyle(.primary)
                    Spacer()
                    if flags[f.id] == true { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                }
            }
        case "date", "time", "datetime":
            DatePicker(f.title, selection: Binding(get: { dates[f.id] ?? Date() }, set: { dates[f.id] = $0 }),
                       displayedComponents: f.type == "date" ? [.date] : f.type == "time" ? [.hourAndMinute] : [.date, .hourAndMinute])
        default:
            let text = Binding(get: { texts[f.id] ?? "" }, set: { texts[f.id] = $0 })
            HStack {
                if !f.title.isEmpty { Text(f.title) }
                Group {
                    if f.type == "password" { SecureField(f.placeholder, text: text) } else { TextField(f.placeholder, text: text) }
                }
                .multilineTextAlignment(f.title.isEmpty ? .leading : .trailing)
                .textInputAutocapitalization(f.type == "text" ? .sentences : .never)
                .autocorrectionDisabled(f.type != "text")
                .keyboardType(f.type == "email" ? .emailAddress : f.type == "url" ? .URL : f.type == "number" ? .decimalPad : .default)
            }
        }
    }

    private func load() {
        for f in sections.flatMap(\.fields) {
            switch f.type {
            case "switch", "check": flags[f.id] = (f.initial as? NSNumber)?.boolValue ?? false
            case "date", "time", "datetime": dates[f.id] = ISODate.parse(f.initial as? String) ?? Date()
            default: texts[f.id] = (f.initial as? String) ?? (f.initial as? NSNumber)?.stringValue ?? ""
            }
        }
    }

    private func values() -> [String: Any] {
        var out: [String: Any] = [:]
        for f in sections.flatMap(\.fields) {
            switch f.type {
            case "switch", "check": out[f.id] = flags[f.id] ?? false
            case "date": out[f.id] = ISODate.format(Calendar.current.startOfDay(for: dates[f.id] ?? Date()))
            case "time", "datetime": out[f.id] = ISODate.format(dates[f.id] ?? Date())
            default: out[f.id] = texts[f.id] ?? ""
            }
        }
        return out
    }
}
