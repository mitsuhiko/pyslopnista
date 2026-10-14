// The analysis service (ruff + ty) as the CodeMirror integration sees it. It
// runs in the engine page (D31); the engine plugs in the worker client, an
// editor page a proxy that goes through the host to the engine.
import type { CompletionItem, DefinitionTarget, Problem } from "./protocol";

export interface AnalysisApi {
  init(): Promise<{ ruff: string; tyMs: number; ruffMs: number }>;
  sync(files: { path: string; text: string }[]): Promise<null>;
  check(path: string, text: string): Promise<Problem[]>;
  complete(path: string, text: string, line: number, column: number): Promise<CompletionItem[]>;
  hover(path: string, text: string, line: number, column: number): Promise<string | null>;
  definition(path: string, text: string, line: number, column: number): Promise<DefinitionTarget[]>;
  source(path: string): Promise<string>;
  state(): Promise<{ root: string | null; files: string[]; startedAt: number }>;
  setRoot(dir: string): Promise<null>;
  format(text: string): Promise<string>;
}

export const METHODS = ["init", "sync", "check", "complete", "hover", "definition", "source", "state", "setRoot", "format"] as const;

export const analysis = {} as AnalysisApi;

export function setAnalysis(impl: AnalysisApi) {
  for (const m of METHODS) (analysis as any)[m] = (...args: unknown[]) => (impl as any)[m](...args);
}
