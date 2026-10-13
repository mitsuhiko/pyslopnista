// File browser over the app's Documents folder (also visible in the Files app):
// large title, search, swipe actions, long-press context menu.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basename, dirname, type Entry, fs, haptic, join } from "./host";
import { ChevronLeft, ChevronRight, DocPlus, Duplicate, Ellipsis, FileIcon, FolderIcon, FolderPlus, Pencil, Search, Sort, Trash } from "./Icons";
import { Menu, type MenuSection } from "./ui/Menu";

interface Props {
  dir: string;
  currentFile: string | null;
  refreshKey: number;
  onOpenDir: (dir: string) => void;
  onOpenFile: (path: string) => void;
  onRenamed: (from: string, to: string) => void;
  onDeleted: (path: string) => void;
}

const SORT_KEY = "pyslopnista.sort";
const validName = (name: string | null): name is string => !!name?.trim() && !name.includes("/") && name !== "." && name !== "..";

function formatDate(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86_400_000;
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function formatSize(bytes: number) {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

// -- a row with swipe actions and long press --------------------------------------------

const ACTIONS_WIDTH = 148;

function Row(props: {
  entry: Entry;
  selected: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onActivate: () => void;
  onRename: () => void;
  onDelete: () => void;
  onContextMenu: (at: { x: number; y: number }) => void;
}) {
  const { entry, selected, open } = props;
  const content = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; dx: number; axis: "x" | "y" | null; timer: ReturnType<typeof setTimeout> | null; longPressed: boolean } | null>(null);
  const [dragX, setDragX] = useState<number | null>(null);

  const offset = dragX ?? (open ? -ACTIONS_WIDTH : 0);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const g = { x: e.clientX, y: e.clientY, dx: 0, axis: null as "x" | "y" | null, timer: null as ReturnType<typeof setTimeout> | null, longPressed: false };
    g.timer = setTimeout(() => {
      if (!g.axis) {
        g.longPressed = true;
        haptic();
        props.onContextMenu({ x: g.x, y: g.y });
      }
    }, 480);
    gesture.current = g;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.longPressed) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (g.timer) clearTimeout(g.timer);
      if (g.axis === "x") (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    if (g.axis === "x") {
      g.dx = dx;
      const base = open ? -ACTIONS_WIDTH : 0;
      setDragX(Math.min(0, Math.max(-ACTIONS_WIDTH - 40, base + dx)));
    }
  };
  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.timer) clearTimeout(g.timer);
    if (g.axis === "x") {
      const final = (open ? -ACTIONS_WIDTH : 0) + g.dx;
      props.onOpenChange(final < -ACTIONS_WIDTH / 2);
      setDragX(null);
      return;
    }
    setDragX(null);
    if (g.longPressed || g.axis === "y") return;
    if (open) props.onOpenChange(false);
    else props.onActivate();
  };

  return (
    <div className={`file-row ${selected ? "selected" : ""}`}>
      <div className="file-row-actions" aria-hidden={!open}>
        <button className="swipe-action rename" onClick={props.onRename}>
          <Pencil size={20} />
          <span>Rename</span>
        </button>
        <button className="swipe-action delete" onClick={props.onDelete}>
          <Trash size={20} />
          <span>Delete</span>
        </button>
      </div>
      <div
        ref={content}
        className={`file-row-content ${dragX === null ? "animated" : ""}`}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onContextMenu({ x: e.clientX, y: e.clientY });
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && props.onActivate()}
      >
        <span className="file-icon">{entry.dir ? <FolderIcon size={30} /> : <FileIcon name={entry.name} size={30} />}</span>
        <span className="file-text">
          <span className="file-name">{entry.name}</span>
          <span className="file-meta">{entry.dir ? formatDate(entry.mtime) : `${formatDate(entry.mtime)} · ${formatSize(entry.size)}`}</span>
        </span>
        {entry.dir && <ChevronRight size={15} className="chevron" />}
      </div>
    </div>
  );
}

// -- the browser ---------------------------------------------------------------------------

export function FileBrowser({ dir, currentFile, refreshKey, onOpenDir, onOpenFile, onRenamed, onDeleted }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: DOMRect | { x: number; y: number }; sections: MenuSection[] } | null>(null);
  const [sort, setSort] = useState<"name" | "date">(() => (localStorage.getItem(SORT_KEY) === "date" ? "date" : "name"));
  const [compactTitle, setCompactTitle] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await fs.list(dir));
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setEntries([]);
    }
  }, [dir]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    setQuery("");
    setOpenRow(null);
    scrollRef.current?.scrollTo(0, 0);
  }, [dir]);

  // Show the small title in the bar once the large title scrolls away.
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setCompactTitle(e.intersectionRatio < 0.3), { root: scrollRef.current, threshold: [0, 0.3, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));
    if (sort === "date") list.sort((a, b) => Number(b.dir) - Number(a.dir) || b.mtime - a.mtime);
    return list;
  }, [entries, query, sort]);

  const newFile = async () => {
    const name = prompt("Name of the new file", "untitled.py");
    if (!validName(name)) return;
    const path = join(dir, name.includes(".") ? name.trim() : `${name.trim()}.py`);
    if (await fs.exists(path)) return alert(`“${basename(path)}” already exists.`);
    await fs.writeText(path, "");
    await load();
    onOpenFile(path);
  };

  const newFolder = async () => {
    const name = prompt("Name of the new folder", "Project");
    if (!validName(name)) return;
    if (await fs.exists(join(dir, name.trim()))) return alert(`“${name.trim()}” already exists.`);
    await fs.mkdir(join(dir, name.trim()));
    await load();
  };

  const rename = async (entry: Entry) => {
    setOpenRow(null);
    const name = prompt(`Rename “${entry.name}”`, entry.name);
    if (!validName(name) || name.trim() === entry.name) return;
    const to = join(dirname(entry.path), name.trim());
    if (await fs.exists(to)) return alert(`“${name.trim()}” already exists.`);
    await fs.rename(entry.path, to);
    onRenamed(entry.path, to);
    await load();
  };

  const duplicate = async (entry: Entry) => {
    if (entry.dir) return;
    const dot = entry.name.lastIndexOf(".");
    const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
    const ext = dot > 0 ? entry.name.slice(dot) : "";
    let n = 2;
    while (await fs.exists(join(dir, `${stem} ${n}${ext}`))) n++;
    await fs.writeText(join(dir, `${stem} ${n}${ext}`), await fs.readText(entry.path));
    await load();
  };

  const remove = async (entry: Entry) => {
    setOpenRow(null);
    if (!confirm(`Delete “${entry.name}”${entry.dir ? " and everything in it" : ""}? This cannot be undone.`)) return;
    await fs.remove(entry.path);
    onDeleted(entry.path);
    await load();
  };

  const rowMenu = (entry: Entry): MenuSection[] => [
    [
      { label: "Rename", icon: <Pencil size={19} />, onSelect: () => void rename(entry) },
      ...(entry.dir ? [] : [{ label: "Duplicate", icon: <Duplicate size={19} />, onSelect: () => void duplicate(entry) }]),
    ],
    [{ label: "Delete", icon: <Trash size={19} />, destructive: true, onSelect: () => void remove(entry) }],
  ];

  const moreMenu = (anchor: DOMRect) =>
    setMenu({
      anchor,
      sections: [
        [
          { label: "New File", icon: <DocPlus size={19} />, onSelect: () => void newFile() },
          { label: "New Folder", icon: <FolderPlus size={19} />, onSelect: () => void newFolder() },
        ],
        [
          { label: `Sort by Name${sort === "name" ? " ✓" : ""}`, icon: <Sort size={19} />, onSelect: () => { setSort("name"); localStorage.setItem(SORT_KEY, "name"); } },
          { label: `Sort by Date${sort === "date" ? " ✓" : ""}`, icon: <Sort size={19} />, onSelect: () => { setSort("date"); localStorage.setItem(SORT_KEY, "date"); } },
        ],
      ],
    });

  const title = dir ? basename(dir) : "Files";

  return (
    <div className="screen browser">
      <header className={`nav-bar ${compactTitle ? "scrolled" : ""}`}>
        <div className="nav-left">
          {dir && (
            <button className="nav-back" onClick={() => onOpenDir(dirname(dir))}>
              <ChevronLeft size={22} />
              <span>{dirname(dir) ? basename(dirname(dir)) : "Files"}</span>
            </button>
          )}
        </div>
        <div className="nav-title compact">{title}</div>
        <div className="nav-right">
          <button className="glass-button" onClick={(e) => moreMenu(e.currentTarget.getBoundingClientRect())} aria-label="More">
            <Ellipsis size={22} />
          </button>
          <button className="glass-button" onClick={() => void newFile()} aria-label="New file">
            <DocPlus size={21} />
          </button>
        </div>
      </header>
      <div className="screen-scroll" ref={scrollRef} onPointerDown={() => openRow && setOpenRow(null)}>
        <h1 className="large-title" ref={titleRef}>{title}</h1>
        <label className="search-field">
          <Search size={17} />
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        {error && <div className="browser-error">{error}</div>}
        {entries && visible.length === 0 && !error && (
          <div className="empty-state">
            <FolderIcon size={56} />
            <p className="empty-title">{query ? "No Results" : "No Files"}</p>
            {!query && (
              <>
                <p className="empty-text">Create a Python file to start coding.</p>
                <button className="filled-button" onClick={() => void newFile()}>New File</button>
              </>
            )}
          </div>
        )}
        {visible.length > 0 && (
          <div className="grouped-list">
            {visible.map((e) => (
              <Row
                key={e.path}
                entry={e}
                selected={e.path === currentFile}
                open={openRow === e.path}
                onOpenChange={(o) => setOpenRow(o ? e.path : null)}
                onActivate={() => (e.dir ? onOpenDir(e.path) : onOpenFile(e.path))}
                onRename={() => void rename(e)}
                onDelete={() => void remove(e)}
                onContextMenu={(at) => setMenu({ anchor: at, sections: rowMenu(e) })}
              />
            ))}
          </div>
        )}
        {entries && visible.length > 0 && (
          <p className="list-footer">{visible.length === 1 ? "1 item" : `${visible.length} items`}</p>
        )}
      </div>
      {menu && <Menu anchor={menu.anchor} sections={menu.sections} onClose={() => setMenu(null)} align={"width" in menu.anchor ? "end" : "start"} />}
    </div>
  );
}
