// Console: runs as blocks (header + output), inline input() right where the
// program asked, ANSI colors, inline images, and the >>> prompt.
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { basename, join } from "./host";
import { navigation } from "./navigation";
import { PausedBlock } from "./debug/DebugViews";
import { CheckCircle, Error as ErrorIcon, Inspect, PauseCircle, StopCircle, Terminal, Trash } from "./Icons";
import type { Line, Run, SessionState } from "./session";
import { session } from "./session";

// -- ANSI SGR ---------------------------------------------------------------------------

const ANSI_16 = ["#000", "#c91b00", "#00a600", "#c7c400", "#2225c4", "#ca30c7", "#00a6b2", "#bfbfbf",
  "#686868", "#ff6e67", "#5ffa68", "#fffc67", "#6871ff", "#ff77ff", "#60fdff", "#fff"];

function color256(n: number): string {
  if (n < 16) return ANSI_16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (x: number) => (x ? 55 + x * 40 : 0);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

type Style = { color?: string; background?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean };

function renderAnsi(text: string): ReactNode {
  if (!text.includes("\x1b")) return text;
  const out: ReactNode[] = [];
  let style: Style = {};
  const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (s: string) => {
    if (!s) return;
    const css: React.CSSProperties = {
      color: style.color, background: style.background, fontWeight: style.bold ? 700 : undefined,
      opacity: style.dim ? 0.6 : undefined, fontStyle: style.italic ? "italic" : undefined,
      textDecoration: style.underline ? "underline" : undefined,
    };
    out.push(Object.values(css).some((v) => v !== undefined) ? <span key={out.length} style={css}>{s}</span> : s);
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== "m") continue; // cursor movement etc. is dropped
    const codes = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style = { ...style, bold: true };
      else if (c === 2) style = { ...style, dim: true };
      else if (c === 3) style = { ...style, italic: true };
      else if (c === 4) style = { ...style, underline: true };
      else if (c === 22) style = { ...style, bold: false, dim: false };
      else if (c === 23) style = { ...style, italic: false };
      else if (c === 24) style = { ...style, underline: false };
      else if (c >= 30 && c <= 37) style = { ...style, color: ANSI_16[c - 30] };
      else if (c >= 90 && c <= 97) style = { ...style, color: ANSI_16[c - 90 + 8] };
      else if (c >= 40 && c <= 47) style = { ...style, background: ANSI_16[c - 40] };
      else if (c >= 100 && c <= 107) style = { ...style, background: ANSI_16[c - 100 + 8] };
      else if (c === 39) style = { ...style, color: undefined };
      else if (c === 49) style = { ...style, background: undefined };
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const v = color256(codes[i + 2] ?? 0);
        style = c === 38 ? { ...style, color: v } : { ...style, background: v };
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const v = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        style = c === 38 ? { ...style, color: v } : { ...style, background: v };
        i += 4;
      }
    }
  }
  push(text.slice(last));
  return out;
}

// -- tracebacks --------------------------------------------------------------------------

const PROJECT_ROOT = "/home/pyodide/project/";
const FRAME_LINE = /^(\s*)(File "([^"]+)", line (\d+))(.*)$/;

/** The app path of a traceback's file, if it is one of the project's files. */
function projectPath(dir: string, filename: string): string | null {
  if (filename.startsWith("<")) return null;
  if (filename.startsWith(PROJECT_ROOT)) return join(dir, filename.slice(PROJECT_ROOT.length));
  if (filename.startsWith("/")) return null; // stdlib, site-packages, runtime
  return join(dir, filename);
}

/** stderr with `File "x.py", line 3` turned into links to that line. */
function renderTraceback(text: string, dir: string): ReactNode {
  if (text.includes("\x1b") || !text.includes('File "')) return renderAnsi(text);
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const m = FRAME_LINE.exec(line);
    const path = m && projectPath(dir, m[3]);
    const nl = i < lines.length - 1 ? "\n" : "";
    if (!m || !path) return <Fragment key={i}>{line}{nl}</Fragment>;
    return (
      <Fragment key={i}>
        {m[1]}
        <span
          className="tb-link"
          role="link"
          tabIndex={0}
          onClick={() => navigation.open(path, Number(m[4]))}
          onKeyDown={(e) => e.key === "Enter" && navigation.open(path, Number(m[4]))}
          title={`Show ${basename(path)}, line ${m[4]}`}
        >
          {m[2]}
        </span>
        {m[5]}
        {nl}
      </Fragment>
    );
  });
}

// -- run headers --------------------------------------------------------------------------

function duration(run: Run) {
  const ms = (run.endedAt ?? Date.now()) - run.startedAt;
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function runSummary(run: Run | undefined, awaitingInput: boolean, paused = false): string {
  if (!run) return "";
  switch (run.status) {
    case "running":
      return paused ? "Paused" : awaitingInput ? "Waiting for input" : "Running…";
    case "ok":
      return `Finished in ${duration(run)}`;
    case "error":
      return "Exited with an error";
    case "stopped":
      return "Stopped";
    case "crashed":
      return "Python crashed";
  }
}

function RunIcon({ run, paused }: { run: Run; paused: boolean }) {
  if (run.status === "running" && paused) return <PauseCircle size={16} className="run-icon paused" />;
  if (run.status === "running") return <span className="spinner" aria-label="running" />;
  if (run.status === "ok") return <CheckCircle size={16} className="run-icon ok" />;
  if (run.status === "stopped") return <StopCircle size={16} className="run-icon stopped" />;
  return <ErrorIcon size={16} className="run-icon error" />;
}

function RunHeader({ run, awaitingInput, paused, inspectable }: { run: Run; awaitingInput: boolean; paused: boolean; inspectable: boolean }) {
  const time = new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={`run-header ${run.status}`}>
      <RunIcon run={run} paused={paused} />
      <span className="run-name">{run.file ? basename(run.file) : "Console"}</span>
      <span className="run-meta">
        {runSummary(run, awaitingInput, paused)} · {time}
      </span>
      {inspectable && (
        <button className="inspect-button" onClick={() => void session.inspectError()} title="Look at the variables where the error happened">
          <Inspect size={14} /> Inspect
        </button>
      )}
    </div>
  );
}

// -- inline input -------------------------------------------------------------------------

function InlineInput() {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <input
      ref={ref}
      className="inline-input"
      value={value}
      size={Math.max(1, value.length + 1)}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          session.submitInput(value);
          setValue("");
        }
      }}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="send"
      aria-label="Input for the program"
    />
  );
}

// -- console -----------------------------------------------------------------------------

function renderLine(line: Line, dir: string) {
  return (
    <Fragment key={line.id}>
      {line.kind === "run" ? null : line.kind === "image" ? (
        <img className="console-image" src={`data:image/png;base64,${line.text}`} alt="Figure" />
      ) : line.kind === "prompt" ? (
        <span className="console-prompt-line">{line.text}{"\n"}</span>
      ) : (
        <span className={`out ${line.kind}`}>{line.kind === "stderr" ? renderTraceback(line.text, dir) : renderAnsi(line.text)}</span>
      )}
    </Fragment>
  );
}

function groupByRun(lines: Line[]) {
  const groups: { runId: number; lines: Line[] }[] = [];
  for (const line of lines) {
    const g = groups.at(-1);
    if (g && g.runId === line.runId) g.lines.push(line);
    else groups.push({ runId: line.runId, lines: [line] });
  }
  return groups;
}

export function Console({ state, header }: { state: SessionState; header?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const autoTop = useRef(-1); // where we last scrolled to ourselves
  const lastStop = useRef<number | null>(null);
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Follow output while the user is at the bottom; leave them alone when they
  // scrolled up. A new stop in the debugger always comes into view.
  useLayoutEffect(() => {
    const el = scroller.current;
    const stopId = state.debug?.stopId ?? null;
    if (stopId !== null && stopId !== lastStop.current) stick.current = true;
    lastStop.current = stopId;
    if (el && stick.current) {
      el.scrollTop = el.scrollHeight;
      autoTop.current = el.scrollTop;
    }
  }, [state.lines, state.awaitingInput, state.debug]);

  const paused = state.debug;
  const submit = () => {
    if (!value.trim()) return;
    setHistory((h) => [...h.filter((x) => x !== value), value]);
    if (paused) void session.debugConsole(value);
    else void session.runConsole(value);
    setValue("");
    setHistoryIndex(-1);
    stick.current = true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && history.length) {
      e.preventDefault();
      const next = e.key === "ArrowUp" ? (historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)) : historyIndex + 1;
      if (next >= history.length || next < 0) {
        setHistoryIndex(-1);
        setValue("");
      } else {
        setHistoryIndex(next);
        setValue(history[next]);
      }
    }
  };

  const busy = state.status !== "idle" && !paused;
  const groups = groupByRun(state.lines);
  const lastRunId = groups.at(-1)?.runId;
  const pausedFrame = paused?.frames[paused.selected];

  return (
    <div className="console">
      {header}
      <div
        className="console-output"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          // Scroll events from our own scrolling arrive late, possibly after
          // more output was added; they must not count as "scrolled up".
          if (Math.abs(el.scrollTop - autoTop.current) < 2) return;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {state.lines.length === 0 && (
          <div className="console-empty">
            <Terminal size={34} />
            <p>Output from your programs appears here.</p>
            <p className="hint">Type Python below to try something out.</p>
          </div>
        )}
        {groups.map((g) => {
          const run = state.runs[g.runId];
          // While paused, the paused block sits where the program stopped and
          // >>> evaluations follow it, next to the prompt you type in.
          const split = paused && g.runId === lastRunId ? paused.firstLineId : Infinity;
          const before = g.lines.filter((l) => l.id < split);
          const after = g.lines.filter((l) => l.id >= split);
          return (
            <section className="run" key={g.runId}>
              {run && (
                <RunHeader
                  run={run}
                  awaitingInput={state.awaitingInput && g.runId === lastRunId}
                  paused={!!paused && g.runId === lastRunId}
                  inspectable={run.status === "error" && run.file !== null && g.runId === lastRunId && session.canInspect}
                />
              )}
              <div className="run-body">
                {before.map((l) => renderLine(l, run?.dir ?? ""))}
                {state.awaitingInput && g.runId === lastRunId && <InlineInput key={state.lines.length} />}
              </div>
              {split !== Infinity && <PausedBlock debug={paused!} />}
              {after.length > 0 && <div className="run-body paused-output">{after.map((l) => renderLine(l, run?.dir ?? ""))}</div>}
            </section>
          );
        })}
        {paused && !groups.some((g) => g.runId === lastRunId) && <PausedBlock debug={paused} />}
      </div>
      <div className={`repl ${busy ? "busy" : ""}`}>
        <span className="repl-prompt">&gt;&gt;&gt;</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            pausedFrame ? `Python in ${pausedFrame.name === "<module>" ? basename(pausedFrame.file) : pausedFrame.name + "()"}`
            : busy ? (state.awaitingInput ? "Answer the program above" : "Running…") : "Python"
          }
          disabled={busy}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-label="Python console"
        />
        {state.lines.length > 0 && !busy && !paused && (
          <button className="icon-button small" onClick={() => session.clear()} aria-label="Clear console">
            <Trash size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
