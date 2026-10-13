// Debugger UI (D23): the step bar, the paused block in the console (stack and
// variables), and the popover for a name tapped in the editor.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { basename, haptic } from "../host";
import { ChevronRight, Continue, Pause, StepInto, StepOut, StepOver, Stop } from "../Icons";
import { type DebugFrame, type DebugState, type DebugVariable, session } from "../session";

export function frameLabel(frame: DebugFrame) {
  return frame.name === "<module>" ? basename(frame.file) : `${frame.name}()`;
}

export function pausedSummary(debug: DebugState) {
  const frame = debug.frames[0];
  if (debug.postMortem) return `Error in ${frameLabel(frame)}`;
  return `Paused · line ${frame.line}`;
}

// -- step bar -----------------------------------------------------------------------------

export function DebugBar({ debug, compact, inline }: { debug: DebugState; compact?: boolean; inline?: boolean }) {
  const act = (fn: () => void) => () => {
    haptic();
    fn();
  };
  if (debug.postMortem) {
    // Inspecting an error has nothing to step through: just a way out.
    return (
      <button className={`done-pill ${compact ? "compact" : ""}`} onClick={act(() => session.resume("continue"))}>
        Done
      </button>
    );
  }
  return (
    <div className={`debug-bar ${compact ? "compact" : ""} ${inline ? "inline" : ""}`} role="toolbar" aria-label="Debugger">
      <button onClick={act(() => session.resume("next"))} aria-label="Step over" title="Step Over">
        <StepOver size={22} />
      </button>
      <button onClick={act(() => session.resume("stepIn"))} aria-label="Step into" title="Step Into">
        <StepInto size={22} />
      </button>
      <button onClick={act(() => session.resume("stepOut"))} aria-label="Step out" title="Step Out">
        <StepOut size={22} />
      </button>
      <span className="debug-bar-sep" />
      <button className="debug-stop" onClick={act(() => session.stop())} aria-label="Stop" title="Stop">
        <Stop size={18} />
      </button>
    </div>
  );
}

export function ContinueButton() {
  return (
    <button className="run-button continue" onClick={() => { haptic(); session.resume("continue"); }} aria-label="Continue">
      <Continue size={20} />
    </button>
  );
}

export function PauseButton({ disabled }: { disabled?: boolean }) {
  return (
    <button
      className="icon-button small pause-button"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        haptic();
        session.pause();
      }}
      disabled={disabled}
      aria-label="Pause"
      title="Pause"
    >
      <Pause size={16} />
    </button>
  );
}

// -- variables ------------------------------------------------------------------------------

function VariableRow({ variable, depth }: { variable: DebugVariable; depth: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DebugVariable[] | null>(null);
  const expandable = variable.ref > 0;
  const toggle = async () => {
    if (!expandable) return;
    if (!open && !children) setChildren(await session.debugVariables(variable.ref));
    setOpen((o) => !o);
  };
  return (
    <>
      <button className={`var-row ${expandable ? "expandable" : ""}`} style={{ paddingLeft: 4 + depth * 16 }} onClick={() => void toggle()} disabled={!expandable}>
        <ChevronRight size={11} className={`var-chevron ${open ? "open" : ""} ${expandable ? "" : "invisible"}`} />
        <span className="var-name">{variable.name}</span>
        <span className="var-value">{variable.value}</span>
        <span className="var-type">{variable.type}</span>
      </button>
      {open && children?.map((child, i) => <VariableRow key={i} variable={child} depth={depth + 1} />)}
      {open && children?.length === 0 && <div className="var-empty" style={{ paddingLeft: 24 + depth * 16 }}>empty</div>}
    </>
  );
}

export function VariableList({ variables, depth = 0 }: { variables: DebugVariable[]; depth?: number }) {
  return (
    <div className="var-list">
      {variables.map((v, i) => <VariableRow key={`${i}:${v.name}`} variable={v} depth={depth} />)}
    </div>
  );
}

/** Shown at the end of the console while the program is paused. */
export function PausedBlock({ debug }: { debug: DebugState }) {
  const frame = debug.frames[debug.selected];
  const reason = debug.postMortem
    ? "Inspecting the error"
    : debug.reason === "breakpoint" ? "Breakpoint" : debug.reason === "pause" ? "Paused" : debug.reason === "breakpoint()" ? "breakpoint()" : "Step";
  return (
    <section className="paused-block" key={debug.stopId}>
      <div className="paused-head">
        <span className={`paused-badge ${debug.postMortem ? "error" : ""}`}>{reason}</span>
        <span className="paused-where">
          {frameLabel(frame)} · line {frame.line}
        </span>
      </div>
      {debug.exception && <div className="paused-exception">{debug.exception}</div>}
      {debug.frames.length > 1 && (
        <div className="paused-stack" role="tablist" aria-label="Call stack">
          {debug.frames.map((f, i) => (
            <button key={i} role="tab" aria-selected={i === debug.selected} className={`stack-chip ${i === debug.selected ? "selected" : ""}`} onClick={() => void session.selectFrame(i)}>
              {frameLabel(f)}
              <span className="stack-line">:{f.line}</span>
            </button>
          ))}
        </div>
      )}
      {debug.scopes.map((scope) => (
        <div className="paused-scope" key={`${debug.stopId}-${debug.selected}-${scope.name}`}>
          {debug.scopes.length > 1 && <div className="paused-scope-title">{scope.name}</div>}
          {scope.variables.length ? <VariableList variables={scope.variables} /> : <div className="var-empty">No variables</div>}
        </div>
      ))}
      <div className="paused-hint">{debug.postMortem ? "Tap a name in the editor to see its value." : "Tap a name in the editor to see its value. >>> runs here."}</div>
    </section>
  );
}

// -- value popover ----------------------------------------------------------------------------

export function ValuePopover({ expr, anchor, onClose }: { expr: string; anchor: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ value?: DebugVariable; error?: string } | null>(null);
  const [children, setChildren] = useState<DebugVariable[] | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    setResult(null);
    setChildren(null);
    void session.debugEvaluate(expr).then(async (r) => {
      if (!live) return;
      setResult(r);
      if (r.value?.ref) {
        const kids = await session.debugVariables(r.value.ref);
        if (live) setChildren(kids);
      }
    });
    return () => {
      live = false;
    };
  }, [expr]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = document.documentElement.clientHeight;
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, vw - width - 8));
    const below = anchor.bottom + 8;
    const above = below + height > vh - 8 && anchor.top - height - 8 > 8;
    setPos({ left, top: above ? anchor.top - height - 8 : below, above });
  }, [anchor, result, children]);

  return createPortal(
    <div className="menu-scrim" onPointerDown={onClose}>
      <div
        ref={ref}
        className={`value-popover ${pos ? "open" : ""}`}
        style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Value of ${expr}`}
      >
        <div className="value-head">
          <span className="value-expr">{expr}</span>
          {result?.value && <span className="var-type">{result.value.type}</span>}
        </div>
        {!result ? (
          <div className="value-loading"><span className="spinner" /></div>
        ) : result.error ? (
          <div className="value-error">{result.error}</div>
        ) : (
          <>
            <div className="value-repr">{result.value!.value}</div>
            {children && children.length > 0 && (
              <div className="value-children">
                <VariableList variables={children} />
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
