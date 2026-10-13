import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Console } from "./Console";
import { Editor, type EditorHandle } from "./Editor";
import { FileBrowser } from "./FileBrowser";
import { PlayIcon, StopIcon } from "./Icons";
import { basename, dirname, fs, haptic } from "./host";
import { KeyBar } from "./KeyBar";
import { session } from "./session";
import { UIAppView } from "./UIAppView";

const LAST_FILE_KEY = "pyslopnista.lastFile";
const WIDE_QUERY = "(min-width: 768px)";

type Pane = "files" | "editor" | "console";

function useWide() {
  const [wide, setWide] = useState(() => matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(WIDE_QUERY);
    const fn = () => setWide(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return wide;
}

export interface AppController {
  openFile(path: string, restoring?: boolean): Promise<void>;
  currentFile(): string | null;
  run(): Promise<void>;
  editor(): EditorHandle | null;
  save(): Promise<void>;
  showPane(pane: Pane): void;
}

export function App({ onReady }: { onReady?: (c: AppController) => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const wide = useWide();
  const editor = useRef<EditorHandle>(null);
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [fileText, setFileText] = useState("");
  const [pane, setPane] = useState<Pane>("files");
  const [editorFocused, setEditorFocused] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [refreshKey, setRefreshKey] = useState(0);
  const pending = useRef<{ path: string; text: string } | null>(null);
  const explicitlyOpened = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    async (path: string, restoring = false) => {
      if (!restoring) explicitlyOpened.current = true;
      else if (explicitlyOpened.current) return;
      await flush();
      const text = await fs.readText(path);
      setFile(path);
      setFileText(text);
      setDir(dirname(path));
      setPane("editor");
      localStorage.setItem(LAST_FILE_KEY, path);
    },
    [flush],
  );

  const run = useCallback(async () => {
    if (!file) return;
    haptic();
    pending.current = { path: file, text: editor.current?.getText() ?? fileText };
    await flush();
    editor.current?.blur();
    if (!wide) setPane("console");
    await session.runFile(file, editor.current?.getText() ?? fileText);
  }, [file, fileText, flush, wide]);

  // Files written by a program show up in the browser; reload the open file if it changed.
  useEffect(() => {
    session.onFilesChanged = (paths) => {
      setRefreshKey((k) => k + 1);
      if (file && paths.includes(file)) void fs.readText(file).then(setFileText);
    };
  }, [file]);

  useEffect(() => {
    const last = localStorage.getItem(LAST_FILE_KEY);
    if (last) {
      fs.exists(last).then((ok) => {
        if (ok && !explicitlyOpened.current) void openFile(last, true).then(() => !explicitlyOpened.current && setPane(wide ? "editor" : "files"));
      });
    }
  }, []);

  // A stable controller (for the self-test) that always calls the latest closures.
  const api = useRef<AppController>(null!);
  api.current = { openFile, currentFile: () => file, run, editor: () => editor.current, save: flush, showPane: setPane };
  useEffect(() => {
    onReady?.({
      openFile: (p) => api.current.openFile(p),
      currentFile: () => api.current.currentFile(),
      run: () => api.current.run(),
      editor: () => api.current.editor(),
      save: () => api.current.save(),
      showPane: (p) => api.current.showPane(p),
    });
  }, [onReady]);

  const onRenamed = (from: string, to: string) => {
    if (file === from || file?.startsWith(from + "/")) {
      const next = to + file.slice(from.length);
      setFile(next);
      localStorage.setItem(LAST_FILE_KEY, next);
    }
  };
  const onDeleted = (path: string) => {
    if (file === path || file?.startsWith(path + "/")) {
      pending.current = null;
      setFile(null);
      setFileText("");
      localStorage.removeItem(LAST_FILE_KEY);
    }
  };

  const running = state.status !== "idle";
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

  const showEditor = wide || pane === "editor";
  const showConsole = wide || pane === "console";

  return (
    <div className={`app ${wide ? "wide" : "narrow"}`}>
      {wide && <aside className="sidebar">{browser}</aside>}
      {!wide && pane === "files" && <div className="page">{browser}</div>}
      {/* Stays mounted while the file list is shown, so edits and undo history survive. */}
      {(wide || file !== null || pane !== "files") && (
        <main className="workspace" hidden={!wide && pane === "files"}>
          <header className="toolbar">
            {!wide && (
              <button className="nav-button" onClick={() => { void flush(); setPane("files"); }}>
                ‹ Files
              </button>
            )}
            <div className="toolbar-title">
              <span className="file-name">{file ? basename(file) : "No file"}</span>
              <span className={`save-dot ${saveState}`} title={saveState} />
            </div>
            {!wide && (
              <div className="segmented">
                <button className={pane === "editor" ? "on" : ""} onClick={() => setPane("editor")}>Code</button>
                <button className={pane === "console" ? "on" : ""} onClick={() => setPane("console")}>
                  Console{state.lines.length > 0 && pane !== "console" ? " •" : ""}
                </button>
              </div>
            )}
            {running ? (
              <button className="run-button stop" onClick={() => session.stop()} aria-label="Stop"><StopIcon /></button>
            ) : (
              <button className="run-button" onClick={() => void run()} disabled={!file} aria-label="Run"><PlayIcon /></button>
            )}
          </header>
          <div className="panes">
            <div className="editor-pane" hidden={!showEditor}>
              <Editor ref={editor} path={file} text={fileText} onChange={onChange} onFocusChange={setEditorFocused} />
              {!file && <div className="editor-empty">Open a file from the browser or create a new one.</div>}
            </div>
            {showConsole && (
              <div className="console-pane">
                <div className="console-header">
                  <span>{running ? (state.awaitingInput ? "Waiting for input" : "Running…") : state.runningFile ? basename(state.runningFile) : "Console"}</span>
                  <button className="nav-button" onClick={() => session.clear()}>Clear</button>
                </div>
                <Console state={state} />
              </div>
            )}
          </div>
          {(editorFocused || location.hash.includes("keybar")) && showEditor && <KeyBar editor={editor} onDismiss={() => editor.current?.blur()} />}
        </main>
      )}
      {state.uiOpen && <UIAppView />}
    </div>
  );
}
