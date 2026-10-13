import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { formatDocument } from "./analysis/codemirror";
import { analysis } from "./analysis/client";
import { Console, runSummary } from "./Console";
import { ConsoleSheet, type Detent } from "./ConsoleSheet";
import { breakpoints } from "./debug/breakpoints";
import { ContinueButton, DebugBar, PauseButton, pausedSummary, ValuePopover } from "./debug/DebugViews";
import { Editor, type EditorCommand, type EditorHandle } from "./Editor";
import { FileBrowser } from "./FileBrowser";
import { basename, call, dirname, fs, haptic, isNative, join } from "./host";
import { ChevronLeft, DocPlus, Duplicate, Ellipsis, FileIcon, Pencil, Play, Search, Sidebar, Stop, Terminal, Trash, Wand, Warning } from "./Icons";
import { KeyBar } from "./KeyBar";
import { ProblemBar, type ProblemSummary, summarizeProblems } from "./ProblemBar";
import { ProblemsSheet } from "./ProblemsSheet";
import { session } from "./session";
import { UIAppView } from "./UIAppView";
import { Menu, type MenuSection } from "./ui/Menu";
import { toast, ToastHost } from "./ui/Toast";

const LAST_FILE_KEY = "pyslopnista.lastFile";
const WIDE_QUERY = "(min-width: 768px)";

type Pane = "files" | "editor" | "console";

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
  currentFile(): string | null;
  run(): Promise<void>;
  editor(): EditorHandle | null;
  save(): Promise<void>;
  showPane(pane: Pane): void;
  format(): Promise<void>;
  problems(): ProblemSummary;
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

export function App({ onReady }: { onReady?: (c: AppController) => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const wide = useMedia(WIDE_QUERY);
  const landscape = useMedia("(min-aspect-ratio: 4/3)");
  const editor = useRef<EditorHandle>(null);
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [fileText, setFileText] = useState("");
  const [pane, setPane] = useState<Pane>("files");
  const [editorFocused, setEditorFocused] = useState(false);
  const [, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [refreshKey, setRefreshKey] = useState(0);
  const [problems, setProblems] = useState<ProblemSummary>({ errors: 0, warnings: 0, current: null });
  const [menu, setMenu] = useState<{ anchor: DOMRect; sections: MenuSection[]; align?: "start" | "end" } | null>(null);
  const [inspect, setInspect] = useState<{ expr: string; anchor: DOMRect } | null>(null);
  useSyncExternalStore(breakpoints.subscribe, breakpoints.getSnapshot);
  const fileBreakpoints = breakpoints.get(file);
  const [detent, setDetent] = useState<Detent>("peek");
  const [sidebar, setSidebar] = useState(true);
  const [consoleDocked, setConsoleDocked] = useState(true);
  const [edgeDrag, setEdgeDrag] = useState<number | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const pending = useRef<{ path: string; text: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explicitlyOpened = useRef(false);

  // Start ruff + ty in the background; the first check would do it anyway.
  useEffect(() => {
    void analysis.init().catch(() => {});
  }, []);

  // Native keyboard accessory: keys come in through window.__pyslopKey and we
  // tell the host which kind of field has focus.
  useEffect(() => {
    (window as any).__pyslopKey = (action: string) => handleKey(editor.current, action);
    if (!isNative) return;
    let mode = "";
    const onFocus = (e: FocusEvent) => {
      const target = e.target as Element | null;
      const next = target?.closest?.(".cm-editor, .repl") ? "code" : "plain";
      if (next !== mode) {
        mode = next;
        void call("keyboard.mode", { mode });
      }
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setSaveState("saving");
    await fs.writeText(p.path, p.text);
    setSaveState(pending.current ? "dirty" : "saved");
  }, []);

  const onChange = useCallback(
    (path: string, text: string) => {
      pending.current = { path, text };
      setSaveState("dirty");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), 700);
    },
    [flush],
  );

  const openFile = useCallback(
    async (path: string, restoring = false, keepConsole = false) => {
      if (!restoring) explicitlyOpened.current = true;
      else if (explicitlyOpened.current) return;
      await flush();
      const text = await fs.readText(path);
      setFile(path);
      setFileText(text);
      setDir(dirname(path));
      setPane("editor");
      if (path !== file && !keepConsole) setDetent("peek");
      setProblemsOpen(false);
      localStorage.setItem(LAST_FILE_KEY, path);
    },
    [flush, file],
  );

  const run = useCallback(async () => {
    if (!file) return;
    haptic();
    pending.current = { path: file, text: editor.current?.getText() ?? fileText };
    await flush();
    editor.current?.blur();
    if (!wide) setPane("editor");
    if (wide) setConsoleDocked(true);
    await session.runFile(file, editor.current?.getText() ?? fileText);
  }, [file, fileText, flush, wide]);

  const format = useCallback(async () => {
    const view = editor.current?.view();
    if (!view) return;
    try {
      toast((await formatDocument(view)) ? "Formatted" : "Already formatted");
    } catch (e) {
      toast(`Could not format: ${(e as Error).message}`);
    }
  }, []);

  // Files written by a program show up in the browser; reload the open file if it changed.
  useEffect(() => {
    session.onFilesChanged = (paths) => {
      setRefreshKey((k) => k + 1);
      if (file && paths.includes(file)) void fs.readText(file).then(setFileText);
    };
  }, [file]);

  useEffect(() => {
    const last = localStorage.getItem(LAST_FILE_KEY);
    if (!last) return;
    fs.exists(last).then((ok) => {
      if (ok && !explicitlyOpened.current) void openFile(last, true).then(() => !explicitlyOpened.current && setPane(wide ? "editor" : "files"));
    });
  }, []);

  // A stable controller (for the self-test) that always calls the latest closures.
  const api = useRef<AppController>(null!);
  api.current = {
    openFile, currentFile: () => file, run, editor: () => editor.current, save: flush,
    showPane: (p) => {
      setProblemsOpen(false);
      if (p === "console") return wide ? setConsoleDocked(true) : setDetent("half");
      setPane(p);
    },
    format, problems: () => problems,
  };
  useEffect(() => {
    onReady?.({
      openFile: (p, r) => api.current.openFile(p, r),
      currentFile: () => api.current.currentFile(),
      run: () => api.current.run(),
      editor: () => api.current.editor(),
      save: () => api.current.save(),
      showPane: (p) => api.current.showPane(p),
      format: () => api.current.format(),
      problems: () => api.current.problems(),
    });
  }, [onReady]);

  // -- file actions on the open file ------------------------------------------------------

  const renameOpen = async () => {
    if (!file) return;
    const name = prompt(`Rename “${basename(file)}”`, basename(file));
    if (!name?.trim() || name.includes("/") || name.trim() === basename(file)) return;
    const to = join(dirname(file), name.trim());
    if (await fs.exists(to)) return alert(`“${name.trim()}” already exists.`);
    await flush();
    await fs.rename(file, to);
    onRenamed(file, to);
    setRefreshKey((k) => k + 1);
  };
  const duplicateOpen = async () => {
    if (!file) return;
    await flush();
    const name = basename(file);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = 2;
    while (await fs.exists(join(dirname(file), `${stem} ${n}${ext}`))) n++;
    const copy = join(dirname(file), `${stem} ${n}${ext}`);
    await fs.writeText(copy, editor.current?.getText() ?? fileText);
    setRefreshKey((k) => k + 1);
    await openFile(copy);
    toast(`Duplicated as “${basename(copy)}”`);
  };
  const deleteOpen = async () => {
    if (!file || !confirm(`Delete “${basename(file)}”? This cannot be undone.`)) return;
    pending.current = null;
    await fs.remove(file);
    onDeleted(file);
    setRefreshKey((k) => k + 1);
    setPane("files");
  };

  const onRenamed = (from: string, to: string) => {
    breakpoints.rename(from, to);
    if (file === from || file?.startsWith(from + "/")) {
      const next = to + file.slice(from.length);
      setFile(next);
      setDir(dirname(next));
      localStorage.setItem(LAST_FILE_KEY, next);
    }
  };
  const onDeleted = (path: string) => {
    breakpoints.removeAll(path);
    if (file === path || file?.startsWith(path + "/")) {
      pending.current = null;
      setFile(null);
      setFileText("");
      localStorage.removeItem(LAST_FILE_KEY);
    }
  };

  const editorMenu = (anchor: DOMRect) =>
    setMenu({
      anchor,
      sections: [
        [
          { label: "Format Code", icon: <Wand size={19} />, onSelect: () => void format() },
          { label: "Find", icon: <Search size={19} />, onSelect: () => editor.current?.command("search") },
          { label: "Show Problems", icon: <Warning size={19} />, onSelect: () => setProblemsOpen(true), disabled: !problems.errors && !problems.warnings },
        ],
        ...(fileBreakpoints.length && file
          ? [[{ label: fileBreakpoints.length === 1 ? "Remove Breakpoint" : `Remove ${fileBreakpoints.length} Breakpoints`, icon: <BreakpointIcon />, onSelect: () => breakpoints.clear(file) }]]
          : []),
        [
          { label: "Rename…", icon: <Pencil size={19} />, onSelect: () => void renameOpen() },
          { label: "Duplicate", icon: <Duplicate size={19} />, onSelect: () => void duplicateOpen() },
        ],
        [{ label: "Delete", icon: <Trash size={19} />, destructive: true, onSelect: () => void deleteOpen() }],
      ],
    });

  // -- debugger (D23) --------------------------------------------------------------------

  const debug = state.debug;
  const debugFrame = debug ? debug.frames[debug.selected] : null;

  // Long-press a line number: add a breakpoint, or edit the one that is there.
  const onGutterLongPress = (line: number, rect: DOMRect) => {
    if (!file) return;
    const existing = breakpoints.get(file).find((bp) => bp.line === line);
    if (!existing) {
      haptic();
      breakpoints.add(file, codeLineFrom(editor.current?.getText() ?? "", line));
      return;
    }
    const count = breakpoints.get(file).length;
    setMenu({
      anchor: rect,
      align: "start",
      sections: [
        [
          existing.enabled
            ? { label: "Disable Breakpoint", icon: <BreakpointIcon off />, onSelect: () => breakpoints.setEnabled(file, line, false) }
            : { label: "Enable Breakpoint", icon: <BreakpointIcon />, onSelect: () => breakpoints.setEnabled(file, line, true) },
          { label: "Remove Breakpoint", icon: <Trash size={19} />, destructive: true, onSelect: () => breakpoints.remove(file, line) },
        ],
        ...(count > 1 ? [[{ label: `Remove All ${count} in File`, destructive: true, onSelect: () => breakpoints.clear(file) }]] : []),
      ],
    });
  };

  // Follow the paused frame: show the editor and open its file.
  useEffect(() => {
    if (!debugFrame) return;
    if (!wide) setPane("editor");
    if (debugFrame.file !== file) void openFile(debugFrame.file, false, true).catch(() => {});
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
    />
  );

  // Saving is automatic, so the subtitle only reports a running program
  // (and the folder on iPad, where there is no back button showing it).
  const problemCount = problems.errors + problems.warnings;
  const subtitle = debug ? pausedSummary(debug) : runningHere ? runSummary(lastRun, state.awaitingInput) : wide && file && dirname(file) ? basename(dirname(file)) : "";

  const editorNav = (
    <header className="nav-bar editor-nav">
      <div className="nav-left">
        {wide ? (
          <button className="glass-button" onClick={() => setSidebar((s) => !s)} aria-label="Toggle sidebar">
            <Sidebar size={21} />
          </button>
        ) : (
          <button className="nav-back" onClick={() => { void flush(); setProblemsOpen(false); setPane("files"); }} aria-label="Back to files">
            <ChevronLeft size={22} />
            <span className="nav-back-label">{dir ? basename(dir) : "Files"}</span>
          </button>
        )}
      </div>
      <div className="nav-title">
        <span className="nav-title-main">{file ? basename(file) : "Pyslopnista"}</span>
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
          <button className="run-button" onClick={() => void run()} disabled={!file || running} aria-label="Run">
            <Play size={19} />
          </button>
        )}
      </div>
    </header>
  );

  const editorBody = (
    <div className="editor-area">
      <Editor
        ref={editor}
        path={file}
        text={fileText}
        onChange={onChange}
        onFocusChange={setEditorFocused}
        onViewUpdate={(view) => setProblems(summarizeProblems(view))}
        breakpoints={fileBreakpoints}
        onBreakpointsChange={(path, list) => breakpoints.set(path, list)}
        onGutterLongPress={onGutterLongPress}
        paused={!!debug}
        onInspect={(expr, anchor) => setInspect({ expr, anchor })}
        debugLine={debugFrame && debugFrame.file === file ? debugFrame.line : null}
        visibleFraction={wide ? 0.9 : detent === "peek" ? 0.85 : detent === "half" ? 0.45 : 0.15}
      />
      {!file && (
        <div className="editor-empty">
          <FileIcon name="x.py" size={64} />
          <p className="empty-title">No File Open</p>
          <p className="empty-text">Pick a file or create a new one.</p>
          <div className="empty-actions">
            <button className="filled-button" onClick={() => (wide ? setSidebar(true) : setPane("files"))}>Browse Files</button>
            <button className="tinted-button" onClick={async () => {
              const name = prompt("Name of the new file", "untitled.py");
              if (!name?.trim()) return;
              const path = join(dir, name.includes(".") ? name.trim() : `${name.trim()}.py`);
              await fs.writeText(path, "");
              setRefreshKey((k) => k + 1);
              await openFile(path);
            }}>
              <DocPlus size={18} /> New File
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const problemBar = file && !debug && (wide || editorFocused || detent === "peek") && <ProblemBar summary={problems} view={editor.current?.view() ?? null} onShowAll={() => setProblemsOpen(true)} />;
  const webKeyBar = !isNative && (editorFocused || location.hash.includes("keybar")) && <KeyBar editor={editor} onDismiss={() => editor.current?.blur()} />;

  // Edge swipe from the left goes back to the file list (iPhone).
  const edgeStart = useRef<{ x: number; id: number } | null>(null);
  const edgeHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.clientX < 22 && e.pointerType !== "mouse") {
        edgeStart.current = { x: e.clientX, id: e.pointerId };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (edgeStart.current) setEdgeDrag(Math.max(0, e.clientX - edgeStart.current.x));
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!edgeStart.current) return;
      const dx = e.clientX - edgeStart.current.x;
      edgeStart.current = null;
      setEdgeDrag(null);
      if (dx > window.innerWidth * 0.33) {
        void flush();
        setPane("files");
      }
    },
  };

  if (wide) {
    const consoleSide = landscape ? "right" : "bottom";
    return (
      <div className={`app wide ${sidebar ? "with-sidebar" : ""} ${debug?.postMortem ? "inspecting-error" : ""}`}>
        {sidebar && <aside className="sidebar">{browser}</aside>}
        <main className="workspace">
          {editorNav}
          <div className={`split ${consoleSide}`}>
            <div className="editor-column">
              {editorBody}
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
        {state.uiOpen && !debug && <UIAppView />}
        {menu && <Menu anchor={menu.anchor} sections={menu.sections} align={menu.align} onClose={() => setMenu(null)} />}
        {inspect && debug && <ValuePopover expr={inspect.expr} anchor={inspect.anchor} onClose={() => setInspect(null)} />}
        {problemsOpen && editor.current?.view() && <ProblemsSheet view={editor.current.view()!} onClose={() => setProblemsOpen(false)} />}
        <ToastHost />
      </div>
    );
  }

  const editorShown = pane !== "files";
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
        {...edgeHandlers}
      >
        {editorNav}
        <div className="editor-stage">
          {editorBody}
          {problemBar}
          {webKeyBar}
          {!editorFocused && <div className="sheet-spacer" />}
          <ConsoleSheet state={state} hidden={editorFocused} detent={detent} onDetent={setDetent} />
        </div>
      </div>
      {state.uiOpen && !debug && <UIAppView />}
      {menu && <Menu anchor={menu.anchor} sections={menu.sections} align={menu.align} onClose={() => setMenu(null)} />}
      {inspect && debug && <ValuePopover expr={inspect.expr} anchor={inspect.anchor} onClose={() => setInspect(null)} />}
      {problemsOpen && editor.current?.view() && <ProblemsSheet view={editor.current.view()!} onClose={() => setProblemsOpen(false)} />}
      <ToastHost />
    </div>
  );
}
