// Runs playground/#selftest in headless Chrome over CDP and prints the JSON.
//   node scripts/selftest.mjs <url> [timeoutSeconds]
// Needs Google Chrome (CHROME env var overrides the path) and Node 22+.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
const timeout = Number(process.argv[3] ?? 180) * 1000;
const prefix = process.env.PREFIX ?? "SELFTEST "; // console line that carries the JSON
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(join(tmpdir(), "uikit-chrome-"));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run",
  "--window-size=1400,1000", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "about:blank",
], { stdio: "ignore" });

const cleanup = () => {
  proc.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
};

async function target() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("chrome did not start");
}

try {
  const page = await target();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const result = new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        if (text.startsWith(prefix)) resolve(text.slice(prefix.length));
        else if (process.env.VERBOSE) console.error(`[${msg.params.type}]`, text);
      }
      if (msg.method === "Runtime.exceptionThrown") console.error("page error:", msg.params.exceptionDetails?.exception?.description);
    };
    setTimeout(() => reject(new Error("selftest timed out")), timeout);
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });
  const json = await result;
  console.log(JSON.stringify(JSON.parse(json), null, 2));
  ws.close();
  cleanup();
  process.exit(JSON.parse(json).ok ? 0 : 1);
} catch (e) {
  console.error(e);
  cleanup();
  process.exit(2);
}
