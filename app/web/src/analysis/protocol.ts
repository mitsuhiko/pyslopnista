export interface LineCol {
  line: number; // 1-based
  column: number; // 1-based, UTF-16 code units
}

export interface Problem {
  source: "ty" | "ruff";
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  start: LineCol;
  end: LineCol;
  fix?: { message: string; edits: { start: LineCol; end: LineCol; text: string }[] };
}

export interface CompletionItem {
  name: string;
  kind: number | null;
  detail: string | null;
  insertText: string | null;
  module: string | null;
}

/** Where a symbol is defined: a project file (app path) or a read-only external one. */
export interface DefinitionTarget {
  path: string; // app path, or "ext:<ty path>" for the stdlib and our runtime stubs
  external: boolean;
  start: LineCol;
  end: LineCol;
}

export type AnalysisRequest =
  | { type: "init" }
  | { type: "sync"; files: { path: string; text: string }[] }
  | { type: "check"; path: string; text: string }
  | { type: "complete"; path: string; text: string; line: number; column: number }
  | { type: "hover"; path: string; text: string; line: number; column: number }
  | { type: "format"; text: string }
  | { type: "definition"; path: string; text: string; line: number; column: number }
  | { type: "source"; path: string } // text of an "ext:" path
  | { type: "setRoot"; dir: string } // the run's folder: sibling modules are importable
  | { type: "state" }; // diagnostics: root, known files, when the worker started
