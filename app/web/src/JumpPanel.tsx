// "Go to": the outline of the file (classes, functions, methods) with a filter,
// and "Go to line N" when the query is a number. Opened from the file name in
// the nav bar, ⌘L (line) or ⌘⇧O (symbols).
import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "./Icons";

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

const KIND_LABEL = { class: "C", function: "ƒ", method: "M" };

interface Props {
  state: EditorState;
  initial: string; // "" or ":" (line mode)
  onJump: (line: number) => void;
  onClose: () => void;
}

export function JumpPanel({ state, initial, onJump, onClose }: Props) {
  const [query, setQuery] = useState(initial);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const symbols = useMemo(() => outline(state), [state]);
  const lines = state.doc.lines;

  useEffect(() => {
    input.current?.focus();
  }, []);

  const lineQuery = /^:?\s*(\d+)\s*$/.exec(query);
  const q = query.replace(/^[:@]/, "").trim().toLowerCase();
  const matches = lineQuery ? [] : symbols.filter((s) => !q || s.name.toLowerCase().includes(q));
  const items: { label: string; line: number; symbol?: Symbol }[] = lineQuery
    ? [{ label: `Go to Line ${Math.min(Number(lineQuery[1]), lines)}`, line: Math.max(1, Math.min(Number(lineQuery[1]), lines)) }]
    : matches.map((s) => ({ label: s.name, line: s.line, symbol: s }));

  useEffect(() => setIndex(0), [query]);

  const choose = (i: number) => {
    const item = items[i];
    if (!item) return;
    onClose();
    onJump(item.line);
  };

  return createPortal(
    <div className="menu-scrim jump-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="jump-panel" role="dialog" aria-label="Go to">
        <div className="jump-search">
          <Search size={17} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(index);
              }
            }}
            placeholder={`Symbol, or line number (1–${lines})`}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            inputMode={initial === ":" ? "numeric" : "text"}
            aria-label="Symbol or line number"
          />
        </div>
        <div className="jump-list" role="listbox">
          {items.map((item, i) => (
            <button
              key={`${item.label}:${item.line}`}
              role="option"
              aria-selected={i === index}
              className={`jump-item ${i === index ? "selected" : ""}`}
              onClick={() => choose(i)}
              onPointerMove={() => setIndex(i)}
            >
              {item.symbol ? (
                <>
                  <span className={`symbol-kind ${item.symbol.kind}`} style={{ marginLeft: item.symbol.depth * 16 }}>{KIND_LABEL[item.symbol.kind]}</span>
                  <span className="jump-name">{item.label}</span>
                </>
              ) : (
                <span className="jump-name">{item.label}</span>
              )}
              <span className="jump-line">{item.line}</span>
            </button>
          ))}
          {items.length === 0 && <div className="jump-empty">{symbols.length ? "No matching symbols" : "No classes or functions in this file"}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
