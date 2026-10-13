// Breakpoints per file (D23). They live in app state, never in the source, and
// follow the file through edits (the editor maps them), renames and deletes.
export interface Breakpoint {
  line: number;
  enabled: boolean;
}

type Data = Record<string, Breakpoint[]>;

const KEY = "pyslopnista.breakpoints";

function load(): Data {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

const EMPTY: Breakpoint[] = [];

class BreakpointStore {
  private data: Data = load();
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.data;

  get(path: string | null): Breakpoint[] {
    return (path && this.data[path]) || EMPTY;
  }

  private commit(next: Data) {
    for (const [path, list] of Object.entries(next)) if (!list.length) delete next[path];
    this.data = next;
    localStorage.setItem(KEY, JSON.stringify(next));
    for (const fn of this.listeners) fn();
  }

  set(path: string, list: Breakpoint[]) {
    const byLine = new Map<number, Breakpoint>();
    for (const bp of list) if (bp.line > 0 && !byLine.has(bp.line)) byLine.set(bp.line, bp);
    const sorted = [...byLine.values()].sort((a, b) => a.line - b.line);
    const current = this.get(path);
    if (sorted.length === current.length && sorted.every((bp, i) => bp.line === current[i].line && bp.enabled === current[i].enabled)) return;
    this.commit({ ...this.data, [path]: sorted });
  }

  add(path: string, line: number) {
    this.set(path, [...this.get(path), { line, enabled: true }]);
  }

  remove(path: string, line: number) {
    this.set(path, this.get(path).filter((bp) => bp.line !== line));
  }

  setEnabled(path: string, line: number, enabled: boolean) {
    this.set(path, this.get(path).map((bp) => (bp.line === line ? { ...bp, enabled } : bp)));
  }

  clear(path: string) {
    if (this.data[path]) this.commit({ ...this.data, [path]: [] });
  }

  /** A file or folder was renamed. */
  rename(from: string, to: string) {
    const next: Data = {};
    let changed = false;
    for (const [path, list] of Object.entries(this.data)) {
      if (path === from || path.startsWith(from + "/")) {
        next[to + path.slice(from.length)] = list;
        changed = true;
      } else {
        next[path] = list;
      }
    }
    if (changed) this.commit(next);
  }

  /** A file or folder was deleted. */
  removeAll(prefix: string) {
    const next = Object.fromEntries(Object.entries(this.data).filter(([path]) => !(path === prefix || path.startsWith(prefix + "/"))));
    if (Object.keys(next).length !== Object.keys(this.data).length) this.commit(next);
  }

  /** Enabled breakpoints for a run in `dir`, keyed by path relative to it. */
  forRun(dir: string): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    const prefix = dir ? dir + "/" : "";
    for (const [path, list] of Object.entries(this.data)) {
      if (prefix && !path.startsWith(prefix)) continue;
      // Only the run's own folder tree is synced into the interpreter.
      const rel = path.slice(prefix.length);
      const lines = list.filter((bp) => bp.enabled).map((bp) => bp.line);
      if (lines.length) out[rel] = lines;
    }
    return out;
  }
}

export const breakpoints = new BreakpointStore();
