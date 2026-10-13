// CodeMirror 6 editor (P1) tuned for touch: one view, one cached EditorState per
// file (keeps undo history and selection when switching files).
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { analysisCompletions, analysisLinter } from "./analysis/codemirror";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, redo, toggleComment, undo } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { openLintPanel } from "@codemirror/lint";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Annotation, type ChangeSet, EditorState, type Extension, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  Decoration, type DecorationSet, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, ViewPlugin, type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef, useSyncExternalStore } from "react";
import { type Breakpoint, breakpoints as breakpointStore } from "./debug/breakpoints";
import {
  breakpointLines, debugExtensions, pausedCompartment, pausedExtension, setBreakpointsEffect, setDebugLineEffect,
} from "./debug/codemirror";

export interface EditorHandle {
  /** The file the editor shows right now (switching happens after a render). */
  currentPath(): string | null;
  getText(): string;
  insert(text: string, cursorOffset?: number): void;
  command(name: EditorCommand): void;
  focus(): void;
  blur(): void;
  view(): EditorView | null;
  /** Edits made to the same file in another pane. */
  applyRemote(path: string, changes: ChangeSet): void;
  /** The file changed on disk (written by a program). */
  replaceText(path: string, text: string): void;
  renamePath(from: string, to: string): void;
  forget(path: string): void;
}

export type EditorCommand = "undo" | "redo" | "indent" | "dedent" | "comment" | "left" | "right" | "up" | "down" | "search" | "problems";

export interface Reveal {
  path: string;
  line: number;
  column?: number;
  nonce: number;
}

interface Props {
  path: string | null;
  /** Content for a path the editor has no state for yet. */
  text: string;
  readOnly?: boolean;
  /** Local edits (not remote ones), for saving. */
  onChange: (path: string, text: string, changes: ChangeSet) => void;
  onFocusChange: (focused: boolean) => void;
  /** Called (at most once per frame) after any editor update, e.g. for the problem bar. */
  onViewUpdate?: (view: EditorView) => void;
  onGutterLongPress: (path: string, line: number, rect: DOMRect) => void;
  /** F12 or ⌘-click: jump to the definition at the cursor. */
  onDefinition?: () => void;
  // Debugger (D23)
  paused: boolean;
  onInspect: (expr: string, rect: DOMRect) => void;
  debugLine: number | null;
  /** How much of the editor's height is not covered (by the console sheet). */
  visibleFraction: number;
  /** Jump to a line (tracebacks, go to definition). */
  reveal: Reveal | null;
}

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
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.operatorKeyword, t.moduleKeyword], color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.className)], color: "var(--syn-def)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-call)" },
  { tag: [t.self, t.special(t.variableName)], color: "var(--syn-self)" },
  { tag: t.className, color: "var(--syn-class)" },
  { tag: t.meta, color: "var(--syn-meta)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size)", background: "var(--editor-bg)", color: "var(--label)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.5", overscrollBehavior: "contain" },
  ".cm-content": { caretColor: "var(--tint)", paddingBottom: "40vh" },
  ".cm-gutters": { background: "var(--editor-bg)", color: "var(--tertiary)", border: "none" },
  ".cm-activeLine": { background: "var(--active-line)" },
  ".cm-activeLineGutter": { background: "transparent", color: "var(--secondary)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--tint)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { background: "var(--selection) !important" },
  ".cm-matchingBracket": { background: "var(--bracket-match)", outline: "none" },
  ".cm-tooltip": { border: "none", borderRadius: "10px", overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,.2)", background: "var(--cell-bg)" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "6px 10px !important", fontFamily: "var(--mono)" },
  ".cm-panels": { background: "var(--grouped-bg)", color: "var(--label)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--red)", textDecorationSkipInk: "none", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy #ff9500", textDecorationSkipInk: "none", textUnderlineOffset: "3px" },
  ".cm-lintRange-info": { backgroundImage: "none", textDecoration: "underline dotted var(--secondary)", textUnderlineOffset: "3px" },
  ".cm-panel.cm-panel-lint ul": { maxHeight: "30vh", fontFamily: "-apple-system, system-ui", fontSize: "14px" },
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

function extensions(
  onChange: (text: string, changes: ChangeSet) => void,
  onFocus: (focused: boolean) => void,
  onUpdate: (view: EditorView) => void,
  getPath: () => string | null,
  onGutterLongPress: (line: number, rect: DOMRect) => void,
  onBreakpointsMoved: (state: EditorState) => void,
  onDefinition: () => void,
  readOnly: boolean,
): Extension[] {
  return [
    readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
    flashField,
    keymap.of([{ key: "F12", run: () => (onDefinition(), true) }]),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        view.dispatch({ selection: { anchor: pos } });
        onDefinition();
        return true;
      },
    }),
    debugExtensions(onGutterLongPress),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true, icons: false, override: [analysisCompletions(getPath)] }),
    analysisLinter(getPath),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    python(),
    EditorView.lineWrapping,
    hangingIndent,
    indentUnit.of("    "),
    EditorState.tabSize.of(4),
    syntaxHighlighting(highlight),
    theme,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "Code editor" }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((tr) => tr.annotation(remote))) {
        onChange(u.state.doc.toString(), u.changes);
        onBreakpointsMoved(u.state);
      }
      if (u.focusChanged) onFocus(u.view.hasFocus);
      onUpdate(u.view);
    }),
  ];
}

const cursorMove = (view: EditorView, dir: "left" | "right" | "up" | "down") => {
  const sel = view.state.selection.main;
  let pos: number;
  if (dir === "left") pos = Math.max(0, sel.head - 1);
  else if (dir === "right") pos = Math.min(view.state.doc.length, sel.head + 1);
  else {
    const moved = view.moveVertically(sel, dir === "down");
    pos = moved.head;
  }
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
};

const sameBreakpoints = (a: Breakpoint[], b: Breakpoint[]) =>
  a.length === b.length && a.every((bp, i) => bp.line === b[i].line && bp.enabled === b[i].enabled);

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const { path, paused, debugLine, visibleFraction, reveal } = props;
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const pathRef = useRef<string | null>(null);
  const loaded = useRef(false);
  const frame = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  useSyncExternalStore(breakpointStore.subscribe, breakpointStore.getSnapshot);
  const fileBreakpoints = breakpointStore.get(path);

  const makeState = (doc: string, readOnly = false) =>
    EditorState.create({
      doc,
      extensions: extensions(
        (t, changes) => pathRef.current && propsRef.current.onChange(pathRef.current, t, changes),
        (f) => {
          if (f) (window as any).__editorView = viewRef.current; // debugging aid: the focused editor
          propsRef.current.onFocusChange(f);
        },
        (view) => {
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(() => propsRef.current.onViewUpdate?.(view));
        },
        () => pathRef.current,
        (line, rect) => pathRef.current && propsRef.current.onGutterLongPress(pathRef.current, line, rect),
        (state) => {
          const p = pathRef.current;
          if (!p) return;
          const lines = breakpointLines(state);
          if (!sameBreakpoints(lines, breakpointStore.get(p))) breakpointStore.set(p, lines);
        },
        () => propsRef.current.onDefinition?.(),
        readOnly,
      ),
    });

  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: makeState("") });
    viewRef.current = view;
    (window as any).__editorView ??= view; // debugging aid
    // Re-measure when our box changes size (sheets, rotation, split panes):
    // wrapped line heights depend on the width.
    const ro = new ResizeObserver(() => view.requestMeasure());
    ro.observe(host.current!);
    return () => {
      ro.disconnect();
      if ((window as any).__editorView === view) (window as any).__editorView = null;
      view.destroy();
    };
  }, []);

  // Switch documents: stash the old state, restore or create the new one.
  useEffect(() => {
    const view = viewRef.current!;
    const prev = pathRef.current;
    if (loaded.current && prev === path) return;
    if (prev && prev !== path) states.current.set(prev, view.state);
    pathRef.current = path;
    loaded.current = true;
    if (path === null) {
      view.setState(makeState(""));
      return;
    }
    view.setState(states.current.get(path) ?? makeState(props.text, props.readOnly));
    // Wrapped line heights are only right once layout has settled (fonts,
    // the push transition); measure again so the gutter lines up.
    requestAnimationFrame(() => view.requestMeasure());
    const t = setTimeout(() => view.requestMeasure(), 450);
    return () => clearTimeout(t);
  }, [path]);

  // Breakpoints from the store (also after switching files).
  useEffect(() => {
    const view = viewRef.current!;
    if (!sameBreakpoints(breakpointLines(view.state), fileBreakpoints)) view.dispatch({ effects: setBreakpointsEffect.of(fileBreakpoints) });
  }, [path, fileBreakpoints]);

  // Paused: read-only and tap-to-inspect.
  useEffect(() => {
    const view = viewRef.current!;
    if (paused) view.contentDOM.blur();
    view.dispatch({
      effects: pausedCompartment.reconfigure(paused ? pausedExtension((expr, rect) => propsRef.current.onInspect(expr, rect)) : []),
    });
  }, [path, paused]);

  /** Bring a line into the part of the editor the console does not cover. */
  const revealLine = (view: EditorView, pos: number, always: boolean) => {
    const block = view.lineBlockAt(pos);
    const scroller = view.scrollDOM;
    const top = scroller.scrollTop;
    const visible = scroller.clientHeight * propsRef.current.visibleFraction;
    if (always || block.top < top + 8 || block.bottom > top + visible - 8) {
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: Math.round(visible * 0.3) }) });
    }
  };

  // The paused line: highlight it and bring it into view.
  useEffect(() => {
    const view = viewRef.current!;
    view.dispatch({ effects: setDebugLineEffect.of(debugLine) });
    if (debugLine === null || debugLine > view.state.doc.lines) return;
    // After a file switch the layout settles first.
    requestAnimationFrame(() => revealLine(view, view.state.doc.line(debugLine).from, false));
  }, [path, debugLine, visibleFraction]);

  // Jump to a line (traceback, definition): select it, scroll, flash.
  useEffect(() => {
    const view = viewRef.current!;
    if (!reveal || reveal.path !== pathRef.current) return;
    const doc = view.state.doc;
    const line = doc.line(Math.max(1, Math.min(reveal.line, doc.lines)));
    const pos = Math.min(line.to, line.from + Math.max(0, (reveal.column ?? 1) - 1));
    view.dispatch({ selection: { anchor: pos }, effects: flashEffect.of(line.from) });
    requestAnimationFrame(() => revealLine(view, pos, false));
    const t = setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1400);
    return () => clearTimeout(t);
  }, [reveal?.nonce]);

  useImperativeHandle(ref, () => ({
    currentPath: () => (loaded.current ? pathRef.current : null),
    getText: () => viewRef.current?.state.doc.toString() ?? "",
    view: () => viewRef.current,
    focus: () => viewRef.current?.focus(),
    blur: () => viewRef.current?.contentDOM.blur(),
    insert(insertText, cursorOffset = insertText.length) {
      const view = viewRef.current;
      if (!view || view.state.readOnly) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: insertText },
        selection: { anchor: sel.from + cursorOffset },
        scrollIntoView: true,
        userEvent: "input.type",
      });
    },
    command(name) {
      const view = viewRef.current;
      if (!view) return;
      const commands = { undo, redo, indent: indentMore, dedent: indentLess, comment: toggleComment, search: openSearchPanel, problems: openLintPanel };
      if (name in commands) commands[name as keyof typeof commands](view);
      else cursorMove(view, name as "left" | "right" | "up" | "down");
    },
    applyRemote(target, changes) {
      const spec = { changes, annotations: [remote.of(true), Transaction.addToHistory.of(false)] };
      if (target === pathRef.current) viewRef.current?.dispatch(spec);
      else {
        const cached = states.current.get(target);
        if (cached) states.current.set(target, cached.update(spec).state);
      }
    },
    replaceText(target, text) {
      const view = viewRef.current;
      if (target === pathRef.current && view) {
        if (view.state.doc.toString() !== text) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: remote.of(true) });
        }
      } else {
        states.current.delete(target);
      }
    },
    renamePath(from, to) {
      const moved = (p: string) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : null);
      for (const [p, st] of [...states.current]) {
        const next = moved(p);
        if (next) {
          states.current.delete(p);
          states.current.set(next, st);
        }
      }
      const current = pathRef.current && moved(pathRef.current);
      if (current) pathRef.current = current;
    },
    forget(target) {
      for (const p of [...states.current.keys()]) if (p === target || p.startsWith(target + "/")) states.current.delete(p);
    },
  }));

  return <div className="editor" ref={host} />;
});
