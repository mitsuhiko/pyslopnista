import SwiftUI

// The debugger (D23): the step bar, the paused block in the console (stack
// and variables), and popovers for a name tapped in the editor and for ty's
// info about a name.

struct DebugBar: View {
    let debug: DebugState
    @Environment(AppModel.self) private var model

    var body: some View {
        if debug.postMortem {
            // Inspecting an error has nothing to step through: just a way out.
            Button("Done") { model.resume("continue") }
                .buttonStyle(.bordered)
                .controlSize(.small)
        } else {
            HStack(spacing: 2) {
                step("Step Over", "arrow.turn.down.right", "next")
                step("Step Into", "arrow.down.to.line", "stepIn")
                step("Step Out", "arrow.up.to.line", "stepOut")
                Button { model.stop() } label: { Image(systemName: "stop.fill").frame(width: 30, height: 30) }
                    .foregroundStyle(.red)
                    .accessibilityLabel("Stop")
            }
        }
    }

    private func step(_ label: String, _ symbol: String, _ op: String) -> some View {
        Button { model.resume(op) } label: { Image(systemName: symbol).frame(width: 30, height: 30) }
            .accessibilityLabel(label)
    }
}

/// Shown in the console while the program is paused.
struct PausedBlock: View {
    let debug: DebugState
    @Environment(AppModel.self) private var model

    var body: some View {
        let frame = debug.frame
        let reason = debug.postMortem ? "Inspecting the error"
            : debug.reason == "breakpoint" ? "Breakpoint" : debug.reason == "pause" ? "Paused" : debug.reason == "breakpoint()" ? "breakpoint()" : "Step"
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(reason)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(debug.postMortem ? Color.red : Color.green, in: Capsule())
                if let frame { Text("\(frame.label) · line \(frame.line)").font(.footnote.monospaced()) }
            }
            if let exception = debug.exception {
                Text(exception).font(.footnote.monospaced()).foregroundStyle(.red)
            }
            if debug.frames.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(debug.frames.enumerated()), id: \.offset) { i, f in
                            Button { model.selectFrame(i) } label: {
                                Text("\(f.label):\(f.line)").font(.caption.monospaced())
                            }
                            .buttonStyle(.bordered)
                            .tint(i == debug.selected ? .accentColor : .secondary)
                            .controlSize(.small)
                        }
                    }
                }
            }
            ForEach(debug.scopes, id: \.name) { scope in
                VStack(alignment: .leading, spacing: 2) {
                    if debug.scopes.count > 1 { Text(scope.name).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
                    if scope.variables.isEmpty {
                        Text("No variables").font(.caption).foregroundStyle(.secondary)
                    } else {
                        VariableList(variables: scope.variables)
                    }
                }
                .id("\(debug.stopId)-\(debug.selected)-\(scope.name)")
            }
            Text(debug.postMortem ? "Tap a name in the editor to see its value." : "Tap a name in the editor to see its value. >>> runs here.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}

struct VariableList: View {
    let variables: [DebugVariable]
    var depth = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(variables.enumerated()), id: \.offset) { _, v in
                VariableRow(variable: v, depth: depth)
            }
        }
    }
}

private struct VariableRow: View {
    let variable: DebugVariable
    let depth: Int
    @Environment(AppModel.self) private var model
    @State private var open = false
    @State private var children: [DebugVariable]?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard variable.ref > 0 else { return }
                Task {
                    if !open && children == nil { children = await model.debugVariables(variable.ref) }
                    withAnimation(.snappy) { open.toggle() }
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .opacity(variable.ref > 0 ? 1 : 0)
                    Text(variable.name).fontWeight(.semibold)
                    Text(variable.value).foregroundStyle(.secondary).lineLimit(3)
                    Spacer(minLength: 4)
                    Text(variable.type).font(.caption2).foregroundStyle(.tertiary)
                }
                .font(.caption.monospaced())
                .padding(.vertical, 3)
                .padding(.leading, CGFloat(depth) * 16)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open, let children {
                if children.isEmpty {
                    Text("empty").font(.caption).foregroundStyle(.secondary).padding(.leading, CGFloat(depth + 1) * 16 + 14)
                } else {
                    VariableList(variables: children, depth: depth + 1)
                }
            }
        }
    }
}

/// The value of a name tapped in the paused editor.
struct ValuePopover: View {
    let expr: String
    @Environment(AppModel.self) private var model
    @State private var result: (DebugVariable?, String?)?
    @State private var children: [DebugVariable]?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(expr).font(.subheadline.monospaced().weight(.semibold))
                Spacer()
                if let type = result?.0?.type { Text(type).font(.caption).foregroundStyle(.secondary) }
            }
            if let result {
                if let error = result.1 {
                    Text(error).font(.caption.monospaced()).foregroundStyle(.red)
                } else if let value = result.0 {
                    Text(value.value).font(.caption.monospaced()).textSelection(.enabled)
                    if let children, !children.isEmpty {
                        Divider()
                        ScrollView { VariableList(variables: children) }.frame(maxHeight: 260)
                    }
                }
            } else {
                ProgressView()
            }
        }
        .padding(14)
        .frame(minWidth: 220, maxWidth: 380)
        .task(id: expr) {
            let r = await model.debugEvaluate(expr)
            result = r
            if let ref = r.0?.ref, ref > 0 { children = await model.debugVariables(ref) }
        }
    }
}

/// ty's hover text: signature or type, then the docstring (a small Markdown subset).
struct InfoPopover: View {
    let markdown: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if let markdown {
                    if markdown.isEmpty {
                        Text("No information.").foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(Self.blocks(markdown).enumerated()), id: \.offset) { _, block in
                            if block.code {
                                Text(block.text).font(.caption.monospaced())
                                    .padding(8)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 6))
                            } else {
                                Text((try? AttributedString(markdown: block.text)) ?? AttributedString(block.text)).font(.callout)
                            }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .padding(14)
        }
        .frame(minWidth: 260, maxWidth: 420, maxHeight: 360)
    }

    static func blocks(_ md: String) -> [(code: Bool, text: String)] {
        var out: [(Bool, String)] = []
        var code: [String]?
        var para: [String] = []
        func flushPara() {
            let text = para.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty && text != "---" { out.append((false, text)) }
            para = []
        }
        for line in md.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                if let c = code {
                    out.append((true, c.joined(separator: "\n")))
                    code = nil
                } else {
                    flushPara()
                    code = []
                }
            } else if code != nil {
                code!.append(line)
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty || line.trimmingCharacters(in: .whitespaces) == "---" {
                flushPara()
            } else {
                para.append(line)
            }
        }
        flushPara()
        return out
    }
}
