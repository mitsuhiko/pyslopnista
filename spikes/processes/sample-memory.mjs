// Samples the simulator's WebContent processes (their RSS) every 250 ms
// until killed, one JSON line per sample: {t, total, procs: {pid: kb}}.
// Only processes under a simulator runtime count (not the Mac's Safari).
import { execFileSync } from "node:child_process";

const tick = () => {
  const out = execFileSync("ps", ["-A", "-o", "pid=,rss=,command="], { encoding: "utf8" });
  const procs = {};
  let total = 0;
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || !m[3].includes("com.apple.WebKit.WebContent") || !m[3].includes("CoreSimulator")) continue;
    procs[m[1]] = Number(m[2]);
    total += Number(m[2]);
  }
  process.stdout.write(JSON.stringify({ t: Date.now(), total, procs }) + "\n");
};
tick();
setInterval(tick, 250);
