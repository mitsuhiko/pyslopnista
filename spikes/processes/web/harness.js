// Runs the test programs (tests/*.py) through a Manager and collects their
// RESULT lines, timings and per-process events. Shared by node/run.mjs and
// the iOS page (main.js).

export const TESTS = ["t_basic", "t_ipc", "t_sync", "t_pool", "t_subprocess", "t_guard", "t_numpy", "t_stop", "t_memory", "t_perf"];

const OPTIONS = {
  // Stop (SIGINT to the tree, SIGKILL after 1.5 s) while everything blocks.
  t_stop: { stopOnOutput: "all started", timeoutMs: 60000 },
  t_perf: { timeoutMs: 600000 },
};

/** memory(): bytes in use right now, or null (sampled from outside, by time). */
export async function runTests(manager, { only = null, log = () => {}, memory = () => null } = {}) {
  const wanted = only ? only.split(",") : TESTS;
  const out = { tests: {}, failures: [] };
  const t0 = performance.now();
  await manager.ready();
  out.warmPoolMs = Math.round(performance.now() - t0);
  for (const name of wanted) {
    log(`running ${name}`);
    const first = manager.events.length;
    const startedAt = Date.now();
    let peak = memory();
    const sampler = setInterval(() => (peak = Math.max(peak ?? 0, memory() ?? 0) || null), 200);
    const r = await manager.run(`/home/pyodide/project/${name}.py`, OPTIONS[name] ?? {});
    clearInterval(sampler);
    const stdout = r.output.filter((o) => o.stream === "stdout").map((o) => o.text).join("");
    const resultLine = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
    const parsed = resultLine ? JSON.parse(resultLine.slice(7)) : null;
    const events = manager.events.slice(first);
    const test = {
      exitCode: r.exitCode,
      ms: r.ms,
      startedAt,
      endedAt: Date.now(),
      peakMemoryMB: peak == null ? null : Math.round(peak / 1048576),
      processes: r.pids,
      passed: parsed ? Object.values(parsed.checks).filter((c) => c.ok).length : 0,
      failed: parsed ? Object.fromEntries(Object.entries(parsed.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.detail ?? null])) : null,
      metrics: parsed?.metrics ?? {},
      starts: summarizeStarts(events),
    };
    let failed = parsed ? Object.entries(parsed.checks).filter(([, c]) => !c.ok).map(([k]) => k) : ["(no RESULT line)"];
    if (name === "t_stop") {
      // No RESULT line: the run is stopped. Every process must end, from
      // SIGINT (KeyboardInterrupt) rather than the SIGKILL fallback.
      test.stop = { ...stopSummary(events, r.pids), stopToEndMs: r.stopToEndMs };
      failed = [];
      if (!test.stop.allEnded) failed.push("stop: processes left running");
      if (test.stop.byStatus["signal 9"]) failed.push("stop: needed SIGKILL");
    }
    if (failed.length) {
      out.failures.push(`${name}: ${failed.join(", ")}`);
      test.output = r.output.map((o) => `[${o.pid} ${o.stream}] ${o.text}`).join("").slice(-40000);
    }
    out.tests[name] = test;
    log(`${name}: ${failed.length ? "FAILED " + failed.join(", ") : "ok"} (${r.ms} ms, ${r.pids} processes)`);
  }
  out.bootMs = summarize(manager.bootTimes);
  out.preloadMs = summarize(manager.preloadTimes);
  return out;
}

function summarize(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pick = (q) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
  return { n: s.length, min: Math.round(s[0]), median: pick(0.5), p90: pick(0.9), max: Math.round(s[s.length - 1]) };
}

function summarizeStarts(events) {
  const children = events.filter((e) => e.kind !== "main" && e.startMs != null);
  return {
    warm: summarize(children.filter((e) => e.warm).map((e) => e.startMs)),
    cold: summarize(children.filter((e) => !e.warm).map((e) => e.startMs)),
    setup: summarize(children.map((e) => e.setupMs)),
    install: summarize(children.map((e) => e.installMs)),
    packages: summarize(children.map((e) => e.packagesMs)),
  };
}

function stopSummary(events, pids) {
  const byStatus = {};
  for (const e of events) {
    const s = e.status & 0x7f ? `signal ${e.status & 0x7f}` : `exit ${(e.status >> 8) & 0xff}`;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return { processes: pids, byStatus, allEnded: events.length === pids };
}
