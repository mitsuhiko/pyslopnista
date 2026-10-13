import { createRoot } from "react-dom/client";
import { App, type AppController } from "./App";
import { seedExamples } from "./examples";
import "./styles.css";

// Size the app to the visual viewport so the keyboard bar sits on top of the
// software keyboard (WKWebView does not resize the layout viewport).
function trackViewport() {
  const vv = window.visualViewport;
  let frame = 0;
  let last = "";
  const apply = () => {
    frame = 0;
    // A zoomed viewport is not a keyboard: leave the layout alone.
    if (vv && Math.abs(vv.scale - 1) > 0.01) return;
    const height = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const key = `${height}:${top}:${window.innerHeight}`;
    if (key === last) return; // nothing changed: do not touch the layout
    last = key;
    document.documentElement.style.setProperty("--vvh", `${height}px`);
    document.documentElement.style.setProperty("--vv-top", `${top}px`);
    // A visual viewport much shorter than the layout viewport means the keyboard is up.
    document.documentElement.classList.toggle("keyboard-open", window.innerHeight - height > 120);
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  // At most once per frame, after the browser has settled.
  const update = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  vv?.addEventListener("resize", update);
  vv?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  apply();
}

// Containers with overflow: hidden only hide their scrollbars: focusing or
// revealing something they clip (the off-screen page, a hidden sheet)
// scrolls them anyway, and nothing scrolls them back. Undo that right away.
function pinClippedScrollers() {
  const clipped = new WeakMap<Element, boolean>();
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      let pinned = clipped.get(el);
      if (pinned === undefined) {
        const style = getComputedStyle(el);
        pinned = style.overflowX === "hidden" && style.overflowY === "hidden";
        clipped.set(el, pinned);
      }
      if (pinned && (el.scrollLeft || el.scrollTop)) el.scrollTo(0, 0);
    },
    { capture: true, passive: true },
  );
}

trackViewport();
pinClippedScrollers();
await seedExamples();

let resolveController: (c: AppController) => void;
const controller = new Promise<AppController>((r) => (resolveController = r));
createRoot(document.getElementById("root")!).render(<App onReady={(c) => resolveController(c)} />);
void controller.then((c) => ((window as any).__app = c)); // debugging / UI testing aid
void import("./session").then((m) => ((window as any).__session = m.session));
void import("./debug/breakpoints").then((m) => ((window as any).__breakpoints = m.breakpoints));

// Launch hooks for screenshots/debugging: #open=<path>[&bp=<line>,…][&split=<path>][&run][&pane=files|editor|console]
const hook = new URLSearchParams(location.hash.slice(1));
if (hook.has("open") || hook.has("pane")) {
  const c = await controller;
  if (hook.get("open") && hook.get("bp")) {
    const { breakpoints } = await import("./debug/breakpoints");
    breakpoints.set(hook.get("open")!, hook.get("bp")!.split(",").map((line) => ({ line: Number(line), enabled: true })));
  }
  if (hook.get("open")) await c.openFile(hook.get("open")!);
  if (hook.get("split")) {
    c.setSplit(true);
    await new Promise((r) => setTimeout(r, 300));
    await c.openFile(hook.get("split")!);
  }
  if (hook.has("run")) {
    await new Promise((r) => setTimeout(r, 300));
    void c.run();
  }
  if (hook.get("pane")) c.showPane(hook.get("pane") as "files" | "editor" | "console");
  if (hook.has("focus")) setTimeout(() => c.editor()?.focus(), 600);
}

if (location.hash.startsWith("#selftest")) {
  const { selftest } = await import("./selftest");
  await selftest(await controller);
}
