// One editor pane (D31): CodeMirror 6 in its own web view, driven by the
// native host. One view, one cached EditorState per file (undo history and
// selection survive switching files). The host calls window.__editor; the
// page reports back with editorEvent().
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, redo, toggleComment, undo } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, ensureSyntaxTree, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic, forEachDiagnostic, forceLinting } from "@codemirror/lint";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Annotation, ChangeSet, Compartment, EditorState, type Extension, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  Decoration, type DecorationSet, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, ViewPlugin, type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { analysisCompletions, analysisLinter, formatDocument } from "../analysis/codemirror";
import type { Breakpoint } from "../debug/breakpoints";
import {
  breakpointLines, debugExtensions, pausedCompartment, pausedExtension, setBreakpointsEffect, setDebugLineEffect,
} from "../debug/codemirror";
import { call } from "../host";
import { settings } from "../settings";

export type EditorCommand = "undo" | "redo" | "indent" | "dedent" | "comment" | "left" | "right" | "up" | "down" | "search";

export const editorEvent = (type: string, value: Record<string, unknown> = {}) => call("editor.event", { type, ...value }).catch(() => {});

const rectOf = (r: DOMRect) => ({ x: r.left, y: r.top, width: r.width, height: r.height });

const wrapCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const wrapping = (on: boolean) => (on ? [EditorView.lineWrapping, hangingIndent] : []);
const readOnlyExt = (on: boolean) => (on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []);

/** Marks transactions that mirror another pane's edits (not saved or re-sent). */
const remote = Annotation.define<boolean>();

// A short highlight on a line we jumped to.
const flashEffect = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashEffect)) continue;
      deco = e.value === null ? Decoration.none : Decoration.set([Decoration.line({ class: "cm-flash-line" }).range(e.value)]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.operatorKeyword, t.moduleKeyword], color: "var(--syn-keyword)", fontWeight: "var(--syn-keyword-weight)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment], color: "var(--syn-comment)", fontStyle: "var(--syn-comment-style)" },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.className)], color: "var(--syn-def)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-call)" },
  { tag: [t.self, t.special(t.variableName)], color: "var(--syn-self)" },
  { tag: t.className, color: "var(--syn-class)" },
  { tag: t.meta, color: "var(--syn-meta)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size)", background: "var(--editor-bg)", color: "var(--editor-fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.5", overscrollBehavior: "contain" },
  ".cm-content": { caretColor: "var(--caret)", paddingBottom: "40vh" },
  ".cm-gutters": { background: "var(--editor-bg)", color: "var(--gutter)", border: "none" },
  ".cm-activeLine": { background: "var(--active-line)" },
  ".cm-activeLineGutter": { background: "transparent", color: "var(--gutter-active)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--caret)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { background: "var(--selection) !important" },
  ".cm-matchingBracket": { background: "var(--bracket-match)", outline: "none" },
  ".cm-tooltip": { border: "none", borderRadius: "10px", overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,.2)", background: "var(--cell-bg)" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "6px 10px !important", fontFamily: "var(--mono)" },
  ".cm-panels": { background: "var(--grouped-bg)", color: "var(--label)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--red)", textDecorationSkipInk: "none", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy #ff9500", textDecorationSkipInk: "none", textUnderlineOffset: "3px" },
  ".cm-lintRange-info": { backgroundImage: "none", textDecoration: "underline dotted var(--secondary)", textUnderlineOffset: "3px" },
});

// Wrapped lines continue under the line's own indentation (+ 4 columns),
// which keeps wrapped Python readable on a phone.
const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          const indent = /^[ \t]*/.exec(line.text)![0].replace(/\t/g, "    ").length + 4;
          builder.add(line.from, line.from, Decoration.line({ attributes: { style: `padding-left:calc(${indent}ch + 6px);text-indent:-${indent}ch` } }));
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

const cursorMove = (view: EditorView, dir: "left" | "right" | "up" | "down") => {
  const sel = view.state.selection.main;
  let pos: number;
  if (dir === "left") pos = Math.max(0, sel.head - 1);
  else if (dir === "right") pos = Math.min(view.state.doc.length, sel.head + 1);
  else pos = view.moveVertically(sel, dir === "down").head;
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
};

const sameBreakpoints = (a: Breakpoint[], b: Breakpoint[]) =>
  a.length === b.length && a.every((bp, i) => bp.line === b[i].line && bp.enabled === b[i].enabled);

export interface Symbol {
  name: string;
  kind: "class" | "function" | "method";
  line: number;
  depth: number;
}

/** Classes and functions from the Python syntax tree, in document order. */
export function outline(state: EditorState): Symbol[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 300);
  if (!tree) return [];
  const out: Symbol[] = [];
  const stack: { to: number; kind: "class" | "function" }[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "ClassDefinition" && node.name !== "FunctionDefinition") return;
      while (stack.length && stack[stack.length - 1].to <= node.from) stack.pop();
      const nameNode = node.node.getChild("VariableName");
      if (!nameNode) return;
      const parent = stack[stack.length - 1];
      const kind = node.name === "ClassDefinition" ? "class" : parent?.kind === "class" ? "method" : "function";
      out.push({ name: state.sliceDoc(nameNode.from, nameNode.to), kind, line: state.doc.lineAt(node.from).number, depth: stack.length });
      stack.push({ to: node.to, kind: node.name === "ClassDefinition" ? "class" : "function" });
    },
  });
  return out;
}

interface Problem {
  d: Diagnostic;
  from: number;
  to: number;
}

export class PaneEditor {
  readonly view: EditorView;
  private states = new Map<string, EditorState>();
  private readOnly = new Map<string, boolean>();
  path: string | null = null;
  private breakpoints: Breakpoint[] = [];
  private paused = false;
  private pendingText: string | null = null;
  private saveTimer = 0;
  private updateFrame = 0;
  private problemBar: HTMLElement;
  private lastSummary = "";

  constructor(parent: HTMLElement, problemBar: HTMLElement) {
    this.problemBar = problemBar;
    this.view = new EditorView({ parent, state: this.makeState("", false) });
    new ResizeObserver(() => this.view.requestMeasure()).observe(parent);
    settings.subscribe(() => {
      this.view.dispatch({ effects: wrapCompartment.reconfigure(wrapping(settings.getSnapshot().wrap)) });
      this.view.requestMeasure();
    });
  }

  private makeState(doc: string, readOnly: boolean) {
    return EditorState.create({ doc, extensions: this.extensions(readOnly) });
  }

  private extensions(readOnly: boolean): Extension[] {
    const definition = () => void editorEvent("definition");
    const info = () => void editorEvent("info");
    return [
      readOnlyCompartment.of(readOnlyExt(readOnly)),
      flashField,
      keymap.of([{ key: "F12", run: () => (definition(), true) }]),
      EditorView.domEventHandlers({
        mousedown(e, view) {
          // ⌘-click: jump to the definition; ⌥-click: show info (as in Xcode).
          const action = e.metaKey || e.ctrlKey ? definition : e.altKey ? info : null;
          if (!action || e.button !== 0) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos === null) return false;
          view.dispatch({ selection: { anchor: pos } });
          action();
          return true;
        },
      }),
      debugExtensions((line, rect) => {
        if (this.path) void editorEvent("longPress", { path: this.path, line, rect: rectOf(rect) });
      }),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true, icons: false, override: [analysisCompletions(() => this.path)] }),
      analysisLinter(() => this.path),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      python(),
      wrapCompartment.of(wrapping(settings.getSnapshot().wrap)),
      indentUnit.of("    "),
      EditorState.tabSize.of(4),
      syntaxHighlighting(highlight),
      theme,
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "Code editor" }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !u.transactions.some((tr) => tr.annotation(remote))) this.localChange(u);
        if (u.focusChanged) {
          if (!u.view.hasFocus) this.flush();
          void call("keyboard.mode", { mode: u.view.hasFocus ? "code" : "plain" }).catch(() => {});
          void editorEvent("focus", { focused: u.view.hasFocus });
        }
        cancelAnimationFrame(this.updateFrame);
        this.updateFrame = requestAnimationFrame(() => this.updated());
      }),
    ];
  }

  /** A local edit: mirrored into the other pane right away, saved a little later. */
  private localChange(u: ViewUpdate) {
    const path = this.path;
    if (!path) return;
    void editorEvent("changes", { path, changes: JSON.stringify(u.changes.toJSON()) });
    this.pendingText = u.state.doc.toString();
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 300);
    const lines = breakpointLines(u.state);
    if (!sameBreakpoints(lines, this.breakpoints)) {
      this.breakpoints = lines;
      void editorEvent("breakpoints", { path, breakpoints: lines });
    }
  }

  /** Report unsaved text now; returns it (or null if there is none). */
  flush(): string | null {
    clearTimeout(this.saveTimer);
    const text = this.pendingText;
    this.pendingText = null;
    if (text !== null && this.path) void editorEvent("text", { path: this.path, text });
    return text;
  }

  // -- after updates: problems --------------------------------------------------------

  private problemList(): Problem[] {
    const out: Problem[] = [];
    forEachDiagnostic(this.view.state, (d, from, to) => out.push({ d, from, to }));
    return out;
  }

  private updated() {
    const state = this.view.state;
    let errors = 0;
    let warnings = 0;
    let current: Problem | null = null;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    for (const p of this.problemList()) {
      if (p.d.severity === "error") errors++;
      else if (p.d.severity === "warning") warnings++;
      const here = p.from <= head && head <= p.to;
      const sameLine = p.from <= line.to && p.to >= line.from;
      if (here || (!current && sameLine)) current = p;
    }
    const summary = JSON.stringify({ errors, warnings });
    if (summary !== this.lastSummary) {
      this.lastSummary = summary;
      void editorEvent("problems", { errors, warnings });
    }
    this.renderProblemBar(current, errors + warnings);
  }

  /** The diagnostic under the cursor with its quick fixes (touch has no hover). */
  private renderProblemBar(p: Problem | null, total: number) {
    const bar = this.problemBar;
    if (!p || this.paused || this.path?.startsWith("ext:")) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.className = `problem-bar ${p.d.severity}`;
    bar.replaceChildren();
    const text = document.createElement("div");
    text.className = "problem-text";
    const icon = document.createElement("span");
    icon.className = "problem-icon";
    icon.textContent = p.d.severity === "error" ? "⛔" : "⚠️";
    const message = document.createElement("span");
    message.className = "problem-message";
    message.textContent = `${p.d.message} `;
    const source = document.createElement("span");
    source.className = "problem-source";
    source.textContent = p.d.source ?? "";
    message.append(source);
    text.append(icon, message);
    const actions = document.createElement("div");
    actions.className = "problem-actions";
    for (const a of p.d.actions ?? []) {
      const b = document.createElement("button");
      b.textContent = a.name;
      b.onpointerdown = (e) => {
        e.preventDefault();
        a.apply(this.view, p.from, p.to);
      };
      actions.append(b);
    }
    if (total > 1) {
      const all = document.createElement("button");
      all.className = "secondary";
      all.textContent = `All ${total}`;
      all.onpointerdown = (e) => {
        e.preventDefault();
        void editorEvent("showProblems");
      };
      actions.append(all);
    }
    bar.append(text);
    if (actions.childElementCount) bar.append(actions);
  }

  // -- the host's API ---------------------------------------------------------------------

  /** Show a file; `text` is used when there is no state for it yet. */
  open(path: string | null, text: string, readOnly: boolean) {
    const view = this.view;
    if (this.path === path) return;
    this.flush();
    if (this.path) this.states.set(this.path, view.state);
    this.path = path;
    if (path === null) {
      view.setState(this.makeState("", false));
      this.updated();
      return;
    }
    this.readOnly.set(path, readOnly);
    view.setState(this.states.get(path) ?? this.makeState(text, readOnly));
    view.dispatch({ effects: [setBreakpointsEffect.of(this.breakpoints), pausedCompartment.reconfigure(this.pausedExt())] });
    requestAnimationFrame(() => view.requestMeasure());
    setTimeout(() => view.requestMeasure(), 450);
  }

  /** Whether a state for the file is cached (the host then needs no text). */
  has(path: string) {
    return this.path === path || this.states.has(path);
  }

  text(path?: string) {
    if (!path || path === this.path) return this.view.state.doc.toString();
    return this.states.get(path)?.doc.toString() ?? null;
  }

  setBreakpoints(list: Breakpoint[]) {
    this.breakpoints = list;
    if (!sameBreakpoints(breakpointLines(this.view.state), list)) this.view.dispatch({ effects: setBreakpointsEffect.of(list) });
  }

  private pausedExt() {
    return this.paused
      ? pausedExtension((expr, rect) => void editorEvent("inspect", { expr, rect: rectOf(rect) }))
      : [];
  }

  setPaused(paused: boolean, errorStyle: boolean) {
    document.documentElement.classList.toggle("inspecting-error", errorStyle);
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.view.contentDOM.blur();
    this.view.dispatch({ effects: pausedCompartment.reconfigure(this.pausedExt()) });
    this.updated();
  }

  setDebugLine(line: number | null, visibleFraction: number) {
    const view = this.view;
    view.dispatch({ effects: setDebugLineEffect.of(line) });
    if (line === null || line > view.state.doc.lines) return;
    requestAnimationFrame(() => this.revealPos(view.state.doc.line(line).from, false, visibleFraction));
  }

  /** Bring a position into the part of the editor the console does not cover. */
  private revealPos(pos: number, always: boolean, visibleFraction = 0.85) {
    const view = this.view;
    const block = view.lineBlockAt(pos);
    const scroller = view.scrollDOM;
    const top = scroller.scrollTop;
    const visible = scroller.clientHeight * visibleFraction;
    if (always || block.top < top + 8 || block.bottom > top + visible - 8) {
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: Math.round(visible * 0.3) }) });
    }
  }

  /** Jump to a line (traceback, definition, outline): select it, scroll, flash. */
  reveal(line: number, column = 1, visibleFraction = 0.85) {
    const view = this.view;
    const doc = view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const pos = Math.min(l.to, l.from + Math.max(0, column - 1));
    view.dispatch({ selection: { anchor: pos }, effects: flashEffect.of(l.from) });
    requestAnimationFrame(() => this.revealPos(pos, false, visibleFraction));
    setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1400);
  }

  /** Show a range of lines (the agent's ide_open): selected, scrolled to, the first one flashed. */
  revealRange(fromLine: number, toLine: number, visibleFraction = 0.85) {
    const view = this.view;
    const doc = view.state.doc;
    const from = doc.line(Math.max(1, Math.min(fromLine, doc.lines)));
    const to = doc.line(Math.max(from.number, Math.min(toLine, doc.lines)));
    view.dispatch({ selection: { anchor: from.from, head: to.to }, effects: flashEffect.of(from.from) });
    requestAnimationFrame(() => this.revealPos(from.from, false, visibleFraction));
    setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1400);
  }

  insert(text: string, cursorOffset = text.length) {
    const view = this.view;
    if (view.state.readOnly) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + cursorOffset },
      scrollIntoView: true,
      userEvent: "input.type",
    });
  }

  command(name: EditorCommand) {
    const view = this.view;
    const commands = { undo, redo, indent: indentMore, dedent: indentLess, comment: toggleComment, search: openSearchPanel };
    if (name in commands) commands[name as keyof typeof commands](view);
    else cursorMove(view, name as "left" | "right" | "up" | "down");
  }

  /** Keys from the native keyboard accessory. */
  key(action: string) {
    if (action === "dismiss") return this.view.contentDOM.blur();
    if (action === "definition") return void editorEvent("definition");
    if (action === "info") return void editorEvent("info");
    if (action.startsWith("insert:")) {
      const body = action.slice("insert:".length);
      const m = /^([\s\S]+):(\d+)$/.exec(body);
      return m ? this.insert(m[1], Number(m[2])) : this.insert(body);
    }
    this.command(action as EditorCommand);
  }

  applyRemote(path: string, changesJSON: string) {
    const changes = ChangeSet.fromJSON(JSON.parse(changesJSON));
    const spec = { changes, annotations: [remote.of(true), Transaction.addToHistory.of(false)] };
    if (path === this.path) this.view.dispatch(spec);
    else {
      const cached = this.states.get(path);
      if (cached) this.states.set(path, cached.update(spec).state);
    }
  }

  /** The file changed on disk (written by a program). */
  replaceText(path: string, text: string) {
    const view = this.view;
    if (path === this.path) {
      if (view.state.doc.toString() !== text) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: remote.of(true) });
      }
    } else {
      this.states.delete(path);
    }
  }

  renamePath(from: string, to: string) {
    const moved = (p: string) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : null);
    for (const [p, st] of [...this.states]) {
      const next = moved(p);
      if (next) {
        this.states.delete(p);
        this.states.set(next, st);
      }
    }
    const current = this.path && moved(this.path);
    if (current) this.path = current;
  }

  forget(path: string) {
    for (const p of [...this.states.keys()]) if (p === path || p.startsWith(path + "/")) this.states.delete(p);
  }

  /** Where the cursor is, for go to definition and show info. */
  cursor() {
    const state = this.view.state;
    const sel = state.selection.main;
    const pos = sel.empty ? sel.head : sel.from;
    const line = state.doc.lineAt(pos);
    const word = state.wordAt(pos);
    const a = this.view.coordsAtPos(word?.from ?? pos);
    const b = this.view.coordsAtPos(word?.to ?? pos, -1);
    const rect = a ? { x: a.left, y: a.top, width: Math.max(1, (b?.right ?? a.right) - a.left), height: a.bottom - a.top } : null;
    // What is selected, for the agent's context (capped: it goes into a prompt).
    const selection = sel.empty
      ? null
      : {
          text: state.sliceDoc(sel.from, Math.min(sel.to, sel.from + 4000)),
          fromLine: line.number,
          toLine: state.doc.lineAt(sel.to).number,
          truncated: sel.to - sel.from > 4000,
        };
    return { path: this.path, text: state.doc.toString(), line: line.number, column: pos - line.from + 1, rect, selection };
  }

  async format(): Promise<boolean> {
    return formatDocument(this.view);
  }

  outline() {
    return { symbols: outline(this.view.state), lines: this.view.state.doc.lines };
  }

  problems() {
    const doc = this.view.state.doc;
    return this.problemList()
      .map((p, index) => ({
        index, message: p.d.message, source: p.d.source ?? "", severity: p.d.severity, line: doc.lineAt(p.from).number,
        actions: (p.d.actions ?? []).map((a) => a.name),
      }));
  }

  applyFix(index: number, action: number) {
    const p = this.problemList()[index];
    p?.d.actions?.[action]?.apply(this.view, p.from, p.to);
  }

  selectProblem(index: number) {
    const p = this.problemList()[index];
    if (!p) return;
    this.view.dispatch({ selection: { anchor: p.from, head: p.to }, effects: EditorView.scrollIntoView(p.from, { y: "center" }) });
    this.view.focus();
  }

  relint() {
    forceLinting(this.view);
  }

  focus() {
    this.view.focus();
  }

  blur() {
    this.view.contentDOM.blur();
  }

  // -- self-test helpers ------------------------------------------------------------------

  setText(text: string) {
    const view = this.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }

  diagnostics() {
    return this.problemList().map((p) => ({ source: p.d.source ?? "", message: p.d.message, actions: (p.d.actions ?? []).map((a) => a.name) }));
  }

  applyFixNamed(name: string) {
    for (const p of this.problemList()) {
      const action = p.d.actions?.find((a) => a.name.includes(name));
      if (action) {
        action.apply(this.view, p.from, p.to);
        return true;
      }
    }
    return false;
  }

  setCursor(line: number, column: number) {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    this.view.dispatch({ selection: { anchor: Math.min(l.to, l.from + column - 1) } });
  }

  info() {
    const state = this.view.state;
    const line = state.doc.lineAt(state.selection.main.head);
    return { path: this.path, readOnly: state.readOnly, line: line.number, lineText: line.text, text: state.doc.toString() };
  }
}
