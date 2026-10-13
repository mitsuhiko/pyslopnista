// Main-thread client for the analysis worker (ruff + ty).
import type { AnalysisRequest, CompletionItem, DefinitionTarget, Problem } from "./protocol";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class AnalysisClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  info: { ruff: string; tyMs: number; ruffMs: number } | null = null;

  private ensure() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (error) p?.reject(new Error(error));
      else p?.resolve(result);
    };
    this.worker.onerror = (e) => {
      // A crash (e.g. a stack overflow in ty) poisons the worker: restart lazily.
      for (const p of this.pending.values()) p.reject(new Error(e.message || "analysis worker crashed"));
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    return this.worker;
  }

  private request<T>(req: AnalysisRequest): Promise<T> {
    const worker = this.ensure();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...req });
    });
  }

  async init() {
    this.info = await this.request<{ ruff: string; tyMs: number; ruffMs: number }>({ type: "init" });
    return this.info;
  }

  sync(files: { path: string; text: string }[]) {
    return this.request<null>({ type: "sync", files });
  }

  check(path: string, text: string) {
    return this.request<Problem[]>({ type: "check", path, text });
  }

  complete(path: string, text: string, line: number, column: number) {
    return this.request<CompletionItem[]>({ type: "complete", path, text, line, column });
  }

  hover(path: string, text: string, line: number, column: number) {
    return this.request<string | null>({ type: "hover", path, text, line, column });
  }

  definition(path: string, text: string, line: number, column: number) {
    return this.request<DefinitionTarget[]>({ type: "definition", path, text, line, column });
  }

  source(path: string) {
    return this.request<string>({ type: "source", path });
  }

  state() {
    return this.request<{ root: string | null; files: string[]; startedAt: number }>({ type: "state" });
  }

  setRoot(dir: string) {
    return this.request<null>({ type: "setRoot", dir });
  }

  format(text: string) {
    return this.request<string>({ type: "format", text });
  }
}

export const analysis = new AnalysisClient();
