// Rendering notebook outputs and Markdown cells (D44). Markdown and HTML are
// sanitized (DOMPurify) and shown in shadow roots, so their styles stay theirs;
// HTML with scripts (Plotly, Bokeh, ...) runs in a sandboxed frame without
// access to the page or the host bridge. Images come as data URLs.
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { Output } from "../notebook/types";

export interface RenderContext {
  openURL(url: string): void;
  /** The output changed its height after it was drawn (images, frames). */
  resized(): void;
}

const RICH_CSS = `
:host { display: block; color: var(--editor-fg, inherit); font: 15px/1.45 -apple-system, system-ui, sans-serif; overflow-wrap: anywhere; white-space: normal; }
.root > :first-child { margin-top: 0; }
.root > :last-child { margin-bottom: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 0.6em 0 0.35em; }
h1 { font-size: 1.6em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; } h4, h5, h6 { font-size: 1em; }
p, ul, ol, blockquote, table, pre { margin: 0.4em 0; }
ul, ol { padding-left: 1.4em; }
a { color: var(--tint, #007aff); }
code { font-family: var(--mono, ui-monospace, monospace); font-size: 0.9em; background: var(--fill, rgba(120,120,128,.12)); padding: 0.1em 0.3em; border-radius: 4px; }
pre { font-family: var(--mono, ui-monospace, monospace); font-size: 0.88em; background: var(--fill, rgba(120,120,128,.12)); padding: 8px 10px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid var(--tertiary, #ccc); padding-left: 10px; color: var(--secondary, #666); margin-left: 0; }
img, svg, video { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid var(--tertiary, #ccc); }
.table-wrap { overflow-x: auto; }
table { border: none; border-collapse: collapse; font-size: 0.86em; font-variant-numeric: tabular-nums; }
th, td { padding: 4px 8px; text-align: right; border: none; border-bottom: 1px solid var(--tertiary, #ddd); white-space: nowrap; }
th { font-weight: 600; }
thead th { border-bottom: 1px solid var(--secondary, #999); }
tbody tr:nth-child(odd) { background: var(--fill, rgba(120,120,128,.08)); }
.dataframe { margin: 0; }
`;

let sheet: CSSStyleSheet | null = null;
function richSheet() {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(RICH_CSS);
  }
  return sheet;
}

/** Sanitized HTML in a shadow root of its own. */
function richBlock(html: string, ctx: RenderContext, className: string): HTMLElement {
  const host = document.createElement("div");
  host.className = className;
  const root = host.attachShadow({ mode: "open" });
  root.adoptedStyleSheets = [richSheet()];
  const div = document.createElement("div");
  div.className = "root";
  div.innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ["style"], FORCE_BODY: true, ADD_ATTR: ["target"] });
  // Wide tables scroll on their own.
  for (const table of div.querySelectorAll("table")) {
    if (table.parentElement?.classList.contains("table-wrap")) continue;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    table.replaceWith(wrap);
    wrap.append(table);
  }
  for (const img of div.querySelectorAll("img")) img.addEventListener("load", () => ctx.resized());
  div.addEventListener("click", (e) => {
    const a = (e.target as Element).closest?.("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^(https?|mailto):/i.test(href)) ctx.openURL(href);
  });
  root.append(div);
  return host;
}

/** Markdown (a cell or an output); `attachment:` images come from the cell. */
export function renderMarkdown(source: string, ctx: RenderContext, attachments?: Record<string, unknown>): HTMLElement {
  let text = source;
  if (attachments) {
    text = text.replace(/attachment:([^\s)"']+)/g, (whole, name: string) => {
      const bundle = attachments[decodeURIComponent(name)] as Record<string, unknown> | undefined;
      const mime = bundle && Object.keys(bundle).find((m) => m.startsWith("image/"));
      if (!mime) return whole;
      const data = bundle![mime];
      return `data:${mime};base64,${(Array.isArray(data) ? data.join("") : String(data)).replace(/\s/g, "")}`;
    });
  }
  const html = marked.parse(text, { gfm: true, async: false }) as string;
  return richBlock(html, ctx, "nb-markdown");
}

// -- ANSI colors (tracebacks from Jupyter, colored output) --------------------------------

const ANSI_COLORS = [
  "#000", "#c91b00", "#00a600", "#c7a700", "#2225c4", "#ca30c7", "#00a6b2", "#bfbfbf",
  "#686868", "#ff6e67", "#5ffa68", "#fffc67", "#6871ff", "#ff77ff", "#60fdff", "#fff",
];

function ansi(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  // Only colors and bold; other escape sequences go.
  const clean = text.replace(/\x1b\[[\d;?]*[A-Za-ln-z]/g, "");
  let color: string | null = null;
  let bold = false;
  let at = 0;
  const push = (s: string) => {
    if (!s) return;
    if (!color && !bold) return out.append(s);
    const span = document.createElement("span");
    if (color) span.style.color = color;
    if (bold) span.style.fontWeight = "600";
    span.textContent = s;
    out.append(span);
  };
  for (const m of clean.matchAll(/\x1b\[([\d;]*)m/g)) {
    push(clean.slice(at, m.index));
    at = m.index! + m[0].length;
    const codes = m[1] ? m[1].split(";").map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) [color, bold] = [null, false];
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) color = null;
      else if (c >= 30 && c <= 37) color = ANSI_COLORS[c - 30];
      else if (c >= 90 && c <= 97) color = ANSI_COLORS[c - 90 + 8];
      else if (c === 38 && codes[i + 1] === 5) {
        const n = codes[i + 2] ?? 7;
        color = n < 16 ? ANSI_COLORS[n] : null;
        i += 2;
      } else if (c === 38 && codes[i + 1] === 2) {
        color = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        i += 4;
      }
    }
  }
  push(clean.slice(at));
  return out;
}

function pre(text: string, className: string): HTMLElement {
  const el = document.createElement("pre");
  el.className = className;
  el.append(ansi(text));
  return el;
}

// -- HTML that runs scripts: a sandboxed frame ----------------------------------------

const FRAME_CSS = `
:root { color-scheme: light dark; font: 14px/1.4 -apple-system, system-ui, sans-serif; }
body { margin: 0; overflow-x: auto; display: flow-root; }
`;

let frameListener = false;
function listenToFrames() {
  if (frameListener) return;
  frameListener = true;
  window.addEventListener("message", (e) => {
    // The self-test's frames report what they could reach.
    const probe = (e.data as { nbProbe?: string })?.nbProbe;
    if (typeof probe === "string") ((window as any).__nbProbes ??= []).push(probe);
    const height = (e.data as { nbFrameHeight?: number })?.nbFrameHeight;
    if (typeof height !== "number") return;
    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe.nb-frame")) {
      if (frame.contentWindow !== e.source) continue;
      const h = Math.min(Math.max(20, Math.ceil(height)), 1600);
      if (frame.style.height !== `${h}px`) {
        frame.style.height = `${h}px`;
        (frame as any).__resized?.();
      }
    }
  });
}

function frame(html: string, ctx: RenderContext): HTMLElement {
  listenToFrames();
  const el = document.createElement("iframe");
  el.className = "nb-frame";
  // Scripts run, but in an opaque origin: no access to this page or the app.
  el.setAttribute("sandbox", "allow-scripts allow-popups");
  el.setAttribute("referrerpolicy", "no-referrer");
  (el as any).__resized = () => ctx.resized();
  el.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${FRAME_CSS}</style></head><body>${html}<script>
const post = () => parent.postMessage({ nbFrameHeight: document.body.getBoundingClientRect().height }, "*");
new ResizeObserver(post).observe(document.body); addEventListener("load", post); post();
</script></body></html>`;
  el.style.height = "24px";
  return el;
}

// -- outputs ---------------------------------------------------------------------------

const asText = (v: unknown) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : JSON.stringify(v, null, 2));

function sizeOf(metadata: Record<string, unknown> | undefined, mime: string): { width?: number; height?: number } {
  const md = ((metadata?.[mime] as Record<string, unknown>) ?? metadata ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : typeof v === "string" && Number(v) > 0 ? Number(v) : undefined);
  return { width: n(md.width), height: n(md.height) };
}

function image(src: string, size: { width?: number; height?: number }, ctx: RenderContext): HTMLElement {
  const img = document.createElement("img");
  img.className = "nb-image";
  img.src = src;
  if (size.width) img.style.width = `${size.width}px`;
  img.addEventListener("load", () => ctx.resized());
  return img;
}

/** Which representation of a bundle to show: the richest we can draw. */
const ORDER = [
  "application/vnd.jupyter.widget-view+json", "text/html", "image/svg+xml", "image/png", "image/jpeg", "image/gif",
  "text/markdown", "application/json", "text/plain", "text/latex",
];

function renderBundle(data: Record<string, unknown>, metadata: Record<string, unknown>, ctx: RenderContext): HTMLElement {
  const mime = ORDER.find((m) => data[m] !== undefined && data[m] !== null) ?? Object.keys(data)[0];
  const value = data[mime];
  switch (mime) {
    case "application/vnd.jupyter.widget-view+json": {
      const box = document.createElement("div");
      const note = document.createElement("div");
      note.className = "nb-status";
      note.textContent = "Interactive widgets are not supported yet.";
      box.append(note);
      if (data["text/plain"]) box.append(pre(asText(data["text/plain"]), "nb-plain"));
      return box;
    }
    case "text/html": {
      const html = asText(value);
      return /<script\b/i.test(html) ? frame(html, ctx) : richBlock(html, ctx, "nb-html");
    }
    case "image/svg+xml":
      // As an image: an SVG's scripts do not run there.
      return image(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(asText(value))}`, sizeOf(metadata, mime), ctx);
    case "image/png":
    case "image/jpeg":
    case "image/gif":
      return image(`data:${mime};base64,${asText(value).replace(/\s/g, "")}`, sizeOf(metadata, mime), ctx);
    case "text/markdown":
      return renderMarkdown(asText(value), ctx);
    case "application/json":
      return pre(JSON.stringify(value, null, 2), "nb-plain");
    default:
      return pre(asText(value ?? ""), "nb-plain");
  }
}

export function renderOutput(output: Output, ctx: RenderContext): HTMLElement {
  switch (output.output_type) {
    case "stream":
      return pre(output.text, `nb-stream ${output.name}`);
    case "error":
      return pre(output.traceback.length ? output.traceback.join("\n") : `${output.ename}: ${output.evalue}`, "nb-error");
    case "status": {
      const el = document.createElement("div");
      el.className = "nb-status";
      el.textContent = output.text;
      return el;
    }
    default: {
      const el = renderBundle(output.data ?? {}, output.metadata ?? {}, ctx);
      el.classList.add("nb-rich");
      return el;
    }
  }
}
