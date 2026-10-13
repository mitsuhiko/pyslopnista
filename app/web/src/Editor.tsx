// CodeMirror 6 editor (P1) tuned for touch: one view, one cached EditorState per
// file (keeps undo history and selection when switching files).
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, redo, toggleComment, undo } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration, type DecorationSet, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, ViewPlugin, type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface EditorHandle {
  getText(): string;
  insert(text: string, cursorOffset?: number): void;
  command(name: EditorCommand): void;
  focus(): void;
  blur(): void;
  view(): EditorView | null;
}

export type EditorCommand = "undo" | "redo" | "indent" | "dedent" | "comment" | "left" | "right" | "up" | "down" | "search";

interface Props {
  path: string | null;
  text: string;
  onChange: (path: string, text: string) => void;
  onFocusChange: (focused: boolean) => void;
}

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

function extensions(onChange: (text: string) => void, onFocus: (focused: boolean) => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true, icons: false }),
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
      if (u.docChanged) onChange(u.state.doc.toString());
      if (u.focusChanged) onFocus(u.view.hasFocus);
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

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ path, text, onChange, onFocusChange }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const pathRef = useRef(path);
  const changeRef = useRef(onChange);
  const focusRef = useRef(onFocusChange);
  changeRef.current = onChange;
  focusRef.current = onFocusChange;

  const makeState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: extensions(
        (t) => pathRef.current && changeRef.current(pathRef.current, t),
        (f) => focusRef.current(f),
      ),
    });

  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: makeState("") });
    viewRef.current = view;
    return () => view.destroy();
  }, []);

  // Switch documents: stash the old state, restore or create the new one.
  useEffect(() => {
    const view = viewRef.current!;
    const prev = pathRef.current;
    if (prev && prev !== path) states.current.set(prev, view.state);
    pathRef.current = path;
    if (path === null) {
      view.setState(makeState(""));
      return;
    }
    const cached = states.current.get(path);
    if (cached && cached.doc.toString() === text) view.setState(cached);
    else if (view.state.doc.toString() !== text || prev !== path) view.setState(makeState(text));
  }, [path, text]);

  useImperativeHandle(ref, () => ({
    getText: () => viewRef.current?.state.doc.toString() ?? "",
    view: () => viewRef.current,
    focus: () => viewRef.current?.focus(),
    blur: () => viewRef.current?.contentDOM.blur(),
    insert(insertText, cursorOffset = insertText.length) {
      const view = viewRef.current;
      if (!view) return;
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
      const commands = { undo, redo, indent: indentMore, dedent: indentLess, comment: toggleComment, search: openSearchPanel };
      if (name in commands) commands[name as keyof typeof commands](view);
      else cursorMove(view, name as "left" | "right" | "up" | "down");
    },
  }));

  return <div className="editor" ref={host} />;
});
