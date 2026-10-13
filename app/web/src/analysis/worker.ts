// Code intelligence worker: ty (type checking, completions, hover) and ruff
// (lint, format), both as WebAssembly. Positions are 1-based line/column in
// UTF-16 code units, matching JS strings.
import initRuff, { type Diagnostic as RuffDiagnostic, PositionEncoding as RuffEncoding, Workspace as RuffWorkspace } from "@astral-sh/ruff-wasm-web";
import ruffWasmUrl from "@astral-sh/ruff-wasm-web/ruff_wasm_bg.wasm?url";
import initTy, { type FileHandle, Position, PositionEncoding, Severity, Workspace as TyWorkspace } from "ty_wasm";
import tyWasmUrl from "ty_wasm/ty_wasm_bg.wasm?url";
import type { AnalysisRequest, CompletionItem, Problem } from "./protocol";

const ROOT = "/project";
let ruff: RuffWorkspace;
let ty: TyWorkspace;
const handles = new Map<string, FileHandle>();
const texts = new Map<string, string>();
let ready: Promise<{ ruff: string; tyMs: number; ruffMs: number }> | null = null;

async function init() {
  const t0 = performance.now();
  await initRuff({ module_or_path: ruffWasmUrl });
  const ruffMs = performance.now() - t0;
  // Ruff's CLI defaults (pyflakes + the E4/E7/E9 errors) plus bugbear: real
  // mistakes, no style nagging. The playground defaults also enable isort etc.
  const defaults = RuffWorkspace.defaultSettings();
  ruff = new RuffWorkspace(
    { ...defaults, "target-version": "py314", lint: { ...defaults.lint, select: ["E4", "E7", "E9", "F", "B"] } },
    RuffEncoding.Utf16,
  );
  const t1 = performance.now();
  await initTy({ module_or_path: tyWasmUrl });
  ty = new TyWorkspace(ROOT, PositionEncoding.Utf16, { environment: { "python-version": "3.14" } });
  return { ruff: RuffWorkspace.version(), ruffMs, tyMs: performance.now() - t1 };
}

const tyPath = (path: string) => `${ROOT}/${path}`;

/** Open or update a file in ty's in-memory project. */
function sync(path: string, text: string) {
  if (texts.get(path) === text && handles.has(path)) return handles.get(path)!;
  let handle = handles.get(path);
  if (handle) ty.updateFile(handle, text);
  else {
    handle = ty.openFile(tyPath(path), text);
    handles.set(path, handle);
  }
  texts.set(path, text);
  return handle;
}

function check(path: string, text: string): Problem[] {
  const problems: Problem[] = [];
  const handle = sync(path, text);
  for (const d of ty.checkFile(handle)) {
    const range = d.toRange(ty);
    if (range) {
      const severity = d.severity();
      problems.push({
        source: "ty",
        code: d.id(),
        message: d.message(),
        severity: severity === Severity.Info ? "info" : severity === Severity.Warning ? "warning" : "error",
        start: { line: range.start.line, column: range.start.column },
        end: { line: range.end.line, column: range.end.column },
      });
      range.free();
    }
    d.free();
  }
  if (path.endsWith(".py")) {
    for (const d of ruff.check(text) as RuffDiagnostic[]) {
      if (d.code === "F821") continue; // ty reports undefined names (unresolved-reference)
      problems.push({
        source: "ruff",
        code: d.code ?? "syntax",
        message: d.message,
        severity: d.code ? "warning" : "error",
        start: { line: d.start_location.row, column: d.start_location.column },
        end: { line: d.end_location.row, column: d.end_location.column },
        fix: d.fix
          ? {
              message: d.fix.message ?? "Fix",
              edits: d.fix.edits.map((e: RuffDiagnostic["fix"] extends infer F ? F extends { edits: (infer E)[] } ? E : never : never) => ({
                start: { line: e.location.row, column: e.location.column },
                end: { line: e.end_location.row, column: e.end_location.column },
                text: e.content ?? "",
              })),
            }
          : undefined,
      });
    }
  }
  return problems;
}

function complete(path: string, text: string, line: number, column: number): CompletionItem[] {
  const handle = sync(path, text);
  const position = new Position(line, column);
  const out = ty.completions(handle, position).map((c) => {
    const item = { name: c.name, kind: c.kind ?? null, detail: c.detail ?? null, insertText: c.insert_text ?? null, module: c.module_name ?? null };
    c.free();
    return item;
  });
  return out.slice(0, 200);
}

function hover(path: string, text: string, line: number, column: number): string | null {
  const handle = sync(path, text);
  const h = ty.hover(handle, new Position(line, column));
  if (!h) return null;
  const md = h.markdown;
  h.free();
  return md;
}

self.onmessage = async (e: MessageEvent<AnalysisRequest & { id: number }>) => {
  const { id, ...req } = e.data;
  try {
    ready ??= init();
    const info = await ready;
    let result: unknown;
    switch (req.type) {
      case "init":
        result = info;
        break;
      case "sync":
        for (const f of req.files) sync(f.path, f.text);
        result = null;
        break;
      case "check":
        result = check(req.path, req.text);
        break;
      case "complete":
        result = complete(req.path, req.text, req.line, req.column);
        break;
      case "hover":
        result = hover(req.path, req.text, req.line, req.column);
        break;
      case "format":
        result = ruff.format(req.text);
        break;
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
