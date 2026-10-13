// Bridge to the native host (WKScriptMessageHandlerWithReply "bridge"). In a
// plain browser (npm run dev) a localStorage-backed mock stands in, so the app
// can be developed without the simulator.

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export interface TreeFile {
  path: string; // relative to the requested root
  data: string; // base64
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { bridge?: { postMessage(msg: unknown): Promise<unknown> } } };
  }
}

const native = window.webkit?.messageHandlers?.bridge;
export const isNative = !!native;

export async function call<T = unknown>(op: string, value?: unknown): Promise<T> {
  if (native) return (await native.postMessage({ op, value })) as T;
  return mock(op, value) as T;
}

export const join = (...parts: string[]) => parts.filter(Boolean).join("/").replace(/\/+/g, "/");
export const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export const fs = {
  list: (path: string) => call<Entry[]>("fs.list", { path }),
  readText: (path: string) => call<string>("fs.read", { path, encoding: "utf8" }),
  writeText: (path: string, data: string) => call<void>("fs.write", { path, data, encoding: "utf8" }),
  writeBase64: (path: string, data: string) => call<void>("fs.write", { path, data, encoding: "base64" }),
  mkdir: (path: string) => call<void>("fs.mkdir", { path }),
  rename: (from: string, to: string) => call<void>("fs.rename", { from, to }),
  remove: (path: string) => call<void>("fs.delete", { path }),
  exists: (path: string) => call<boolean>("fs.exists", { path }),
  tree: (path: string) => call<TreeFile[]>("fs.tree", { path }),
};

export const haptic = () => call("haptic").catch(() => {});

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// -- browser mock ------------------------------------------------------------------

type MockNode = { dir: true; mtime: number } | { dir: false; data: string; mtime: number };
const MOCK_KEY = "pyslopnista.mockfs";

function loadMock(): Record<string, MockNode> {
  try {
    return JSON.parse(localStorage.getItem(MOCK_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveMock(nodes: Record<string, MockNode>) {
  localStorage.setItem(MOCK_KEY, JSON.stringify(nodes));
}

const utf8ToB64 = (s: string) => bytesToBase64(new TextEncoder().encode(s));
const b64ToUtf8 = (s: string) => new TextDecoder().decode(base64ToBytes(s));

function mock(op: string, value: any): unknown {
  const nodes = loadMock();
  const now = Date.now();
  const ensureParents = (path: string) => {
    let dir = dirname(path);
    while (dir) {
      nodes[dir] ??= { dir: true, mtime: now };
      dir = dirname(dir);
    }
  };
  const children = (path: string) =>
    Object.keys(nodes).filter((p) => dirname(p) === path && p !== path);
  switch (op) {
    case "fs.list":
      return children(value.path)
        .map((p) => {
          const n = nodes[p];
          return { name: basename(p), path: p, dir: n.dir, size: n.dir ? 0 : atob(n.data).length, mtime: n.mtime };
        })
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    case "fs.read": {
      const n = nodes[value.path];
      if (!n || n.dir) throw new Error(`no such file: ${value.path}`);
      return value.encoding === "base64" ? n.data : b64ToUtf8(n.data);
    }
    case "fs.write":
      ensureParents(value.path);
      nodes[value.path] = { dir: false, data: value.encoding === "base64" ? value.data : utf8ToB64(value.data), mtime: now };
      saveMock(nodes);
      return null;
    case "fs.mkdir":
      ensureParents(join(value.path, "x"));
      saveMock(nodes);
      return null;
    case "fs.rename":
      for (const p of Object.keys(nodes)) {
        if (p === value.from || p.startsWith(value.from + "/")) {
          nodes[value.to + p.slice(value.from.length)] = nodes[p];
          delete nodes[p];
        }
      }
      ensureParents(value.to);
      saveMock(nodes);
      return null;
    case "fs.delete":
      for (const p of Object.keys(nodes)) if (p === value.path || p.startsWith(value.path + "/")) delete nodes[p];
      saveMock(nodes);
      return null;
    case "fs.exists":
      return value.path === "" || value.path in nodes;
    case "fs.tree":
      return Object.entries(nodes)
        .filter(([p, n]) => !n.dir && (value.path === "" || p.startsWith(value.path + "/")))
        .map(([p, n]) => ({ path: value.path ? p.slice(value.path.length + 1) : p, data: (n as { data: string }).data }));
    case "haptic":
    case "log":
    case "result":
      if (op !== "haptic") console.log(`[bridge ${op}]`, value);
      return null;
    default:
      throw new Error(`unknown bridge op ${op}`);
  }
}
