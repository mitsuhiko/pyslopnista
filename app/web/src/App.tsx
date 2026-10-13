import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { forceLinting } from "@codemirror/lint";
import { formatDocument } from "./analysis/codemirror";
import { analysis } from "./analysis/client";
import { Console, runSummary } from "./Console";
import { ConsoleSheet, type Detent } from "./ConsoleSheet";
import { breakpoints } from "./debug/breakpoints";
import { ContinueButton, DebugBar, PauseButton, pausedSummary, ValuePopover } from "./debug/DebugViews";
import { Editor, type EditorCommand, type EditorHandle, type Reveal } from "./Editor";
import { FileBrowser } from "./FileBrowser";
import { FindPanel } from "./FindPanel";
import { InfoPopover } from "./InfoPopover";
import { JumpPanel } from "./JumpPanel";
import { SettingsSheet } from "./SettingsSheet";
import { base64ToBytes, basename, call, dirname, displayName, fs, haptic, isNative, join } from "./host";
import {
  ChevronDown, ChevronLeft, Close, DocPlus, Duplicate, Ellipsis, FileIcon, Gear, Info, JumpTo, ListBullet, Pencil, Play, Search, Sidebar, SplitView,
  Stop, Terminal, Trash, Wand, Warning,
} from "./Icons";
import { KeyBar } from "./KeyBar";
import { navigation } from "./navigation";
import { ProblemBar, type ProblemSummary, summarizeProblems } from "./ProblemBar";
import { ProblemsSheet } from "./ProblemsSheet";
import { session } from "./session";
import { isExternal, TabBar, tabLabel } from "./TabBar";
import { UIAppView } from "./UIAppView";
import { Menu, type MenuSection } from "./ui/Menu";
import { toast, ToastHost } from "./ui/Toast";

const TABS_KEY = "pyslopnista.tabs";
const LEGACY_LAST_FILE_KEY = "pyslopnista.lastFile";
const WIDE_QUERY = "(min-width: 768px)";

type Page = "files" | "editor" | "console";

/** One editor pane: its open files (tabs) and the one shown. iPad can show two side by side. */
interface PaneState {
  tabs: string[];
  active: string | null;
}

function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const fn = () => setMatch(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);
  return match;
}

export interface AppController {
  openFile(path: string, restoring?: boolean): Promise<void>;
  openLocation(path: string, line?: number, column?: number): Promise<void>;
  currentFile(): string | null;
  run(): Promise<void>;
  editor(): EditorHandle | null;
  save(): Promise<void>;
  showPane(pane: Page): void;
  format(): Promise<void>;
  problems(): ProblemSummary;
  goToDefinition(): Promise<unknown>;
  showInfo(): Promise<string | null>;
  panes(): PaneState[];
  setSplit(on: boolean): void;
  closeTab(path: string, pane?: number): void;
}

/** Actions sent by the native keyboard accessory (KeyboardAccessory.swift). */
function handleKey(editor: EditorHandle | null, action: string) {
  const field = document.activeElement;
  if (field instanceof HTMLInputElement) return handleFieldKey(field, action);
  if (!editor) return;
  if (action === "dismiss") return editor.blur();
  if (action.startsWith("insert:")) {
    const body = action.slice("insert:".length);
    const m = /^([\s\S]+):(\d+)$/.exec(body);
    return m ? editor.insert(m[1], Number(m[2])) : editor.insert(body);
  }
  editor.command(action as EditorCommand);
}

/** The same keys for a plain text field (the >>> console). */
function handleFieldKey(field: HTMLInputElement, action: string) {
  if (action === "dismiss") return field.blur();
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  let insert = "";
  let cursor = 0;
  if (action.startsWith("insert:")) {
    const body = action.slice("insert:".length);
    const m = /^([\s\S]+):(\d+)$/.exec(body);
    insert = m ? m[1] : body;
    cursor = m ? Number(m[2]) : insert.length;
  } else if (action === "indent") {
    insert = "    ";
    cursor = 4;
  } else if (action === "left" || action === "right") {
    const pos = Math.max(0, Math.min(field.value.length, start + (action === "left" ? -1 : 1)));
    return field.setSelectionRange(pos, pos);
  } else {
    return;
  }
  field.setRangeText(insert, start, end, "end");
  field.setSelectionRange(start + cursor, start + cursor);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A breakpoint on a blank or comment line moves to the next line of code. */
function codeLineFrom(text: string, line: number): number {
  const lines = text.split("\n");
  for (let i = line - 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t && !t.startsWith("#")) return i + 1;
  }
  return line;
}

function BreakpointIcon({ off }: { off?: boolean }) {
  return (
    <svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true">
      <path d="M2 1.5h13.5l5 5.5-5 5.5H2a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" fill={off ? "none" : "var(--bp)"} stroke="var(--bp)" strokeWidth="1.4" />
    </svg>
  );
}

// The analysis folder sync (set by App; go to definition waits for it).
let rootSyncedRef: { current: Promise<void> } | null = null;

/** At most this many tabs per pane; opening more closes the least recently used. */
const MAX_TABS = 10;
const lastUsed = new Map<string, number>();

/** The text of `path` if this editor is showing it (not a file it is about to switch from). */
function textIn(editor: EditorHandle | null, path: string): string | null {
  return editor && editor.currentPath() === path ? editor.getText() : null;
}

function loadTabs(): { panes: PaneState[]; focused: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null");
    if (saved && Array.isArray(saved.panes) && saved.panes.length) {
      const panes = (saved.panes as PaneState[]).slice(0, 2).map((p) => ({
        tabs: p.tabs.filter((t) => typeof t === "string" && !isExternal(t)),
        active: p.active && !isExternal(p.active) ? p.active : null,
      }));
      return { panes, focused: Math.min(saved.focused ?? 0, panes.length - 1) };
    }
  } catch {
    // start fresh
  }
  const last = localStorage.getItem(LEGACY_LAST_FILE_KEY);
  return { panes: [{ tabs: last ? [last] : [], active: last }], focused: 0 };
}

/** Insert a tab right after the active one, like Safari. */
function withTab(pane: PaneState, path: string): PaneState {
  lastUsed.set(path, Date.now());
  if (pane.tabs.includes(path)) return { ...pane, active: path };
  const at = pane.active ? pane.tabs.indexOf(pane.active) + 1 : pane.tabs.length;
  let tabs = [...pane.tabs.slice(0, at), path, ...pane.tabs.slice(at)];
  while (tabs.length > MAX_TABS) {
    const oldest = tabs.filter((t) => t !== path).reduce((a, b) => ((lastUsed.get(a) ?? 0) <= (lastUsed.get(b) ?? 0) ? a : b));
    tabs = tabs.filter((t) => t !== oldest);
  }
  return { tabs, active: path };
}

function withoutTab(pane: PaneState, path: string): PaneState {
  const i = pane.tabs.indexOf(path);
  if (i < 0) return pane;
  const tabs = pane.tabs.filter((t) => t !== path);
  const active = pane.active === path ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : pane.active;
  return { tabs, active };
}

export function App({ onReady }: { onReady?: (c: AppController) => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const wide = useMedia(WIDE_QUERY);
  const landscape = useMedia("(min-aspect-ratio: 4/3)");
  const initial = useRef(loadTabs());
  const [panes, setPanes] = useState<PaneState[]>(initial.current.panes);
  const [focusedPane, setFocusedPane] = useState(initial.current.focused);
  /** Text of each loaded file, for an editor that has no state for it yet. */
  const [docs, setDocs] = useState<Record<string, string>>({});
  const editors = useRef<(EditorHandle | null)[]>([null, null]);
  const focusedEditor = useRef<EditorHandle | null>(null);
  const [reveal, setReveal] = useState<(Reveal & { pane: number }) | null>(null);
  const [dir, setDir] = useState("");
  const [page, setPage] = useState<Page>("files");
  const [editorFocused, setEditorFocused] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0); // the browser lists the folder again
  const [analysisKey, setAnalysisKey] = useState(0); // ty reads the folder again
  const refreshFiles = () => {
    setRefreshKey((k) => k + 1);
    setAnalysisKey((k) => k + 1);
  };
  const [problems, setProblems] = useState<ProblemSummary>({ errors: 0, warnings: 0, current: null });
  const [menu, setMenu] = useState<{ anchor: DOMRect; sections: MenuSection[]; align?: "start" | "end" } | null>(null);
  const [inspect, setInspect] = useState<{ expr: string; anchor: DOMRect } | null>(null);
  useSyncExternalStore(breakpoints.subscribe, breakpoints.getSnapshot);
  const [detent, setDetent] = useState<Detent>("peek");
  const [sidebar, setSidebar] = useState(true);
  const [consoleDocked, setConsoleDocked] = useState(true);
  const [edgeDrag, setEdgeDrag] = useState<number | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [jump, setJump] = useState<{ initial: string } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [info, setInfo] = useState<{ markdown: string | null; anchor: DOMRect } | null>(null);
  const pending = useRef(new Map<string, string>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explicitlyOpened = useRef(false);

  // On iPhone there is only one pane.
  const split = wide && panes.length > 1;
  const focused = split ? focusedPane : wide ? Math.min(focusedPane, panes.length - 1) : 0;
  const file = panes[focused]?.active ?? null;
  const fileIsExternal = !!file && isExternal(file);
  focusedEditor.current = editors.current[focused];
  const fileBreakpoints = breakpoints.get(file);

  // Remember the tabs.
  useEffect(() => {
    localStorage.setItem(TABS_KEY, JSON.stringify({ panes: panes.map((p) => ({ tabs: p.tabs.filter((t) => !isExternal(t)), active: p.active })), focused: focusedPane }));
  }, [panes, focusedPane]);

  // Start ruff + ty in the background; the first check would do it anyway.
  useEffect(() => {
    void analysis.init().catch(() => {});
  }, []);

  // -- saving ------------------------------------------------------------------------------

  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const writes = [...pending.current];
    pending.current.clear();
    await Promise.all(writes.map(([path, text]) => fs.writeText(path, text)));
  }, []);

  /** A local edit in pane `index`: save it and mirror it into the other pane. */
  const onChange = (index: number) => (path: string, text: string, changes: Parameters<EditorHandle["applyRemote"]>[1]) => {
    if (isExternal(path)) return;
    pending.current.set(path, text);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 700);
    editors.current.forEach((ed, i) => i !== index && ed?.applyRemote(path, changes));
  };

  // -- opening files -------------------------------------------------------------------------

  /** Load a file's text (project files from disk, external ones from ty). */
  const load = useCallback(async (path: string) => {
    if (isExternal(path)) return analysis.source(path);
    await flush();
    return fs.readText(path);
  }, [flush]);

  /**
   * Show a file, optionally at a line: in the pane where it is already the
   * active tab, else as a tab in the focused pane.
   */
  const openLocation = useCallback(
    async (path: string, opts: { line?: number; column?: number; pane?: number; keepConsole?: boolean; restoring?: boolean } = {}) => {
      if (!opts.restoring) explicitlyOpened.current = true;
      else if (explicitlyOpened.current) return;
      const text = await load(path);
      const shownIn = panes.findIndex((p, i) => p.active === path && (split || i === focused));
      const target = opts.pane ?? (shownIn >= 0 ? shownIn : focused);
      setDocs((d) => ({ ...d, [path]: text }));
      // Update the panes as they are then (a restore may have changed them meanwhile).
      setPanes((ps) => {
        const before = ps[target] ?? { tabs: [], active: null };
        const after = withTab(before, path);
        const dropped = before.tabs.filter((t) => !after.tabs.includes(t)); // closed by the tab limit
        if (dropped.length) queueMicrotask(() => dropped.forEach((t) => editors.current[target]?.forget(t)));
        return ps[target] ? ps.map((p, i) => (i === target ? after : p)) : [...ps, after];
      });
      setFocusedPane(target);
      if (opts.line) setReveal({ path, line: opts.line, column: opts.column, nonce: Date.now(), pane: target });
      if (!isExternal(path)) setDir(dirname(path));
      setPage("editor");
      if (!opts.keepConsole && path !== file) setDetent("peek");
      else if (detent === "full") setDetent("half");
      setProblemsOpen(false);
    },
    [load, panes, split, focused, file, detent],
  );

  const openFile = useCallback((path: string, restoring = false) => openLocation(path, { restoring }), [openLocation]);

  // Restore the tabs: load the active files, drop ones that no longer exist.
  useEffect(() => {
    void (async () => {
      const all = [...new Set(initial.current.panes.flatMap((p) => p.tabs))];
      const exists = new Map(await Promise.all(all.map(async (p) => [p, await fs.exists(p)] as const)));
      const texts: Record<string, string> = {};
      for (const p of initial.current.panes) if (p.active && exists.get(p.active)) texts[p.active] = await fs.readText(p.active);
      // Tabs of files that are gone close, even if something was opened meanwhile.
      const gone = (t: string) => exists.get(t) === false;
      setDocs((d) => ({ ...texts, ...d }));
      setPanes((ps) => {
        const next = ps.map((p) => {
          const tabs = p.tabs.filter((t) => !gone(t));
          return { tabs, active: p.active && tabs.includes(p.active) ? p.active : (tabs[0] ?? null) };
        });
        return next.length > 1 && !next[1].tabs.length ? [next[0]] : next;
      });
      if (explicitlyOpened.current) return;
      const active = initial.current.panes[initial.current.focused]?.active;
      if (active && exists.get(active)) setDir(dirname(active));
      setPage(wide ? "editor" : "files");
    })();
  }, []);

  // Active tabs whose text is not loaded yet (restored tabs) get loaded.
  useEffect(() => {
    for (const p of panes) {
      const path = p.active;
      if (path && docs[path] === undefined) void load(path).then((text) => setDocs((d) => (d[path] === undefined ? { ...d, [path]: text } : d)), () => {});
    }
  }, [panes, docs, load]);

  // Switching to a tab whose text is not loaded yet (restored tabs).
  const selectTab = async (index: number, path: string) => {
    if (docs[path] === undefined) {
      const text = await load(path);
      setDocs((d) => ({ ...d, [path]: text }));
    }
    lastUsed.set(path, Date.now());
    setPanes((ps) => ps.map((p, i) => (i === index ? { ...p, active: path } : p)));
    setFocusedPane(index);
    if (!isExternal(path)) setDir(dirname(path));
    setProblemsOpen(false);
  };

  const closeTab = (path: string, index = focused) => {
    void flush();
    editors.current[index]?.forget(path);
    setPanes((ps) => {
      const next = ps.map((p, i) => (i === index ? withoutTab(p, path) : p));
      // An empty second pane closes the split.
      if (next.length > 1 && !next[1].tabs.length) {
        setFocusedPane(0);
        return [next[0]];
      }
      if (next.length > 1 && !next[0].tabs.length) {
        setFocusedPane(0);
        return [next[1]];
      }
      return next;
    });
  };

  const setSplit = (on: boolean) => {
    if (on && panes.length === 1) {
      setPanes((ps) => [ps[0], { tabs: file ? [file] : [], active: file }]);
      setFocusedPane(1);
      if (window.innerWidth < 1100) setSidebar(false); // two editors need the room
    } else if (!on && panes.length > 1) {
      setPanes((ps) => [{ tabs: [...new Set([...ps[0].tabs, ...ps[1].tabs])], active: ps[focused]?.active ?? ps[0].active }]);
      setFocusedPane(0);
    }
  };

  const tabMenu = (index: number, path: string, anchor: DOMRect) => {
    const pane = panes[index];
    const other = index === 0 ? 1 : 0;
    setMenu({
      anchor,
      align: "start",
      sections: [
        [
          { label: "Close Tab", icon: <Close size={17} />, onSelect: () => closeTab(path, index) },
          {
            label: "Close Other Tabs",
            disabled: pane.tabs.length < 2,
            onSelect: () => {
              for (const t of pane.tabs) if (t !== path) editors.current[index]?.forget(t);
              setPanes((ps) => ps.map((p, i) => (i === index ? { tabs: [path], active: path } : p)));
            },
          },
        ],
        ...(wide
          ? [[
              {
                label: panes.length > 1 ? (index === 0 ? "Open on the Right" : "Open on the Left") : "Open in Split View",
                icon: <SplitView size={19} />,
                onSelect: () => {
                  if (panes.length === 1) {
                    setPanes((ps) => [ps[0].tabs.length > 1 ? withoutTab(ps[0], path) : ps[0], { tabs: [path], active: path }]);
                    setFocusedPane(1);
                  } else {
                    void openLocation(path, { pane: other });
                  }
                },
              },
            ]]
          : []),
      ],
    });
  };

  // -- running -------------------------------------------------------------------------------

  const run = useCallback(async () => {
    if (!file || isExternal(file)) return;
    haptic();
    const shown = textIn(focusedEditor.current, file);
    if (shown !== null) pending.current.set(file, shown);
    await flush();
    const text = shown ?? (await fs.readText(file));
    focusedEditor.current?.blur();
    if (!wide) setPage("editor");
    if (wide) setConsoleDocked(true);
    await session.runFile(file, text);
  }, [file, flush, wide]);

  const format = useCallback(async () => {
    const view = focusedEditor.current?.view();
    if (!view || fileIsExternal) return;
    try {
      toast((await formatDocument(view)) ? "Formatted" : "Already formatted");
    } catch (e) {
      toast(`Could not format: ${(e as Error).message}`);
    }
  }, [fileIsExternal]);

  // -- go to definition (ty) -------------------------------------------------------------------

  const goToDefinition = useCallback(async () => {
    const view = focusedEditor.current?.view();
    if (!view || !file || focusedEditor.current?.currentPath() !== file) return { skipped: { file, shown: focusedEditor.current?.currentPath() } };
    if (isExternal(file)) return toast("Not available in library files");
    const sel = view.state.selection.main;
    const pos = sel.empty ? sel.head : sel.from;
    const line = view.state.doc.lineAt(pos);
    try {
      await rootSyncedRef?.current; // the folder's modules must be known first
      const targets = await analysis.definition(file, view.state.doc.toString(), line.number, pos - line.from + 1);
      const [target] = targets;
      if (!target) return toast("No definition found");
      haptic();
      await openLocation(target.path, { line: target.start.line, column: target.start.column, keepConsole: true });
      return { file, line: line.number, column: pos - line.from + 1, targets };
    } catch (e) {
      toast(`Could not find the definition: ${(e as Error).message}`);
    }
  }, [file, openLocation]);

  /** ty's hover text for the name at the cursor, in a popover next to it. */
  const showInfo = useCallback(async () => {
    const editor = focusedEditor.current;
    const view = editor?.view();
    if (!view || !file || isExternal(file) || editor?.currentPath() !== file) return null;
    const sel = view.state.selection.main;
    const pos = sel.empty ? sel.head : sel.from;
    const word = view.state.wordAt(pos);
    const a = view.coordsAtPos(word?.from ?? pos);
    const b = view.coordsAtPos(word?.to ?? pos, -1);
    if (!a) return null;
    const anchor = new DOMRect(a.left, a.top, Math.max(1, (b?.right ?? a.right) - a.left), a.bottom - a.top);
    setInfo({ markdown: null, anchor });
    const line = view.state.doc.lineAt(pos);
    try {
      const markdown = (await analysis.hover(file, view.state.doc.toString(), line.number, pos - line.from + 1)) ?? "";
      setInfo((i) => (i && i.anchor === anchor ? { markdown, anchor } : i));
      return markdown;
    } catch {
      setInfo(null);
      return null;
    }
  }, [file]);

  /** Jump to a line of the current file (outline, go to line). */
  const goToLine = (line: number) => {
    if (file) setReveal({ path: file, line, nonce: Date.now(), pane: focused });
  };

  // Keys from the native accessory and the native edit menu ("Jump to Definition", "Show Info").
  useEffect(() => {
    (window as any).__pyslopKey = (action: string) => {
      if (action === "definition") return void api.current.goToDefinition();
      if (action === "info") return void api.current.showInfo();
      handleKey(focusedEditor.current, action);
    };
    if (!isNative) return;
    let mode = "";
    const onFocus = (e: FocusEvent) => {
      const target = e.target as Element | null;
      const next = target?.closest?.(".cm-editor") ? "code" : target?.closest?.(".repl, .inline-input") ? "console" : "plain";
      if (next !== mode) {
        mode = next;
        void call("keyboard.mode", { mode });
      }
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  // Hardware keyboard shortcuts (Xcode's and VS Code's where they do not clash).
  const shortcuts = useRef<(e: KeyboardEvent) => boolean>(() => false);
  shortcuts.current = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const pane = panes[focused];
    const cycleTab = (step: number) => {
      if (!pane || pane.tabs.length < 2 || !pane.active) return;
      const i = pane.tabs.indexOf(pane.active);
      void selectTab(focused, pane.tabs[(i + step + pane.tabs.length) % pane.tabs.length]);
    };
    if (debug && !debug.postMortem) {
      if (key === "F6" || key === "F10") return session.resume("next"), true;
      if (key === "F7" || (key === "F11" && !e.shiftKey)) return session.resume("stepIn"), true;
      if (key === "F8" || (key === "F11" && e.shiftKey)) return session.resume("stepOut"), true;
      if (key === "F5" || (e.ctrlKey && e.metaKey && key === "y")) return session.resume("continue"), true;
    }
    if ((mod && !e.shiftKey && key === "r") || (key === "F5" && !debug)) return void run(), true;
    if (mod && key === ".") return session.stop(), true;
    if (mod && !e.shiftKey && key === "l") return setJump({ initial: ":" }), true;
    if (mod && e.shiftKey && key === "o") return setJump({ initial: "" }), true;
    if (mod && e.shiftKey && key === "f") return setFindOpen(true), true;
    if (mod && key === ",") return setSettingsOpen(true), true;
    if (mod && !e.shiftKey && key === "w" && file) return closeTab(file), true;
    if (mod && key === "\\" && wide) return setSplit(!split), true;
    if (mod && e.shiftKey && (key === "[" || key === "{")) return cycleTab(-1), true;
    if (mod && e.shiftKey && (key === "]" || key === "}")) return cycleTab(1), true;
    if (key === "F9" && file && !isExternal(file)) {
      const view = focusedEditor.current?.view();
      if (!view) return false;
      const line = view.state.doc.lineAt(view.state.selection.main.head).number;
      if (breakpoints.get(file).some((bp) => bp.line === line)) breakpoints.remove(file, line);
      else breakpoints.add(file, codeLineFrom(view.state.doc.toString(), line));
      return true;
    }
    return false;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shortcuts.current(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Traceback links in the console.
  useEffect(() => {
    navigation.setHandler((path, line, column) => void api.current.openLocation(path, line, column).catch(() => toast(`Could not open ${basename(path)}`)));
    return () => navigation.setHandler(null);
  }, []);

  // ty sees the folder the program runs in: its modules import like top-level ones.
  const rootDir = file && !isExternal(file) ? dirname(file) : null;
  const rootSynced = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (rootDir === null) return;
    let live = true;
    rootSynced.current = (async () => {
      try {
        const tree = await fs.tree(rootDir);
        const decoder = new TextDecoder();
        const files = tree
          .filter((f) => f.path.endsWith(".py") || f.path.endsWith(".pyi"))
          .slice(0, 300)
          .map((f) => ({ path: join(rootDir, f.path), text: decoder.decode(base64ToBytes(f.data)) }));
        if (!live) return;
        // Files on screen may have edits that are not saved yet.
        const current = files.map((f) => ({ path: f.path, text: editors.current.map((ed) => textIn(ed, f.path)).find((t) => t !== null) ?? f.text }));
        await analysis.sync(current);
        await analysis.setRoot(rootDir);
        // Imports of those modules may have been flagged before ty knew them.
        for (const ed of editors.current) {
          const view = ed?.view();
          if (view) forceLinting(view);
        }
      } catch {
        // analysis is best effort
      }
    })();
    return () => {
      live = false;
    };
  }, [rootDir, analysisKey]);
  rootSyncedRef = rootSynced;

  // Files written by a program show up in the browser and in open tabs.
  useEffect(() => {
    session.onFilesChanged = (paths) => {
      setRefreshKey((k) => k + 1);
      // A UI app saving its data every second should not make ty re-read the folder.
      if (paths.some((p) => /\.pyi?$/.test(p))) setAnalysisKey((k) => k + 1);
      for (const path of paths) {
        if (!panes.some((p) => p.tabs.includes(path))) continue;
        void fs.readText(path).then((text) => {
          setDocs((d) => ({ ...d, [path]: text }));
          editors.current.forEach((ed) => ed?.replaceText(path, text));
        }, () => {});
      }
    };
  }, [panes]);

  // A stable controller (for the self-test) that always calls the latest closures.
  const api = useRef<AppController>(null!);
  api.current = {
    openFile,
    openLocation: (path, line, column) => openLocation(path, { line, column, keepConsole: true }),
    currentFile: () => file,
    run,
    editor: () => focusedEditor.current,
    save: flush,
    showPane: (p) => {
      setProblemsOpen(false);
      if (p === "console") return wide ? setConsoleDocked(true) : setDetent("half");
      setPage(p);
    },
    format,
    problems: () => problems,
    goToDefinition,
    showInfo,
    panes: () => panes,
    setSplit,
    closeTab,
  };
  useEffect(() => {
    const c = api.current;
    const forward = Object.fromEntries(Object.keys(c).map((k) => [k, (...args: unknown[]) => (api.current as any)[k](...args)]));
    onReady?.(forward as unknown as AppController);
  }, [onReady]);

  // -- file actions on the open file ------------------------------------------------------

  const onRenamed = (from: string, to: string) => {
    breakpoints.rename(from, to);
    const moved = (p: string) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    editors.current.forEach((ed) => ed?.renamePath(from, to));
    setPanes((ps) => ps.map((p) => ({ tabs: p.tabs.map(moved), active: p.active && moved(p.active) })));
    setDocs((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [moved(k), v])));
    for (const [path, text] of [...pending.current]) {
      if (moved(path) !== path) {
        pending.current.delete(path);
        pending.current.set(moved(path), text);
      }
    }
  };
  const onDeleted = (path: string) => {
    breakpoints.removeAll(path);
    const gone = (p: string) => p === path || p.startsWith(path + "/");
    for (const p of [...pending.current.keys()]) if (gone(p)) pending.current.delete(p);
    editors.current.forEach((ed) => ed?.forget(path));
    setPanes((ps) => {
      const next = ps.map((p) => p.tabs.filter(gone).reduce(withoutTab, p));
      return next.length > 1 && !next[1].tabs.length ? [next[0]] : next;
    });
  };

  const renameOpen = async () => {
    if (!file || fileIsExternal) return;
    const name = prompt(`Rename “${basename(file)}”`, basename(file));
    if (!name?.trim() || name.includes("/") || name.trim() === basename(file)) return;
    const to = join(dirname(file), name.trim());
    if (await fs.exists(to)) return alert(`“${name.trim()}” already exists.`);
    await flush();
    await fs.rename(file, to);
    onRenamed(file, to);
    refreshFiles();
  };
  const duplicateOpen = async () => {
    if (!file || fileIsExternal) return;
    await flush();
    const name = basename(file);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = 2;
    while (await fs.exists(join(dirname(file), `${stem} ${n}${ext}`))) n++;
    const copy = join(dirname(file), `${stem} ${n}${ext}`);
    await fs.writeText(copy, textIn(focusedEditor.current, file) ?? (await fs.readText(file)));
    refreshFiles();
    await openFile(copy);
    toast(`Duplicated as “${basename(copy)}”`);
  };
  const deleteOpen = async () => {
    if (!file || fileIsExternal || !confirm(`Delete “${basename(file)}”? This cannot be undone.`)) return;
    pending.current.delete(file);
    await fs.remove(file);
    onDeleted(file);
    refreshFiles();
    if (!wide) setPage("files");
  };

  const editorMenu = (anchor: DOMRect) =>
    setMenu({
      anchor,
      sections: [
        [
          { label: "Go to…", icon: <ListBullet size={19} />, onSelect: () => setJump({ initial: "" }) },
          { label: "Jump to Definition", icon: <JumpTo size={19} />, onSelect: () => void goToDefinition(), disabled: fileIsExternal },
          { label: "Show Info", icon: <Info size={19} />, onSelect: () => void showInfo(), disabled: fileIsExternal },
        ],
        [
          { label: "Find", icon: <Search size={19} />, onSelect: () => focusedEditor.current?.command("search") },
          { label: `Find in ${dir ? displayName(dir) : "Files"}…`, icon: <Search size={19} />, onSelect: () => setFindOpen(true) },
          { label: "Format Code", icon: <Wand size={19} />, onSelect: () => void format(), disabled: fileIsExternal },
          { label: "Show Problems", icon: <Warning size={19} />, onSelect: () => setProblemsOpen(true), disabled: !problems.errors && !problems.warnings },
        ],
        ...(fileBreakpoints.length && file
          ? [[{ label: fileBreakpoints.length === 1 ? "Remove Breakpoint" : `Remove ${fileBreakpoints.length} Breakpoints`, icon: <BreakpointIcon />, onSelect: () => breakpoints.clear(file) }]]
          : []),
        [
          ...(wide ? [{ label: split ? "Close Split View" : "Split View", icon: <SplitView size={19} />, onSelect: () => setSplit(!split) }] : []),
          { label: "Settings…", icon: <Gear size={19} />, onSelect: () => setSettingsOpen(true) },
        ],
        ...(fileIsExternal
          ? [[{ label: "Close Tab", icon: <Close size={17} />, onSelect: () => file && closeTab(file) }]]
          : [
              [
                { label: "Rename…", icon: <Pencil size={19} />, onSelect: () => void renameOpen() },
                { label: "Duplicate", icon: <Duplicate size={19} />, onSelect: () => void duplicateOpen() },
              ],
              [{ label: "Delete", icon: <Trash size={19} />, destructive: true, onSelect: () => void deleteOpen() }],
            ]),
      ],
    });

  // -- debugger (D23) --------------------------------------------------------------------

  const debug = state.debug;
  const debugFrame = debug ? debug.frames[debug.selected] : null;

  // Long-press a line number: add a breakpoint, or edit the one that is there.
  const onGutterLongPress = (index: number) => (path: string, line: number, rect: DOMRect) => {
    if (isExternal(path)) return;
    const existing = breakpoints.get(path).find((bp) => bp.line === line);
    if (!existing) {
      haptic();
      breakpoints.add(path, codeLineFrom(textIn(editors.current[index], path) ?? "", line));
      return;
    }
    const count = breakpoints.get(path).length;
    setMenu({
      anchor: rect,
      align: "start",
      sections: [
        [
          existing.enabled
            ? { label: "Disable Breakpoint", icon: <BreakpointIcon off />, onSelect: () => breakpoints.setEnabled(path, line, false) }
            : { label: "Enable Breakpoint", icon: <BreakpointIcon />, onSelect: () => breakpoints.setEnabled(path, line, true) },
          { label: "Remove Breakpoint", icon: <Trash size={19} />, destructive: true, onSelect: () => breakpoints.remove(path, line) },
        ],
        ...(count > 1 ? [[{ label: `Remove All ${count} in File`, destructive: true, onSelect: () => breakpoints.clear(path) }]] : []),
      ],
    });
  };

  // Follow the paused frame: show the editor and open its file.
  useEffect(() => {
    if (!debugFrame) return;
    if (!wide) setPage("editor");
    if (!panes.some((p, i) => p.active === debugFrame.file && (split || i === focused))) {
      void openLocation(debugFrame.file, { keepConsole: true }).catch(() => {});
    }
  }, [debug?.stopId, debug?.selected]);
  // Keep the paused line visible above the sheet; a stale popover goes away.
  useEffect(() => {
    if (debug && !wide && detent === "full") setDetent("half");
  }, [debug?.stopId]);
  useEffect(() => setInspect(null), [debug?.stopId, debug?.selected, !!debug]);

  // -- views -----------------------------------------------------------------------------

  const running = state.status !== "idle";
  const lastRun = state.runs[state.lines.at(-1)?.runId ?? -1];
  const runningHere = running && state.runningFile === file;

  const browser = (
    <FileBrowser
      dir={dir}
      currentFile={file}
      refreshKey={refreshKey}
      onOpenDir={setDir}
      onOpenFile={(p) => void openFile(p)}
      onRenamed={onRenamed}
      onDeleted={onDeleted}
      onSave={flush}
      onFind={() => setFindOpen(true)}
      onSettings={() => setSettingsOpen(true)}
    />
  );

  // Saving is automatic, so the subtitle only reports a running program
  // (and the folder on iPad, where there is no back button showing it).
  const problemCount = problems.errors + problems.warnings;
  const subtitle = debug
    ? pausedSummary(debug)
    : runningHere
      ? runSummary(lastRun, state.awaitingInput)
      : fileIsExternal
        ? "Read only"
        : wide && file && dirname(file) ? displayName(dirname(file)) : "";

  const editorNav = (
    <header className="nav-bar editor-nav">
      <div className="nav-left">
        {wide ? (
          <button className="glass-button" onClick={() => setSidebar((s) => !s)} aria-label="Toggle sidebar">
            <Sidebar size={21} />
          </button>
        ) : (
          <button className="nav-back" onClick={() => { void flush(); setProblemsOpen(false); setPage("files"); }} aria-label="Back to files">
            <ChevronLeft size={22} />
            <span className="nav-back-label">{dir ? displayName(dir) : "Files"}</span>
          </button>
        )}
      </div>
      <div className="nav-title">
        {file ? (
          <button className="nav-title-main nav-title-button" onClick={() => setJump({ initial: "" })} aria-label={`${tabLabel(file)}: go to a symbol or line`}>
            {tabLabel(file)}
            <ChevronDown size={12} className="nav-title-chevron" />
          </button>
        ) : (
          <span className="nav-title-main">Pyslopnista</span>
        )}
        {subtitle ? (
          <span className={`nav-subtitle ${debug ? (debug.postMortem ? "debug-error" : "paused") : runningHere ? "running" : ""}`}>{subtitle}</span>
        ) : problemCount > 0 ? (
          <button className={`nav-subtitle problems ${problems.errors ? "error" : "warning"}`} onClick={() => setProblemsOpen(true)}>
            <Warning size={12} /> {problemCount === 1 ? "1 problem" : `${problemCount} problems`}
          </button>
        ) : null}
      </div>
      <div className="nav-right">
        {wide && debug && <DebugBar debug={debug} compact />}
        {wide && (
          <button className={`glass-button ${consoleDocked ? "active" : ""}`} onClick={() => setConsoleDocked((c) => !c)} aria-label="Toggle console">
            <Terminal size={21} />
          </button>
        )}
        <button className="glass-button" onClick={(e) => editorMenu(e.currentTarget.getBoundingClientRect())} disabled={!file} aria-label="More">
          <Ellipsis size={22} />
        </button>
        {debug && !debug.postMortem ? (
          <ContinueButton />
        ) : runningHere || (running && !file) ? (
          <button className="run-button stop" onClick={() => { haptic(); session.stop(); }} aria-label="Stop">
            <Stop size={18} />
          </button>
        ) : (
          <button className="run-button" onClick={() => void run()} disabled={!file || running || fileIsExternal} aria-label="Run">
            <Play size={19} />
          </button>
        )}
      </div>
    </header>
  );

  const emptyState = (
    <div className="editor-empty">
      <FileIcon name="x.py" size={64} />
      <p className="empty-title">No File Open</p>
      <p className="empty-text">Pick a file or create a new one.</p>
      <div className="empty-actions">
        <button className="filled-button" onClick={() => (wide ? setSidebar(true) : setPage("files"))}>Browse Files</button>
        <button className="tinted-button" onClick={async () => {
          const name = prompt("Name of the new file", "untitled.py");
          if (!name?.trim()) return;
          const path = join(dir, name.includes(".") ? name.trim() : `${name.trim()}.py`);
          await fs.writeText(path, "");
          refreshFiles();
          await openFile(path);
        }}>
          <DocPlus size={18} /> New File
        </button>
      </div>
    </div>
  );

  const visibleFraction = wide ? 0.9 : detent === "peek" ? 0.85 : detent === "half" ? 0.45 : 0.15;

  /** One editor pane: its tab bar and editor. */
  const renderPane = (index: number) => {
    const pane = panes[index];
    const active = pane?.active ?? null;
    // Never show a file before its text is loaded: the editor would create an
    // empty document for it (and saving would write that back).
    const shown = active && docs[active] !== undefined ? active : null;
    const showTabs = wide || (pane?.tabs.length ?? 0) > 1;
    return (
      <div
        key={index}
        className={`editor-pane ${split && index === focused ? "focused" : ""}`}
        onPointerDownCapture={() => index !== focusedPane && setFocusedPane(index)}
        style={split ? { flex: `${index === 0 ? splitRatio : 1 - splitRatio} 1 0` } : undefined}
      >
        {showTabs && pane && (
          <TabBar
            tabs={pane.tabs}
            active={active}
            focused={split && index === focused}
            running={running ? state.runningFile : null}
            onSelect={(p) => void selectTab(index, p)}
            onClose={(p) => closeTab(p, index)}
            onMenu={(p, rect) => tabMenu(index, p, rect)}
            trailing={wide ? (split && index === 1 ? { label: "Close Split View", icon: "close", onClick: () => setSplit(false) } : !split ? { label: "Split View", icon: "split", onClick: () => setSplit(true) } : undefined) : undefined}
          />
        )}
        <div className="editor-area">
          <Editor
            ref={(h) => {
              editors.current[index] = h;
            }}
            path={shown}
            text={shown ? docs[shown] : ""}
            readOnly={!!shown && isExternal(shown)}
            onChange={onChange(index)}
            onFocusChange={(f) => {
              if (f && index !== focusedPane) setFocusedPane(index);
              setEditorFocused(f);
            }}
            onViewUpdate={(view) => index === focused && setProblems(summarizeProblems(view))}
            onGutterLongPress={onGutterLongPress(index)}
            onDefinition={() => void goToDefinition()}
            onInfo={() => void showInfo()}
            paused={!!debug}
            onInspect={(expr, anchor) => setInspect({ expr, anchor })}
            debugLine={debugFrame && debugFrame.file === shown ? debugFrame.line : null}
            visibleFraction={visibleFraction}
            reveal={reveal && reveal.pane === index ? reveal : null}
          />
          {!active && emptyState}
        </div>
      </div>
    );
  };

  // Dragging the divider between the two panes.
  const divider = useRef<{ x: number; ratio: number; width: number } | null>(null);
  const dividerHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      const row = (e.currentTarget as HTMLElement).parentElement!;
      divider.current = { x: e.clientX, ratio: splitRatio, width: row.clientWidth };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = divider.current;
      if (d) setSplitRatio(Math.max(0.25, Math.min(0.75, d.ratio + (e.clientX - d.x) / d.width)));
    },
    onPointerUp: () => {
      divider.current = null;
    },
  };

  const editorPanes = (
    <div className={`pane-row ${split ? "split" : ""}`}>
      {split ? (
        <>
          {renderPane(0)}
          <div className="pane-divider" {...dividerHandlers} onDoubleClick={() => setSplitRatio(0.5)} role="separator" aria-label="Resize split view" />
          {renderPane(1)}
        </>
      ) : (
        renderPane(focused)
      )}
    </div>
  );

  const problemBar = file && !debug && !fileIsExternal && (wide || editorFocused || detent === "peek") && (
    <ProblemBar summary={problems} view={focusedEditor.current?.view() ?? null} onShowAll={() => setProblemsOpen(true)} />
  );
  const webKeyBar = !isNative && (editorFocused || location.hash.includes("keybar")) && <KeyBar editor={focusedEditor} onDismiss={() => focusedEditor.current?.blur()} />;

  // Edge swipe from the left goes back to the file list (iPhone). Touch
  // events, not pointer events: a non-passive touchmove can claim the gesture
  // with preventDefault before the browser starts panning, which would cancel
  // pointer events half-way (and left the pages pinned mid-swipe). Taps are
  // never captured, so the "<" of the back button and the gutter keep working.
  const editorPageRef = useRef<HTMLDivElement>(null);
  const goBackRef = useRef<() => void>(() => {});
  goBackRef.current = () => {
    void flush();
    setPage("files");
  };
  useEffect(() => {
    const el = editorPageRef.current;
    if (!el) return;
    let start: { x: number; y: number; id: number; swiping: boolean } | null = null;
    const find = (list: TouchList) => [...list].find((t) => t.identifier === start?.id);
    const onStart = (e: TouchEvent) => {
      const t = e.touches.length === 1 ? e.touches[0] : null;
      start = t && t.clientX < 22 ? { x: t.clientX, y: t.clientY, id: t.identifier, swiping: false } : null;
    };
    const onMove = (e: TouchEvent) => {
      const t = start && find(e.changedTouches);
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = Math.abs(t.clientY - start.y);
      if (!start.swiping) {
        if (dy > 10 && dy > dx) {
          start = null; // a vertical scroll, not a swipe
          return;
        }
        if (dx < 8) return;
        start.swiping = true;
      }
      e.preventDefault();
      setEdgeDrag(Math.max(0, dx));
    };
    const onEnd = (e: TouchEvent) => {
      const t = start && find(e.changedTouches);
      if (!start || !t) return;
      const done = e.type === "touchend" && start.swiping && t.clientX - start.x > window.innerWidth * 0.33;
      start = null;
      setEdgeDrag(null);
      if (done) goBackRef.current();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [wide]); // the narrow layout (with this page) mounts when the window narrows
  // Whatever happens to a swipe, a page change must never keep the pages
  // pinned (the inline transform would override every later transition).
  useEffect(() => {
    setEdgeDrag(null);
    // Nothing on the off-screen editor page keeps focus: WebKit refocuses the
    // last focused element when the app comes back, which would reveal it.
    const active = document.activeElement;
    if (page === "files" && !wide && active instanceof HTMLElement && editorPageRef.current?.contains(active)) active.blur();
  }, [page]);

  const overlays = (
    <>
      {state.uiOpen && !debug && <UIAppView />}
      {menu && <Menu anchor={menu.anchor} sections={menu.sections} align={menu.align} onClose={() => setMenu(null)} />}
      {inspect && debug && <ValuePopover expr={inspect.expr} anchor={inspect.anchor} onClose={() => setInspect(null)} />}
      {problemsOpen && focusedEditor.current?.view() && <ProblemsSheet view={focusedEditor.current.view()!} onClose={() => setProblemsOpen(false)} />}
      {jump && focusedEditor.current?.view() && (
        <JumpPanel state={focusedEditor.current.view()!.state} initial={jump.initial} onJump={goToLine} onClose={() => setJump(null)} />
      )}
      {findOpen && (
        <FindPanel
          dir={file && !isExternal(file) ? dirname(file) : dir}
          beforeSearch={flush}
          onOpen={(path, line, column) => void openLocation(path, { line, column, keepConsole: true })}
          onClose={() => setFindOpen(false)}
        />
      )}
      {info && <InfoPopover markdown={info.markdown} anchor={info.anchor} onClose={() => setInfo(null)} />}
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      <ToastHost />
    </>
  );

  if (wide) {
    // Split view needs the width: the console moves below the editors.
    const consoleSide = landscape && !split ? "right" : "bottom";
    return (
      <div className={`app wide ${sidebar ? "with-sidebar" : ""} ${debug?.postMortem ? "inspecting-error" : ""}`}>
        {sidebar && <aside className="sidebar">{browser}</aside>}
        <main className="workspace">
          {editorNav}
          <div className={`split ${consoleSide}`}>
            <div className="editor-column">
              {editorPanes}
              {problemBar}
              {webKeyBar}
            </div>
            {consoleDocked && (
              <div className="console-dock">
                <Console
                  state={state}
                  header={
                    <div className="dock-header">
                      <span className={`status-dot ${lastRun?.status ?? "none"} ${state.awaitingInput ? "input" : ""} ${debug ? "paused" : ""}`} />
                      <span className="dock-title">{debug ? (debug.postMortem ? "Inspecting Error" : "Paused") : "Console"}</span>
                      {state.status === "running" && !debug && <PauseButton disabled={state.awaitingInput || state.pausing} />}
                    </div>
                  }
                />
              </div>
            )}
          </div>
        </main>
        {overlays}
      </div>
    );
  }

  const editorShown = page !== "files";
  return (
    <div className={`app narrow ${debug?.postMortem ? "inspecting-error" : ""}`}>
      {/* Leaving the editor closes editor-only overlays. */}
      <div className={`page files-page ${editorShown ? (edgeDrag !== null ? "behind dragging" : "behind") : "active"}`}
        style={edgeDrag !== null ? { transform: `translateX(${-30 + (edgeDrag / window.innerWidth) * 30}%)` } : undefined}>
        {browser}
      </div>
      <div
        className={`page editor-page ${editorShown ? "active" : "ahead"} ${edgeDrag !== null ? "dragging" : ""}`}
        style={edgeDrag !== null ? { transform: `translateX(${edgeDrag}px)` } : undefined}
        ref={editorPageRef}
      >
        {editorNav}
        <div className="editor-stage">
          {editorPanes}
          {problemBar}
          {webKeyBar}
          {!editorFocused && <div className="sheet-spacer" />}
          <ConsoleSheet state={state} hidden={editorFocused} detent={detent} onDetent={setDetent} />
        </div>
      </div>
      {overlays}
    </div>
  );
}
