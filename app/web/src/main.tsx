import { createRoot } from "react-dom/client";
import { App, type AppController } from "./App";
import { seedExamples } from "./examples";
import "./styles.css";

// Size the app to the visual viewport so the keyboard bar sits on top of the
// software keyboard (WKWebView does not resize the layout viewport).
function trackViewport() {
  const vv = window.visualViewport;
  const update = () => {
    const height = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--vvh", `${height}px`);
    document.documentElement.style.setProperty("--vv-top", `${vv ? vv.offsetTop : 0}px`);
    // A visual viewport much shorter than the layout viewport means the keyboard is up.
    document.documentElement.classList.toggle("keyboard-open", window.innerHeight - height > 120);
    window.scrollTo(0, 0);
  };
  vv?.addEventListener("resize", update);
  vv?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  update();
}

trackViewport();
await seedExamples();

let resolveController: (c: AppController) => void;
const controller = new Promise<AppController>((r) => (resolveController = r));
createRoot(document.getElementById("root")!).render(<App onReady={(c) => resolveController(c)} />);
void controller.then((c) => ((window as any).__app = c)); // debugging / UI testing aid
void import("./session").then((m) => ((window as any).__session = m.session));
void import("./debug/breakpoints").then((m) => ((window as any).__breakpoints = m.breakpoints));

// Launch hooks for screenshots/debugging: #open=<path>[&bp=<line>,…][&run][&pane=files|editor|console]
const hook = new URLSearchParams(location.hash.slice(1));
if (hook.has("open") || hook.has("pane")) {
  const c = await controller;
  if (hook.get("open") && hook.get("bp")) {
    const { breakpoints } = await import("./debug/breakpoints");
    breakpoints.set(hook.get("open")!, hook.get("bp")!.split(",").map((line) => ({ line: Number(line), enabled: true })));
  }
  if (hook.get("open")) await c.openFile(hook.get("open")!);
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
