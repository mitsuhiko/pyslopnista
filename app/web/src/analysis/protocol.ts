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

export type AnalysisRequest =
  | { type: "init" }
  | { type: "sync"; files: { path: string; text: string }[] }
  | { type: "check"; path: string; text: string }
  | { type: "complete"; path: string; text: string; line: number; column: number }
  | { type: "hover"; path: string; text: string; line: number; column: number }
  | { type: "format"; text: string };
