// The native bridge (WKScriptMessageHandlerWithReply named "bridge").
const native = (window as any).webkit?.messageHandlers?.bridge;

export async function call<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!native) throw new Error("no native bridge");
  return (await native.postMessage({ op, ...args })) as T;
}

export function log(...parts: unknown[]) {
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  const el = document.getElementById("log");
  if (el) el.textContent += line + "\n";
  void call("log", { value: line }).catch(() => {});
}

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

export interface Config {
  token: string;
  mockUrl: string;
  realKey: boolean;
  loads: number;
  rolledBackOnNavigation: string[];
}
