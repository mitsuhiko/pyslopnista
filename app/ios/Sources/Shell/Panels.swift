import SwiftUI

// Sheets: find in folder, go to (outline and line), problems, settings.

/// Search the text files of the current folder (and its subfolders).
struct FindView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var caseSensitive = false
    @State private var files: [(path: String, lines: [String])]?
    @FocusState private var focused: Bool

    private static let textFile = try! NSRegularExpression(pattern: #"\.(py|pyi|txt|md|json|toml|csv|tsv|html?|css|js|ts|ya?ml|cfg|ini|xml|svg|sql|sh|rst)$"#, options: .caseInsensitive)

    struct Hit: Identifiable {
        let id: Int
        let path: String
        let line: Int
        let column: Int
        let text: String
    }

    private var dir: String {
        if let file = model.file, !isExternal(file) { return dirname(file) }
        return model.currentDir
    }

    var body: some View {
        NavigationStack {
            List {
                if files == nil {
                    ProgressView().frame(maxWidth: .infinity)
                }
                ForEach(groups, id: \.0) { path, hits in
                    Section {
                        ForEach(hits) { hit in
                            Button {
                                dismiss()
                                Task { await model.openLocation(hit.path, line: hit.line, column: hit.column, keepConsole: true) }
                            } label: {
                                HStack(alignment: .firstTextBaseline, spacing: 10) {
                                    Text("\(hit.line)").font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(minWidth: 28, alignment: .trailing)
                                    Text(preview(hit)).font(.footnote.monospaced()).lineLimit(2)
                                }
                            }
                            .tint(.primary)
                        }
                    } header: {
                        Text(String(path.dropFirst(dir.isEmpty ? 0 : dir.count + 1)))
                    }
                }
            }
            .navigationTitle("Find in \(displayName(dir))")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search")
            .searchFocused($focused)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Toggle(isOn: $caseSensitive) { Text("Aa") }.toggleStyle(.button).accessibilityLabel("Match case")
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                if !query.isEmpty, files != nil {
                    Text(summary).font(.footnote).foregroundStyle(.secondary).padding(8).frame(maxWidth: .infinity).background(.bar)
                }
            }
        }
        .task { await load() }
        .onAppear { focused = true }
    }

    private func load() async {
        await model.saveAll()
        let dir = dir
        let tree = (try? await model.host.onFileQueue { try $0.tree(dir) }) ?? []
        var out: [(String, [String])] = []
        for f in tree {
            guard let rel = f["path"], Self.textFile.firstMatch(in: rel, range: NSRange(location: 0, length: (rel as NSString).length)) != nil,
                  !rel.split(separator: "/").contains(where: { $0.hasPrefix(".") || $0 == "__pycache__" }),
                  let data = f["data"].flatMap({ Data(base64Encoded: $0) }), data.count <= 1_000_000,
                  let text = String(data: data, encoding: .utf8) else { continue }
            out.append((joinPath(dir, rel), text.components(separatedBy: "\n")))
        }
        files = out.sorted { $0.0 < $1.0 }
    }

    private var hits: [Hit] {
        guard let files, !query.isEmpty else { return [] }
        var out: [Hit] = []
        let options: String.CompareOptions = caseSensitive ? [] : [.caseInsensitive]
        for f in files {
            for (i, line) in f.lines.enumerated() {
                var range = line.startIndex..<line.endIndex
                while let r = line.range(of: query, options: options, range: range) {
                    out.append(Hit(id: out.count, path: f.path, line: i + 1, column: line.distance(from: line.startIndex, to: r.lowerBound) + 1, text: line))
                    if out.count >= 500 { return out }
                    range = r.upperBound..<line.endIndex
                    if r.isEmpty { break }
                }
            }
        }
        return out
    }

    private var groups: [(String, [Hit])] {
        var order: [String] = []
        var map: [String: [Hit]] = [:]
        for h in hits {
            if map[h.path] == nil { order.append(h.path) }
            map[h.path, default: []].append(h)
        }
        return order.map { ($0, map[$0]!) }
    }

    private var summary: String {
        let n = hits.count
        let files = groups.count
        if n == 0 { return "No results" }
        return "\(n >= 500 ? "500+" : "\(n)") result\(n == 1 ? "" : "s") in \(files) file\(files == 1 ? "" : "s")"
    }

    private func preview(_ hit: Hit) -> AttributedString {
        let chars = Array(hit.text)
        let start = max(0, hit.column - 1 - 40)
        let before = (start > 0 ? "…" : "") + String(chars[start..<min(chars.count, hit.column - 1)]).trimmingLeadingWhitespace()
        let matchEnd = min(chars.count, hit.column - 1 + query.count)
        let match = String(chars[min(chars.count, hit.column - 1)..<matchEnd])
        let after = String(chars[matchEnd..<min(chars.count, matchEnd + 80)])
        var m = AttributedString(match)
        m.backgroundColor = .yellow.opacity(0.4)
        return AttributedString(before) + m + AttributedString(after)
    }
}

private extension String {
    func trimmingLeadingWhitespace() -> String {
        String(drop { $0 == " " || $0 == "\t" })
    }
}

/// "Go to": the file's classes and functions with a filter, and "Go to line N".
struct JumpView: View {
    let initial: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var symbols: [(name: String, kind: String, line: Int, depth: Int)] = []
    @State private var lines = 1
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Button {
                        jump(item.line)
                    } label: {
                        HStack(spacing: 8) {
                            if let kind = item.kind {
                                Text(kind == "class" ? "C" : kind == "method" ? "M" : "ƒ")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 20, height: 20)
                                    .background(kind == "class" ? Color.purple : kind == "method" ? Color.teal : Color.blue, in: RoundedRectangle(cornerRadius: 5))
                                    .padding(.leading, CGFloat(item.depth) * 16)
                            }
                            Text(item.label).font(.body.monospaced())
                            Spacer()
                            Text("\(item.line)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    .tint(.primary)
                }
                if items.isEmpty {
                    Text(symbols.isEmpty ? "No classes or functions in this file" : "No matching symbols").foregroundStyle(.secondary)
                }
            }
            .listStyle(.plain)
            .navigationTitle("Go to")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Symbol, or line number (1–\(lines))")
            .searchFocused($focused)
            .onSubmit(of: .search) { if let first = items.first { jump(first.line) } }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .task {
            query = initial
            focused = true
            guard let r = await model.editorCall(model.focused, "outline") as? [String: Any] else { return }
            lines = r["lines"] as? Int ?? 1
            symbols = (r["symbols"] as? [[String: Any]] ?? []).map {
                ($0["name"] as? String ?? "", $0["kind"] as? String ?? "function", $0["line"] as? Int ?? 1, $0["depth"] as? Int ?? 0)
            }
        }
    }

    private var items: [(label: String, line: Int, kind: String?, depth: Int)] {
        let trimmed = query.trimmingCharacters(in: CharacterSet(charactersIn: ": ").union(.whitespaces))
        if let n = Int(trimmed) {
            let line = max(1, min(n, lines))
            return [("Go to Line \(line)", line, nil, 0)]
        }
        let q = query.trimmingCharacters(in: CharacterSet(charactersIn: ":@").union(.whitespaces)).lowercased()
        return symbols.filter { q.isEmpty || $0.name.lowercased().contains(q) }.map { ($0.name, $0.line, $0.kind, $0.depth) }
    }

    private func jump(_ line: Int) {
        dismiss()
        Task { _ = await model.editorCall(model.focused, "reveal", [line, 1, model.visibleFraction]) }
    }
}

/// All problems in the open file; tap one to go there.
struct ProblemsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var items: [[String: Any]] = []

    var body: some View {
        NavigationStack {
            List {
                if items.isEmpty { Text("No problems found.").foregroundStyle(.secondary) }
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    let index = item["index"] as? Int ?? 0
                    let error = item["severity"] as? String == "error"
                    VStack(alignment: .leading, spacing: 6) {
                        Button {
                            dismiss()
                            Task { _ = await model.editorCall(model.focused, "selectProblem", [index]) }
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: error ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                                    .foregroundStyle(error ? .red : .orange)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item["message"] as? String ?? "")
                                    Text("Line \(item["line"] as? Int ?? 0) · \(item["source"] as? String ?? "")").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .tint(.primary)
                        let actions = item["actions"] as? [String] ?? []
                        if !actions.isEmpty {
                            HStack {
                                ForEach(Array(actions.enumerated()), id: \.offset) { j, name in
                                    Button(name) {
                                        dismiss()
                                        Task { _ = await model.editorCall(model.focused, "applyFix", [index, j]) }
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                }
                            }
                            .padding(.leading, 30)
                        }
                    }
                }
            }
            .navigationTitle("Problems")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .task {
            let raw = await model.editorCall(model.focused, "problems") as? [[String: Any]] ?? []
            items = raw.sorted {
                let a = ($0["severity"] as? String == "error" ? 0 : 1, $0["line"] as? Int ?? 0)
                let b = ($1["severity"] as? String == "error" ? 0 : 1, $1["line"] as? Int ?? 0)
                return a < b
            }
        }
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Editor") {
                    Stepper(value: Binding(get: { model.settings.fontSize }, set: { v in model.updateSettings { $0.fontSize = v } }),
                            in: EditorSettings.fontSizes) {
                        LabeledContent("Font Size", value: "\(model.settings.fontSize) pt")
                    }
                    Toggle("Wrap Long Lines", isOn: Binding(get: { model.settings.wrap }, set: { v in model.updateSettings { $0.wrap = v } }))
                }
                Section {
                    Text("def greet(name: str) -> str:\n    return f\"Hello {name}, nice to see you again today!\"")
                        .font(.system(size: CGFloat(model.settings.fontSize), design: .monospaced))
                        .lineLimit(model.settings.wrap ? nil : 2)
                        .fixedSize(horizontal: !model.settings.wrap, vertical: true)
                }
                if let ms = model.session.bootMs {
                    Section("Python") {
                        LabeledContent("Interpreter start", value: "\(Int(ms)) ms")
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
