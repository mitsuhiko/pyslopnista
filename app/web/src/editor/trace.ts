// A traceback as data (D45), drawn for a notebook's error output: frames in
// Python's order (most recent call last), the innermost of the program's own
// frames open with its source and the failing span marked, the standard
// library's and packages' frames folded, the exception at the bottom with its
// message in the regular font. Earlier exceptions of a chain are folded.
// The console draws the same in SwiftUI (TracebackView.swift).
import { CHAIN_TEXT, type Trace, type TraceException, type TraceFrame } from "../trace";

export interface TraceContext {
  /** A frame's place, when it can be shown: a cell of this notebook or a project file. */
  open?(frame: TraceFrame): void;
  canOpen?(frame: TraceFrame): boolean;
  /** Something opened or closed: the height changed. */
  resized(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderTrace(trace: Trace, ctx: TraceContext): HTMLElement {
  const root = el("div", "tb");
  root.append(...chain(trace.exceptions, ctx, true));
  return root;
}

/** A chain, oldest first: the last one open, the others folded. */
function chain(list: TraceException[], ctx: TraceContext, top: boolean): HTMLElement[] {
  const out: HTMLElement[] = [];
  list.forEach((exc, i) => {
    const last = i === list.length - 1;
    if (exc.chain && i > 0) out.push(el("div", "tb-chain", CHAIN_TEXT[exc.chain]));
    if (last) {
      out.push(exception(exc, ctx, top));
    } else {
      const details = el("details", "tb-earlier");
      const summary = el("summary");
      summary.append(el("span", "tb-type", exc.type), el("span", "tb-sep", ": "), el("span", "tb-summary-msg", firstLine(exc.message)));
      details.append(summary);
      details.addEventListener("toggle", () => {
        if (details.open && details.children.length === 1) details.append(exception(exc, ctx, false));
        ctx.resized();
      });
      out.push(details);
    }
  });
  return out;
}

const firstLine = (text: string) => {
  const line = text.split("\n")[0];
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

function exception(exc: TraceException, ctx: TraceContext, openInnermost: boolean): HTMLElement {
  const box = el("div", "tb-exc");
  const frames = el("div", "tb-frames");
  // The innermost frame of the program's own (or the innermost one at all) starts open.
  let open = -1;
  if (openInnermost && !exc.syntax) {
    open = exc.frames.findLastIndex((f) => f.kind === "app" && f.context);
    if (open < 0) open = exc.frames.findLastIndex((f) => f.kind !== "omitted" && f.context);
  }
  let i = 0;
  while (i < exc.frames.length) {
    const f = exc.frames[i];
    if (f.kind === "library") {
      // Library frames in a row fold into one row (unless the open one is among them).
      let j = i;
      while (j < exc.frames.length && exc.frames[j].kind === "library") j++;
      const run = exc.frames.slice(i, j);
      if (open >= i && open < j) {
        run.forEach((g, k) => frames.append(frame(g, ctx, i + k === open)));
      } else if (run.length === 1) {
        frames.append(frame(run[0], ctx, false));
      } else {
        const details = el("details", "tb-lib");
        const summary = el("summary", "tb-row");
        summary.append(el("span", "tb-lib-label", `${run.length} library frames`));
        details.append(summary);
        details.addEventListener("toggle", () => {
          if (details.open && details.children.length === 1) details.append(...run.map((g) => frame(g, ctx, false)));
          ctx.resized();
        });
        frames.append(details);
      }
      i = j;
      continue;
    }
    if (f.kind === "omitted") frames.append(el("div", "tb-omitted", `${f.count} more frames not shown`));
    else frames.append(frame(f, ctx, i === open));
    i++;
  }
  if (exc.syntax) frames.append(frame(exc.syntax, ctx, true));
  if (frames.children.length) box.append(frames);

  const head = el("div", "tb-head");
  head.append(el("div", "tb-type", exc.type));
  if (exc.message) head.append(el("div", "tb-msg", exc.message));
  for (const note of exc.notes ?? []) head.append(el("div", "tb-note", note));
  box.append(head);

  if (exc.group?.length) {
    const members = el("div", "tb-group");
    exc.group.forEach((member, k) => {
      const last = member.at(-1)!;
      const details = el("details", "tb-member");
      const summary = el("summary");
      summary.append(el("span", "tb-count", `${k + 1}`), el("span", "tb-type", last.type), el("span", "tb-sep", ": "), el("span", "tb-summary-msg", firstLine(last.message)));
      details.append(summary);
      details.addEventListener("toggle", () => {
        if (details.open && details.children.length === 1) {
          const body = el("div", "tb");
          body.append(...chain(member, ctx, true));
          details.append(body);
        }
        ctx.resized();
      });
      members.append(details);
    });
    if (exc.groupMore) members.append(el("div", "tb-omitted", `and ${exc.groupMore} more`));
    box.append(members);
  }
  return box;
}

function frame(f: TraceFrame, ctx: TraceContext, open: boolean): HTMLElement {
  const details = el("details", `tb-frame ${f.kind}`);
  const summary = el("summary", "tb-row");
  const name = f.name == null ? "SyntaxError" : f.name === "<module>" ? "module level" : f.name;
  summary.append(el("span", "tb-name", name));
  const where = `${f.file}:${f.line}`;
  if (f.file && f.line && ctx.canOpen?.(f)) {
    const link = el("button", "tb-loc link", where);
    link.title = `Show ${f.file}, line ${f.line}`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctx.open?.(f);
    });
    summary.append(link);
  } else {
    summary.append(el("span", "tb-loc", where));
  }
  if (f.repeat) summary.append(el("span", "tb-repeat", `repeated ${f.repeat} more ${f.repeat === 1 ? "time" : "times"}`));
  details.append(summary);
  if (!f.context) {
    details.classList.add("bare");
    summary.addEventListener("click", (e) => e.preventDefault()); // nothing to show
    return details;
  }
  let code: HTMLElement | null = null;
  const fill = () => {
    if (code) return;
    code = source(f, ctx);
    details.append(code);
  };
  if (open) {
    details.open = true;
    fill();
    requestAnimationFrame(() => code && revealSpan(code));
  }
  details.addEventListener("toggle", () => {
    if (details.open) {
      fill();
      requestAnimationFrame(() => code && revealSpan(code));
    }
    ctx.resized();
  });
  return details;
}

/** The context lines with numbers; the failing lines tinted, their span marked. */
function source(f: TraceFrame, ctx: TraceContext): HTMLElement {
  const box = el("div", "tb-code");
  const { start, lines } = f.context!;
  const first = f.line!;
  const last = f.endLine ?? first;
  const width = String(start + lines.length - 1).length;
  lines.forEach((text, k) => {
    const n = start + k;
    const row = el("div", "tb-line");
    row.append(el("span", "tb-no", String(n).padStart(width)));
    const src = el("span", "tb-src");
    if (n >= first && n <= last) {
      row.classList.add("err");
      const chars = Array.from(text);
      const indent = chars.findIndex((c) => c !== " " && c !== "\t");
      let from = n === first ? (f.col ?? (indent < 0 ? 0 : indent)) : indent < 0 ? 0 : indent;
      let to = n === last ? (f.endCol ?? chars.length) : chars.length;
      from = Math.min(Math.max(0, from), chars.length);
      to = Math.min(Math.max(from, to), chars.length);
      if (to === from && n === first && f.col !== undefined && from < chars.length) to = from + 1;
      src.append(chars.slice(0, from).join(""));
      if (to > from) src.append(el("mark", "tb-span", chars.slice(from, to).join("")));
      src.append(chars.slice(to).join(""));
      if (to === from && from === chars.length && f.col !== undefined) src.append(el("mark", "tb-span tb-eol", " "));
    } else {
      src.textContent = text;
    }
    row.append(src);
    box.append(row);
  });
  if (f.file && f.line && ctx.canOpen?.(f)) {
    box.classList.add("link");
    box.addEventListener("click", () => {
      if (getSelection()?.toString()) return;
      ctx.open?.(f);
    });
  }
  return box;
}

/** A span that starts far to the right: scrolled to, a bit of what is before it showing. */
function revealSpan(code: HTMLElement) {
  const mark = code.querySelector<HTMLElement>(".tb-span");
  if (!mark) return;
  const box = code.getBoundingClientRect();
  const x = mark.getBoundingClientRect().left - box.left;
  if (x > box.width * 0.6) code.scrollLeft += x - box.width * 0.2;
}
