// Mirrors the session in the host (D31): the console transcript as patches
// (new lines, text appended to a line, the current order), everything else
// whole. Coalesced to one message per task.
import { call } from "../host";
import { type Line, session } from "../session";
import type { Trace } from "../trace";

interface LinePatch {
  id: number;
  runId: number;
  kind: string;
  text?: string;
  append?: string;
  trace?: Trace; // with `text` (a traceback line is never appended to)
}

export function startStateSync() {
  let sent = new Map<number, string>();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const s = session.getSnapshot();
    const changed: LinePatch[] = [];
    const next = new Map<number, string>();
    for (const line of s.lines as Line[]) {
      const old = sent.get(line.id);
      next.set(line.id, line.text);
      if (old === line.text) continue;
      if (old !== undefined && line.text.startsWith(old)) changed.push({ id: line.id, runId: line.runId, kind: line.kind, append: line.text.slice(old.length) });
      else changed.push({ id: line.id, runId: line.runId, kind: line.kind, text: line.text, ...(line.trace ? { trace: line.trace } : {}) });
    }
    sent = next;
    const payload = {
      changed,
      ids: s.lines.map((l) => l.id),
      runs: s.runs,
      status: s.status,
      awaitingInput: s.awaitingInput,
      uiOpen: s.uiOpen,
      runningFile: s.runningFile,
      bootMs: s.bootMs,
      runCounter: s.runCounter,
      debug: s.debug,
      pausing: s.pausing,
      canInspect: session.canInspect,
      kernel: s.kernel,
    };
    void call("session.state", { json: JSON.stringify(payload) }).catch(() => {});
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(flush, 0);
  };
  session.subscribe(schedule);
  schedule();
}
