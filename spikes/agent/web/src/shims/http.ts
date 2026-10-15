// `node:http` for pi-ai's OAuth callback servers, on the host's loopback
// listener (Sources/Loopback.swift). Covers what callback-server.ts and
// openai-chatgpt.ts use: createServer(handler), listen(port, host, cb),
// address(), close(), closeAllConnections(), error events (with
// code EADDRINUSE), and req.method / req.url / res.writeHead / res.end.
import { call } from "../bridge";

type Listener = (...args: any[]) => void;
type Request = { method: string; url: string; headers: Record<string, string> };
type Handler = (request: Request, response: ServerResponse) => void;

const servers = new Map<number, Server>();

(window as any).__loopback = (server: number, connection: number, method: string, target: string) => {
  const s = servers.get(server);
  if (s) s.handle(connection, method, target);
  else void call("loopback.respond", { connection, status: 404, headers: {}, body: "" });
};

export class ServerResponse {
  statusCode = 200;
  private headers: Record<string, string> = {};
  constructor(private connection: number) {}
  setHeader(name: string, value: string) {
    this.headers[name] = String(value);
    return this;
  }
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers ?? {})) this.headers[k] = String(v);
    return this;
  }
  end(body?: string) {
    void call("loopback.respond", { connection: this.connection, status: this.statusCode, headers: this.headers, body: body ?? "" });
  }
}

export class Server {
  private listeners = new Map<string, Set<Listener>>();
  private id: number | undefined;
  private port: number | undefined;
  private closed = false;

  constructor(private handler?: Handler) {}

  on(event: string, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }
  once(event: string, fn: Listener) {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    (wrapper as any).inner = fn;
    return this.on(event, wrapper);
  }
  off(event: string, fn: Listener) {
    const set = this.listeners.get(event);
    for (const l of set ?? []) if (l === fn || (l as any).inner === fn) set!.delete(l);
    return this;
  }
  removeListener(event: string, fn: Listener) {
    return this.off(event, fn);
  }
  private emit(event: string, ...args: unknown[]) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
  }

  listen(port: number, host?: string | Listener, callback?: Listener) {
    if (typeof host === "function") callback = host;
    // The host binds the loopback interface (127.0.0.1 and ::1) whatever `host` says.
    call<{ id: number; port: number }>("loopback.listen", { port: port ?? 0 }).then(
      ({ id, port: bound }) => {
        if (this.closed) return void call("loopback.close", { id });
        this.id = id;
        this.port = bound;
        servers.set(id, this);
        callback?.();
        this.emit("listening");
      },
      (e: unknown) => {
        const message = String((e as Error)?.message ?? e);
        this.emit("error", Object.assign(new Error(message), { code: message.startsWith("EADDRINUSE") ? "EADDRINUSE" : "EIO" }));
      },
    );
    return this;
  }

  address() {
    return this.port === undefined ? null : { address: "127.0.0.1", family: "IPv4", port: this.port };
  }

  close(callback?: Listener) {
    this.closed = true;
    if (this.id !== undefined) {
      servers.delete(this.id);
      void call("loopback.close", { id: this.id });
    }
    callback?.();
    this.emit("close");
    return this;
  }

  closeAllConnections() {
    if (this.id !== undefined) void call("loopback.closeConnections", { id: this.id });
  }

  handle(connection: number, method: string, target: string) {
    this.handler?.({ method, url: target, headers: {} }, new ServerResponse(connection));
  }
}

export function createServer(handler?: Handler) {
  return new Server(handler);
}

export default { createServer };
