// Debugger integration for CodeMirror (D23):
// - breakpoints are gutter line classes that follow edits
// - long-pressing a line number reports the line (App adds or edits it)
// - the paused line gets a band, the editor turns read-only, and tapping a
//   name reports an expression to inspect
import { syntaxTree } from "@codemirror/language";
import { Compartment, EditorState, type Extension, RangeSet, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutterLineClass, ViewPlugin } from "@codemirror/view";
import type { Breakpoint } from "./breakpoints";

class BreakpointMarker extends GutterMarker {
  constructor(readonly enabled: boolean) {
    super();
    this.elementClass = enabled ? "cm-bp" : "cm-bp cm-bp-off";
  }
  eq(other: BreakpointMarker) {
    return other.enabled === this.enabled;
  }
}

const ON = new BreakpointMarker(true);
const OFF = new BreakpointMarker(false);

export const setBreakpointsEffect = StateEffect.define<Breakpoint[]>();

function buildBreakpoints(state: EditorState, list: Breakpoint[]): RangeSet<BreakpointMarker> {
  const builder = new RangeSetBuilder<BreakpointMarker>();
  for (const bp of [...list].sort((a, b) => a.line - b.line)) {
    if (bp.line < 1 || bp.line > state.doc.lines) continue;
    const from = state.doc.line(bp.line).from;
    builder.add(from, from, bp.enabled ? ON : OFF);
  }
  return builder.finish();
}

export const breakpointField = StateField.define<RangeSet<BreakpointMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) if (e.is(setBreakpointsEffect)) set = buildBreakpoints(tr.state, e.value);
    return set;
  },
  provide: (f) => gutterLineClass.from(f),
});

/** Breakpoints as lines, deduplicated (after edits two can land on one line). */
export function breakpointLines(state: EditorState): Breakpoint[] {
  const out: Breakpoint[] = [];
  const seen = new Set<number>();
  const set = state.field(breakpointField, false);
  if (!set) return out;
  for (let it = set.iter(); it.value; it.next()) {
    const line = state.doc.lineAt(it.from).number;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({ line, enabled: it.value.enabled });
  }
  return out;
}

// -- the paused line --------------------------------------------------------------------

export const setDebugLineEffect = StateEffect.define<number | null>();

class DebugGutterMarker extends GutterMarker {
  elementClass = "cm-debug-gutter";
}
const debugGutter = new DebugGutterMarker();
const debugLineDeco = Decoration.line({ class: "cm-debug-line" });

const debugLineField = StateField.define<{ deco: DecorationSet; gutter: RangeSet<GutterMarker> }>({
  create: () => ({ deco: Decoration.none, gutter: RangeSet.empty }),
  update(value, tr) {
    let next = { deco: value.deco.map(tr.changes), gutter: value.gutter.map(tr.changes) };
    for (const e of tr.effects) {
      if (!e.is(setDebugLineEffect)) continue;
      if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) {
        next = { deco: Decoration.none, gutter: RangeSet.empty };
      } else {
        const from = tr.state.doc.line(e.value).from;
        next = { deco: Decoration.set([debugLineDeco.range(from)]), gutter: RangeSet.of([debugGutter.range(from)]) };
      }
    }
    return next;
  },
  provide: (f) => [EditorView.decorations.from(f, (v) => v.deco), gutterLineClass.from(f, (v) => v.gutter)],
});

// -- long press on line numbers ---------------------------------------------------------

const LONG_PRESS_MS = 450;

function gutterLongPress(onLongPress: (line: number, rect: DOMRect) => void) {
  return ViewPlugin.fromClass(
    class {
      timer = 0;
      start: { x: number; y: number } | null = null;
      constructor(readonly view: EditorView) {
        view.dom.addEventListener("pointerdown", this.down);
        view.dom.addEventListener("pointermove", this.move);
        view.dom.addEventListener("pointerup", this.cancel);
        view.dom.addEventListener("pointercancel", this.cancel);
        view.scrollDOM.addEventListener("scroll", this.cancel, { passive: true });
        view.dom.addEventListener("contextmenu", this.contextMenu);
      }
      lineAt(e: MouseEvent) {
        const el = (e.target as Element | null)?.closest?.(".cm-lineNumbers .cm-gutterElement");
        if (!el) return null;
        const block = this.view.lineBlockAtHeight(e.clientY - this.view.documentTop);
        return { line: this.view.state.doc.lineAt(block.from).number, rect: el.getBoundingClientRect() };
      }
      down = (e: PointerEvent) => {
        const hit = this.lineAt(e);
        if (!hit || e.button > 0) return;
        this.start = { x: e.clientX, y: e.clientY };
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          this.start = null;
          onLongPress(hit.line, hit.rect);
        }, LONG_PRESS_MS);
      };
      move = (e: PointerEvent) => {
        if (this.start && Math.hypot(e.clientX - this.start.x, e.clientY - this.start.y) > 8) this.cancel();
      };
      cancel = () => {
        this.start = null;
        clearTimeout(this.timer);
      };
      // Right click (mouse, trackpad) does the same.
      contextMenu = (e: MouseEvent) => {
        const hit = this.lineAt(e);
        if (!hit) return;
        e.preventDefault();
        this.cancel();
        onLongPress(hit.line, hit.rect);
      };
      destroy() {
        this.cancel();
        this.view.dom.removeEventListener("pointerdown", this.down);
        this.view.dom.removeEventListener("pointermove", this.move);
        this.view.dom.removeEventListener("pointerup", this.cancel);
        this.view.dom.removeEventListener("pointercancel", this.cancel);
        this.view.scrollDOM.removeEventListener("scroll", this.cancel);
        this.view.dom.removeEventListener("contextmenu", this.contextMenu);
      }
    },
  );
}

// -- paused: read-only, tap a name to inspect it ----------------------------------------

/** The expression to inspect at pos: a name or a dotted attribute chain (`self.items`). */
export function inspectableAt(state: EditorState, pos: number): { expr: string; from: number; to: number } | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    const node = tree.resolveInner(pos, side);
    if (node.name === "VariableName" || node.name === "self") {
      return { expr: state.sliceDoc(node.from, node.to), from: node.from, to: node.to };
    }
    if (node.name === "PropertyName" && node.parent?.name === "MemberExpression") {
      const expr = state.sliceDoc(node.parent.from, node.to).replace(/\s+/g, "");
      // Only plain names and attributes: evaluating must not call anything.
      if (/^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)+$/.test(expr)) return { expr, from: node.parent.from, to: node.to };
    }
  }
  return null;
}

export const pausedCompartment = new Compartment();

export function pausedExtension(onInspect: (expr: string, rect: DOMRect) => void): Extension {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.domEventHandlers({
      click(e, view) {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        const hit = inspectableAt(view.state, pos);
        if (!hit) return false;
        const a = view.coordsAtPos(hit.from);
        const b = view.coordsAtPos(hit.to, -1);
        if (!a || !b) return false;
        onInspect(hit.expr, new DOMRect(a.left, a.top, Math.max(1, b.right - a.left), a.bottom - a.top));
        return true;
      },
    }),
    EditorView.contentAttributes.of({ class: "cm-paused" }),
  ];
}

export function debugExtensions(onLongPress: (line: number, rect: DOMRect) => void): Extension {
  return [breakpointField, debugLineField, gutterLongPress(onLongPress), pausedCompartment.of([])];
}
