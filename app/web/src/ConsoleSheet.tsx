// iPhone console: a bottom sheet with three detents (peek bar, half, full)
// that can be dragged or tapped. Opens itself when a run starts or asks for input.
import { useEffect, useRef, useState } from "react";
import { Console, runSummary } from "./Console";
import { ChevronDown, ChevronUp } from "./Icons";
import type { SessionState } from "./session";

export type Detent = "peek" | "half" | "full";

const PEEK = 58;

function lastOutputLine(state: SessionState): string {
  for (let i = state.lines.length - 1; i >= 0; i--) {
    const l = state.lines[i];
    if (l.kind === "stdout" || l.kind === "stderr" || l.kind === "input") {
      const text = l.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd().split("\n").at(-1)?.trim();
      if (text) return text;
    }
    if (l.kind === "image") return "Figure";
  }
  return "";
}

export function ConsoleSheet({ state, hidden, detent, onDetent }: { state: SessionState; hidden: boolean; detent: Detent; onDetent: (d: Detent) => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ startY: number; startH: number; h: number; t: number; lastY: number; v: number } | null>(null);
  const lastRunCounter = useRef(state.runCounter);

  // A new run or a pending input() brings the console up.
  useEffect(() => {
    if (state.runCounter !== lastRunCounter.current) {
      lastRunCounter.current = state.runCounter;
      if (detent === "peek") onDetent("half");
    }
  }, [state.runCounter, detent, onDetent]);
  useEffect(() => {
    if (state.awaitingInput && detent === "peek") onDetent("half");
  }, [state.awaitingInput, detent, onDetent]);

  const parentHeight = () => sheet.current?.parentElement?.clientHeight ?? window.innerHeight;
  const heightFor = (d: Detent) => {
    const H = parentHeight();
    return d === "peek" ? PEEK : d === "half" ? Math.round(H * 0.5) : H - 8;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const h = heightFor(detent);
    setDrag({ startY: e.clientY, startH: h, h, t: performance.now(), lastY: e.clientY, v: 0 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const now = performance.now();
    const v = (e.clientY - drag.lastY) / Math.max(1, now - drag.t);
    const h = Math.max(PEEK, Math.min(heightFor("full"), drag.startH - (e.clientY - drag.startY)));
    setDrag({ ...drag, h, t: now, lastY: e.clientY, v });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const moved = Math.abs(e.clientY - drag.startY);
    setDrag(null);
    if (moved < 6) {
      // A tap toggles between collapsed and open.
      onDetent(detent === "peek" ? "half" : "peek");
      return;
    }
    // Project the release a little along the velocity, then snap.
    const projected = drag.h - drag.v * 180;
    const options: Detent[] = ["peek", "half", "full"];
    const best = options.reduce((a, b) => (Math.abs(heightFor(a) - projected) <= Math.abs(heightFor(b) - projected) ? a : b));
    onDetent(best);
  };

  const height = drag ? drag.h : heightFor(detent);
  const run = state.runs[state.lines.at(-1)?.runId ?? -1];
  const collapsed = !drag && detent === "peek";

  return (
    <div
      ref={sheet}
      className={`console-sheet ${collapsed ? "collapsed" : ""} ${drag ? "dragging" : ""} ${hidden ? "hidden" : ""}`}
      style={{ height }}
    >
      <div className="sheet-handle" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div className="grabber" />
        <div className="sheet-header">
          <span className={`status-dot ${run?.status ?? "none"} ${state.awaitingInput ? "input" : ""}`} />
          <div className="sheet-title">
            <span className="sheet-title-main">{collapsed && run ? runSummary(run, state.awaitingInput) : "Console"}</span>
            {collapsed && <span className="sheet-preview">{lastOutputLine(state) || (run ? (run.file ?? "Console") : "Output and >>> prompt")}</span>}
          </div>
          {collapsed ? <ChevronUp size={18} className="sheet-chevron" /> : <ChevronDown size={18} className="sheet-chevron" />}
        </div>
      </div>
      {!collapsed && <Console state={state} />}
    </div>
  );
}
