// Notebooks as text (D44). The editor shows a notebook as one CodeMirror
// document: each cell is a marker line followed by its source. In a `.ipynb`
// the marker lines are ours (hidden behind cell headers, with a private-use
// character so no source line can look like one); in a `.py` file they are the
// percent format's `# %%` comments that VS Code, Spyder and jupytext use.
import type { Output } from "./types";

export type CellType = "code" | "markdown" | "raw";
export type NotebookKind = "ipynb" | "py";

export interface CellInfo {
  id: string;
  type: CellType;
  outputs: Output[];
  count: number | null;
  status: "idle" | "queued" | "running";
  metadata: Record<string, unknown>;
  attachments?: Record<string, unknown>;
  /** clear_output(wait=True): the next output replaces what is there. */
  clearOnOutput?: boolean;
}

export interface NotebookMeta {
  nbformat_minor: number;
  metadata: Record<string, unknown>;
}

const PRIVATE = "\uE000";
const IPYNB_MARKER = new RegExp(`^# %%${PRIVATE}(code|markdown|raw)$`);
/** `# %%`, `#%%`, `# %% Title [markdown]` (not `# %%%`). */
const PERCENT_MARKER = /^#\s?%%(?!%)(.*)$/;

/** The cell type a line starts, or null if it is no marker line. */
export function markerType(kind: NotebookKind, line: string): CellType | null {
  if (kind === "ipynb") {
    const m = IPYNB_MARKER.exec(line);
    return m ? (m[1] as CellType) : null;
  }
  const m = PERCENT_MARKER.exec(line);
  if (!m) return null;
  if (/\[(markdown|md)\]/i.test(m[1])) return "markdown";
  if (/\[raw\]/i.test(m[1])) return "raw";
  return "code";
}

export function markerLine(kind: NotebookKind, type: CellType): string {
  if (kind === "ipynb") return `# %%${PRIVATE}${type}`;
  return type === "code" ? "# %%" : `# %% [${type}]`;
}

export const newCellId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export function newCell(type: CellType = "code"): CellInfo {
  return { id: newCellId(), type, outputs: [], count: null, status: "idle", metadata: {} };
}

// -- .ipynb --------------------------------------------------------------------------

const joined = (v: unknown): string => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");

/** Multi-line strings are lists of lines in a .ipynb (each with its "\n"). */
function lines(text: string): string[] {
  if (!text) return [];
  const out = text.split(/(?<=\n)/);
  return out;
}

function readBundle(data: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [mime, value] of Object.entries((data ?? {}) as Record<string, unknown>)) {
    out[mime] = Array.isArray(value) && value.every((v) => typeof v === "string") ? value.join("") : value;
  }
  return out;
}

function writeBundle(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [mime, value] of Object.entries(data)) {
    // Text goes in lines, as Jupyter writes it; images and JSON stay whole.
    const text = typeof value === "string" && (mime.startsWith("text/") || mime === "image/svg+xml");
    out[mime] = text ? lines(value as string) : value;
  }
  return out;
}

function readOutput(o: any): Output | null {
  switch (o?.output_type) {
    case "stream":
      return { output_type: "stream", name: o.name === "stderr" ? "stderr" : "stdout", text: joined(o.text) };
    case "display_data":
      return { output_type: "display_data", data: readBundle(o.data), metadata: o.metadata ?? {} };
    case "execute_result":
      return { output_type: "execute_result", data: readBundle(o.data), metadata: o.metadata ?? {}, execution_count: o.execution_count ?? null };
    case "error":
      return { output_type: "error", ename: String(o.ename ?? ""), evalue: String(o.evalue ?? ""), traceback: Array.isArray(o.traceback) ? o.traceback.map(String) : [] };
    default:
      return null;
  }
}

function writeOutput(o: Output): Record<string, unknown> | null {
  switch (o.output_type) {
    case "stream":
      return { name: o.name, output_type: "stream", text: lines(o.text) };
    case "display_data":
      return { data: writeBundle(o.data), metadata: o.metadata ?? {}, output_type: "display_data" };
    case "execute_result":
      return { data: writeBundle(o.data), execution_count: o.execution_count, metadata: o.metadata ?? {}, output_type: "execute_result" };
    case "error":
      return { ename: o.ename, evalue: o.evalue, output_type: "error", traceback: o.traceback };
    default:
      return null; // status lines are ours
  }
}

export interface ParsedNotebook {
  text: string;
  infos: CellInfo[];
  meta: NotebookMeta;
}

export function parseIpynb(json: string): ParsedNotebook {
  const nb = json.trim() ? JSON.parse(json) : { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
  if (typeof nb !== "object" || nb === null || !Array.isArray(nb.cells ?? [])) throw new Error("This is not a Jupyter notebook.");
  if ((nb.nbformat ?? 4) < 4) throw new Error(`Notebook format ${nb.nbformat} is too old (4 is supported).`);
  const infos: CellInfo[] = [];
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const c of nb.cells ?? []) {
    const type: CellType = c.cell_type === "markdown" ? "markdown" : c.cell_type === "raw" ? "raw" : "code";
    let id = typeof c.id === "string" && c.id && !seen.has(c.id) ? c.id : newCellId();
    seen.add(id);
    infos.push({
      id, type,
      outputs: type === "code" ? (c.outputs ?? []).map(readOutput).filter(Boolean) : [],
      count: type === "code" ? (c.execution_count ?? null) : null,
      status: "idle",
      metadata: c.metadata ?? {},
      ...(c.attachments ? { attachments: c.attachments } : {}),
    });
    // No line of a source may pass as a marker; ours carry a private-use character.
    parts.push(`${markerLine("ipynb", type)}\n${joined(c.source).replaceAll(PRIVATE, "")}`);
  }
  if (!infos.length) {
    infos.push(newCell("code"));
    parts.push(`${markerLine("ipynb", "code")}\n`);
  }
  return {
    text: parts.join("\n"),
    infos,
    meta: { nbformat_minor: Math.max(5, nb.nbformat_minor ?? 5), metadata: nb.metadata ?? {} },
  };
}

/** Keys sorted at every level, as Jupyter writes them (diffs stay small). */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sorted((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export const DEFAULT_METADATA = {
  kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
  language_info: { name: "python" },
};

export function serializeIpynb(meta: NotebookMeta, cells: { info: CellInfo; source: string }[]): string {
  const out = cells.map(({ info, source }) => {
    const base: Record<string, unknown> = { cell_type: info.type, id: info.id, metadata: info.metadata ?? {}, source: lines(source) };
    if (info.type === "code") {
      base.execution_count = info.count;
      base.outputs = info.outputs.map(writeOutput).filter(Boolean);
    } else if (info.attachments) {
      base.attachments = info.attachments;
    }
    return base;
  });
  const metadata = Object.keys(meta.metadata ?? {}).length ? meta.metadata : DEFAULT_METADATA;
  const nb = { cells: out, metadata, nbformat: 4, nbformat_minor: meta.nbformat_minor };
  return JSON.stringify(sorted(nb), null, 1) + "\n";
}

// -- what ruff and ty see -------------------------------------------------------------

/** IPython syntax that is no Python: magics, shell escapes, `obj?`. */
const MAGIC_LINE = /^\s*(%|!(?!=)|\?)|^\s*[A-Za-z_][\w.]*\?\??\s*$/;

/** Spaces for the text (line breaks kept): positions stay where they are. */
const blank = (text: string) => text.replace(/[^\n]/g, " ");

/**
 * The document as Python for code analysis: markdown and raw cells, magics and
 * cells of other languages (`%%html`) become spaces, so every position is the
 * same as in the editor.
 */
export function analysisText(doc: string, cells: { type: CellType; from: number; to: number }[]): string {
  if (!cells.length) return doc;
  let out = "";
  let at = 0;
  for (const cell of cells) {
    out += doc.slice(at, cell.from);
    const source = doc.slice(cell.from, cell.to);
    if (cell.type !== "code") {
      out += blank(source);
    } else {
      const first = source.split("\n").find((l) => l.trim());
      if (first?.trimStart().startsWith("%%") && !/^\s*%%(time|capture)\b/.test(first)) out += blank(source);
      else out += source.split("\n").map((l) => (MAGIC_LINE.test(l) ? blank(l) : l)).join("\n");
    }
    at = cell.to;
  }
  return out + doc.slice(at);
}
