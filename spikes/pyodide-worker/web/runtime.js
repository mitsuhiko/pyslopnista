// Page-side controller for Python workers: a warm pool, output streaming,
// stdin, interrupt, relaying host calls to Swift, and UI messages.

const encoder = new TextEncoder();
const CHANNEL_BYTES = 8 + 1024 * 1024;

// Inside the app the bridge is a WKScriptMessageHandlerWithReply; in a plain
// browser (dev-server.py) it falls back to POST /__bridge; on a static host
// there is no bridge at all.
export const bridge = window.webkit?.messageHandlers?.bridge
  ? (op, value) => window.webkit.messageHandlers.bridge.postMessage({ op, value })
  : async (op, value) => {
      const res = await fetch("/__bridge", { method: "POST", body: JSON.stringify({ op, value }) });
      if (!res.ok) throw new Error(`bridge unavailable (${res.status})`);
      const reply = await res.json();
      if (reply.error) throw new Error(reply.error);
      return reply.value;
    };

/** Options default to the in-app setup; query parameters jspi=1 / gc=1 toggle JSPI. */
export function defaultOptions() {
  const params = new URLSearchParams(location.search);
  return {
    indexURL: new URL("/pyodide/", location.href).href,
    packageBaseUrl: new URL("/pkgs/", location.href).href,
    jspi: params.get("jspi") === "1",
    gcTrampoline: params.get("gc") === "1",
    files: {},
  };
}

export class PyWorker {
  constructor(options = defaultOptions()) {
    this.createdAt = performance.now();
    this.worker = new Worker(new URL("py-worker.js", import.meta.url), { type: "module" });
    // Blocking calls (stdin, interrupt, host.call_sync) need SharedArrayBuffer,
    // which needs cross-origin isolation. Published apps on plain static hosts
    // run without it.
    this.isolated = self.crossOriginIsolated && typeof SharedArrayBuffer === "function";
    this.interrupt = this.isolated ? new Int32Array(new SharedArrayBuffer(4)) : null;
    this.channel = this.isolated ? new SharedArrayBuffer(CHANNEL_BYTES) : null;
    this.syncPending = false;
    this.onOutput = () => {};
    this.onInput = async () => null; // (prompt) => string | null
    this.onUIRender = () => {};
    this.current = null;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.onmessage = (e) => this.handle(e.data);
    this.worker.onerror = (e) => this.rejectReady(new Error(e.message));
    this.worker.postMessage({
      type: "boot",
      interrupt: this.interrupt?.buffer ?? null,
      channel: this.channel,
      ...options,
    });
  }

  handle(msg) {
    switch (msg.type) {
      case "ready":
        this.info = { ...msg, readyAfterMs: performance.now() - this.createdAt };
        this.resolveReady(this.info);
        break;
      case "boot-failed":
        this.rejectReady(new Error(msg.error));
        break;
      case "output":
        this.onOutput(msg.stream, msg.text);
        break;
      case "ui-render":
        this.onUIRender(msg.tree);
        break;
      case "call":
        this.handleCall(msg);
        break;
      case "done":
        this.finish(msg);
        break;
    }
  }

  sendUIEvent(id, args) {
    this.worker.postMessage({ type: "ui-event", id, args });
  }

  async handleCall(msg) {
    let reply;
    try {
      if (msg.sync) this.syncPending = true;
      let value;
      if (msg.op === "stdin") value = await this.onInput();
      else if (msg.op === "host") value = await bridge(msg.value.op, msg.value.value);
      else throw new Error(`unknown call ${msg.op}`);
      reply = { value };
    } catch (e) {
      reply = { error: String(e.message ?? e) };
    }
    if (msg.sync) {
      if (this.syncPending) this.replySync(reply);
    } else {
      this.worker.postMessage({ type: "call-reply", id: msg.id, ...reply });
    }
  }

  replySync(reply) {
    this.syncPending = false;
    const bytes = encoder.encode(JSON.stringify(reply));
    const ints = new Int32Array(this.channel, 0, 2);
    new Uint8Array(this.channel, 8).set(bytes);
    ints[1] = bytes.length;
    Atomics.store(ints, 0, 1);
    Atomics.notify(ints, 0);
  }

  run(code, filename = "main.py") {
    if (this.current) throw new Error("already running");
    if (this.interrupt) Atomics.store(this.interrupt, 0, 0);
    return new Promise((resolve) => {
      this.current = resolve;
      this.worker.postMessage({ type: "run", code, filename });
    });
  }

  finish(msg) {
    clearInterval(this.stopTimer);
    this.stopTimer = null;
    this.current?.(msg);
    this.current = null;
  }

  /**
   * Raise KeyboardInterrupt in the running code (also wakes a blocked stdin or
   * sleep). The interrupt is re-asserted until the run ends, because Pyodide
   * may clear it if the run had not started yet. If the code does not stop
   * within `killAfterMs` (e.g. stuck in C code), the worker is killed. Without
   * isolation there is no interrupt buffer, so stop() kills right away.
   */
  stop(killAfterMs = 1500) {
    if (!this.current) return;
    if (!this.interrupt) {
      this.terminate("killed");
      return;
    }
    const assert = () => {
      Atomics.store(this.interrupt, 0, 2); // SIGINT
      Atomics.notify(this.interrupt, 0); // wake host.sleep
      if (this.syncPending) this.replySync({ interrupted: true });
    };
    assert();
    if (this.stopTimer) return;
    const started = performance.now();
    this.stopTimer = setInterval(() => {
      if (performance.now() - started > killAfterMs) this.terminate("killed: did not respond to KeyboardInterrupt");
      else assert();
    }, 50);
  }

  terminate(reason = "terminated") {
    this.worker.terminate();
    this.finish({ ok: false, error: reason, ms: 0, killed: true });
  }
}

/** Keeps one booted worker in reserve so that a fresh run starts instantly. */
export class WorkerPool {
  constructor(options = defaultOptions()) {
    this.options = options;
    this.spare = new PyWorker(options);
  }

  async take() {
    const worker = this.spare;
    this.spare = new PyWorker(this.options);
    await worker.ready;
    return worker;
  }
}
