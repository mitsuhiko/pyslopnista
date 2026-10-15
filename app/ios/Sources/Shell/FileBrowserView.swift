import SwiftUI
import UniformTypeIdentifiers

/// The app's Documents folder (also in the Files app) and linked folders
/// (iCloud Drive, other apps; under Locations at the top level, D28).
struct FileBrowserView: View {
    let dir: String
    @Environment(AppModel.self) private var model
    @State private var entries: [Entry]?
    @State private var locations: [LinkedFolder] = []
    @State private var error: String?
    @State private var query = ""
    @State private var naming: Naming?
    @State private var name = ""
    @State private var deleting: Entry?
    @State private var unlinking: LinkedFolder?
    @State private var importing = false
    @AppStorage("sort") private var sort = "name"

    struct Entry: Identifiable, Hashable {
        let name: String
        let path: String
        let dir: Bool
        let size: Int
        let mtime: Double
        var id: String { path }
    }

    struct LinkedFolder: Identifiable, Hashable {
        let name: String
        let path: String
        let available: Bool
        var id: String { path }
    }

    enum Naming: Identifiable {
        case newFile, newFolder, rename(Entry)
        var id: String {
            switch self {
            case .newFile: "file"
            case .newFolder: "folder"
            case .rename(let e): "rename:\(e.path)"
            }
        }
    }

    var body: some View {
        List {
            if let error {
                Text(error).foregroundStyle(.red).font(.footnote)
            }
            if entries != nil {
                if visible.isEmpty {
                    ContentUnavailableView {
                        Label(query.isEmpty ? "No Files" : "No Results", systemImage: query.isEmpty ? "folder" : "magnifyingglass")
                    } description: {
                        if query.isEmpty { Text("Create a Python file to start coding.") }
                    } actions: {
                        if query.isEmpty { Button("New File") { ask(.newFile) }.buttonStyle(.borderedProminent) }
                    }
                    .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(visible) { entry in row(entry) }
                    } footer: {
                        Text(visible.count == 1 ? "1 item" : "\(visible.count) items")
                    }
                }
            }
            if dir.isEmpty && (query.isEmpty || !linkedVisible.isEmpty) {
                Section("Locations") {
                    ForEach(linkedVisible) { location in linkedRow(location) }
                    if query.isEmpty {
                        Button { importing = true } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Open Folder…")
                                    Text("iCloud Drive, other apps, file providers").font(.caption).foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: "folder.badge.plus")
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic))
        .navigationTitle(displayName(dir))
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Section {
                        Button { ask(.newFile) } label: { Label("New File", systemImage: "doc.badge.plus") }
                        Button { ask(.newFolder) } label: { Label("New Folder", systemImage: "folder.badge.plus") }
                        Button { importing = true } label: { Label("Open Folder…", systemImage: "folder") }
                    }
                    Section {
                        Picker("Sort", selection: $sort) {
                            Label("Name", systemImage: "textformat").tag("name")
                            Label("Date", systemImage: "calendar").tag("date")
                        }
                    }
                    Section {
                        Button { model.activeSheet = .find } label: { Label("Find in \(displayName(dir))…", systemImage: "magnifyingglass") }
                        Button { model.activeSheet = .settings } label: { Label("Settings…", systemImage: "gearshape") }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("More")
                Button { ask(.newFile) } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New file")
            }
        }
        .task(id: "\(dir)#\(model.fileListVersion)") { await load() }
        .refreshable { await load() }
        .alert(title(naming), isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
            TextField("Name", text: $name)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) { naming = nil }
            Button(naming.map { if case .rename = $0 { "Rename" } else { "Create" } } ?? "OK") { commitName() }
        }
        .confirmationDialog(deleting.map { "Delete “\($0.name)”\($0.dir ? " and everything in it" : "")?" } ?? "",
                            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { entry in
            Button("Delete", role: .destructive) { Task { await model.delete(entry.path) } }
        } message: { _ in
            Text("This cannot be undone.")
        }
        .confirmationDialog(unlinking.map { "Remove “\($0.name)” from Locations?" } ?? "",
                            isPresented: Binding(get: { unlinking != nil }, set: { if !$0 { unlinking = nil } }),
                            titleVisibility: .visible, presenting: unlinking) { location in
            Button("Remove", role: .destructive) { Task { await model.unlink(location.path) } }
        } message: { _ in
            Text("Its files stay where they are.")
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result, let path = model.linkFolder(url) {
                model.route.append(.folder(path))
            }
        }
    }

    // MARK: rows

    private func row(_ entry: Entry) -> some View {
        let selected = entry.path == model.file
        return Group {
            if entry.dir {
                NavigationLink(value: Route.folder(entry.path)) { EntryLabel(entry: entry, location: false) }
            } else {
                Button {
                    Task { await model.openFile(entry.path) }
                } label: {
                    EntryLabel(entry: entry, location: false)
                }
                .tint(.primary)
            }
        }
        .listRowBackground(selected ? Color.accentColor.opacity(0.12) : nil)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { deleting = entry } label: { Label("Delete", systemImage: "trash") }
            Button { ask(.rename(entry)) } label: { Label("Rename", systemImage: "pencil") }.tint(.orange)
        }
        .contextMenu {
            Button { ask(.rename(entry)) } label: { Label("Rename", systemImage: "pencil") }
            if !entry.dir {
                Button {
                    Task { _ = await model.duplicate(entry.path) }
                } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
            }
            Divider()
            Button(role: .destructive) { deleting = entry } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func linkedRow(_ location: LinkedFolder) -> some View {
        let entry = Entry(name: location.name, path: location.path, dir: true, size: location.available ? 1 : 0, mtime: 0)
        return Group {
            if location.available {
                NavigationLink(value: Route.folder(location.path)) { EntryLabel(entry: entry, location: true) }
            } else {
                EntryLabel(entry: entry, location: true).foregroundStyle(.secondary)
            }
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { unlinking = location } label: { Label("Remove", systemImage: "trash") }
        }
        .contextMenu {
            Button(role: .destructive) { unlinking = location } label: { Label("Remove from Locations", systemImage: "trash") }
        }
    }

    private var visible: [Entry] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        var list = (entries ?? []).filter { q.isEmpty || $0.name.lowercased().contains(q) }
        if sort == "date" { list.sort { $0.dir != $1.dir ? $0.dir : $0.mtime > $1.mtime } }
        return list
    }

    private var linkedVisible: [LinkedFolder] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return locations.filter { q.isEmpty || $0.name.lowercased().contains(q) }
    }

    // MARK: actions

    private func load() async {
        if dir.isEmpty {
            locations = model.host.files.locations.list().map {
                LinkedFolder(name: $0["name"] as? String ?? "", path: $0["path"] as? String ?? "", available: $0["available"] as? Bool ?? false)
            }
        }
        do {
            let dir = dir
            let raw = try await model.host.onFileQueue { files in
                try files.list(dir).map { e in
                    Entry(name: e["name"] as? String ?? "", path: e["path"] as? String ?? "", dir: e["dir"] as? Bool ?? false,
                          size: e["size"] as? Int ?? 0, mtime: e["mtime"] as? Double ?? 0)
                }
            }
            entries = raw
            error = nil
        } catch {
            self.error = "\(error)"
            entries = []
        }
    }

    private func ask(_ what: Naming) {
        switch what {
        case .newFile: name = "untitled.py"
        case .newFolder: name = "Project"
        case .rename(let e): name = e.name
        }
        naming = what
    }

    private func title(_ what: Naming?) -> String {
        switch what {
        case .newFile: "New File"
        case .newFolder: "New Folder"
        case .rename(let e): "Rename “\(e.name)”"
        case nil: ""
        }
    }

    private func commitName() {
        guard let what = naming else { return }
        naming = nil
        let value = name.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, !value.contains("/"), value != ".", value != ".." else { return }
        Task {
            switch what {
            case .newFile:
                if let path = await model.newFile(in: dir, name: value) { await model.openFile(path) }
            case .newFolder:
                await model.newFolder(in: dir, name: value)
            case .rename(let e):
                if value != e.name { _ = await model.rename(e.path, to: value) }
            }
        }
    }
}

private struct EntryLabel: View {
    let entry: FileBrowserView.Entry
    let location: Bool

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if location {
                    Image(systemName: "externaldrive.connected.to.line.below").font(.title2).foregroundStyle(.tint)
                } else if entry.dir {
                    FolderIcon()
                } else {
                    FileIcon(name: entry.name)
                }
            }
            .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name).lineLimit(1)
                Text(meta).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    private var meta: String {
        if location { return entry.size > 0 ? "Linked folder" : "Not available" }
        let date = Self.date(entry.mtime)
        return entry.dir ? date : "\(date) · \(Self.size(entry.size))"
    }

    static func date(_ ms: Double) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let cal = Calendar.current
        let time = d.formatted(date: .omitted, time: .shortened)
        if cal.isDateInToday(d) { return "Today, \(time)" }
        if cal.isDateInYesterday(d) { return "Yesterday, \(time)" }
        return d.formatted(date: .abbreviated, time: .omitted)
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
