import { bridge } from "./runtime.js";

// Scripted checks for the pyodide-worker spike. Each step runs in a fresh
// worker taken from the pool, like a real "Run" would.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function selftest({ pool, runCode, append, stop, only }) {
  const r = {};
  let captured = "";
  const onOutput = (stream, text) => {
    captured += text;
    append(stream, text);
    if (stream !== "stdout") log(`[${stream}] ${text}`);
  };
  const log = (msg) => bridge("log", msg);

  async function step(name, code, opts = {}) {
    if (only && !only.some((o) => name === o || name.startsWith(`${o}_`))) return;
    captured = "";
    append("system", `\n--- ${name} ---\n`);
    const t0 = performance.now();
    try {
      const result = await runCode(code, { ...opts, onOutput, onStart: opts.after });
      r[name] = {
        ok: result.ok,
        wallMs: Math.round(performance.now() - t0),
        runMs: Math.round(result.ms),
        loadMs: result.loadMs === undefined ? undefined : Math.round(result.loadMs),
        output: captured.trim().slice(-800),
        error: result.error?.trim().split("\n").slice(-1)[0],
        killed: result.killed,
      };
    } catch (e) {
      r[name] = { ok: false, error: String(e) };
    }
    await log(`${name}: ${JSON.stringify(r[name])}`);
  }

  r.boot = await pool.spare.ready;

  await step("hello", `import sys, platform\nprint(sys.version)\nprint(platform.platform())`);
  await step("jspi_state", [
    "import time, js",
    "from pyodide.ffi import can_run_sync",
    "print('time.sleep', time.sleep)",
    "print('can_run_sync', can_run_sync())",
    "print('Suspending in WebAssembly', hasattr(js.WebAssembly, 'Suspending'))",
  ].join("\n"));

  await step("stdin", `name = input("name? ")\nage = input("age? ")\nprint("hello", name, age)`, {
    onInput: async () => { await sleep(50); return "spike\n"; },
  });

  let stopAt = 0;
  await step("interrupt_busy_loop", `while True:\n    pass`, {
    after: () => setTimeout(() => { stopAt = performance.now(); stop(); }, 300),
  });
  if (r.interrupt_busy_loop) r.interrupt_busy_loop.stopToDoneMs = Math.round(performance.now() - stopAt);

  await step("interrupt_during_input", `input("waiting forever? ")`, {
    onInput: () => new Promise(() => {}),
    after: () => setTimeout(stop, 300),
  });

  await step("await_asyncio_sleep", `import asyncio, time\nt = time.perf_counter()\nawait asyncio.sleep(0.2)\nprint(round(time.perf_counter() - t, 3))`);
  await step("run_sync_js_timer", [
    "from pyodide.ffi import run_sync, create_once_callable",
    "from js import Promise, setTimeout",
    "import time",
    "t = time.perf_counter()",
    "run_sync(Promise.new(create_once_callable(lambda resolve, reject: setTimeout(resolve, 200))))",
    "print(round(time.perf_counter() - t, 3))",
  ].join("\n"));
  await step("run_sync_asyncio_sleep", `import asyncio, time\nfrom pyodide.ffi import run_sync\nt = time.perf_counter()\nrun_sync(asyncio.sleep(0.2))\nprint(round(time.perf_counter() - t, 3))`);
  await step("hard_kill", `import time\nwhile True:\n    try:\n        time.sleep(10)\n    except KeyboardInterrupt:\n        pass`, {
    after: () => setTimeout(stop, 300),
  });
  await step("sleep", `import time\nt = time.perf_counter()\ntime.sleep(0.5)\nprint(round(time.perf_counter() - t, 3))`);
  await step("interrupt_during_sleep", `import time\ntime.sleep(60)`, { after: () => setTimeout(stop, 300) });

  await step("jspi_run_sync", [
    "from pyodide.ffi import run_sync, can_run_sync",
    "import host",
    "print('can_run_sync', can_run_sync())",
    "print(run_sync(host.call('echo', 'via run_sync')))",
  ].join("\n"));

  await step("top_level_await", `import host\nprint(await host.call("echo", "via await"))`);

  await step("bridge_latency", [
    "import time, host",
    "N = 500",
    "t = time.perf_counter()",
    "for i in range(N): assert host.call_sync('echo', i) == i",
    "print('atomics call_sync ms', round((time.perf_counter() - t) / N * 1000, 3))",
  ].join("\n"));

  await step("numpy_first", `import numpy as np\nprint(np.__version__, np.arange(10).sum())`);
  await step("numpy_second", `import numpy as np\nprint(np.__version__, np.arange(10).sum())`);

  await step("micropip_pypi", [
    "import micropip, time",
    "t = time.perf_counter()",
    "await micropip.install(['cowsay', 'humanize'])",
    "print('install s', round(time.perf_counter() - t, 2))",
    "import cowsay, humanize",
    "print(cowsay.get_output_string('cow', 'hi').splitlines()[1])",
    "print(humanize.naturalsize(123456789))",
  ].join("\n"));

  await step("matplotlib", [
    "import matplotlib",
    "matplotlib.use('agg')",
    "import matplotlib.pyplot as plt, io",
    "plt.plot([1, 2, 3], [1, 4, 9])",
    "buf = io.BytesIO()",
    "plt.savefig(buf, format='png')",
    "print('png bytes', len(buf.getvalue()))",
  ].join("\n"));

  await step("bench_pure_python", [
    "import time",
    "def fib(n): return n if n < 2 else fib(n - 1) + fib(n - 2)",
    "import json, re",
    "t = time.perf_counter(); fib(30); a = time.perf_counter() - t",
    "t = time.perf_counter(); s = sum(i * i for i in range(10_000_000)); b = time.perf_counter() - t",
    "t = time.perf_counter(); d = {str(i): i for i in range(2_000_000)}; c = time.perf_counter() - t",
    "t = time.perf_counter(); blob = json.dumps([{'a': i, 'b': str(i)} for i in range(300_000)]); json.loads(blob); e = time.perf_counter() - t",
    "t = time.perf_counter(); n = len(re.findall(r'\\w+@\\w+\\.com', ' foo@bar.com x' * 200_000)); f = time.perf_counter() - t",
    "print(f'fib30 {a:.3f}  sumsq10M {b:.3f}  dict2M {c:.3f}  json300k {e:.3f}  regex {f:.3f}')",
  ].join("\n"));

  // Hammers C function-pointer calls (they all go through CPython's call
  // trampoline) for 8 s so hot functions reach WebKit's optimizing tiers
  // (WebKit bug 293113 only showed in hot code on devices).
  await step("trampoline_stress", [
    "import time, json, re, functools, operator",
    "t0 = time.perf_counter(); rounds = 0; acc = 0",
    "while time.perf_counter() - t0 < 8:",
    "    d = {}",
    "    for i in range(20000):",
    "        s = str(i); d[s] = len(s); d.get(s); [].append(i); abs(-i); max(i, 3); isinstance(i, int)",
    "    acc += sum(sorted(d.values(), key=abs)[:10])",
    "    acc += len(json.dumps(list(d.items())[:200]))",
    "    acc += len(re.findall(r'[0-9]+', ' '.join(d)))",
    "    acc += functools.reduce(operator.add, range(1000))",
    "    rounds += 1",
    "print('rounds', rounds, 'acc', acc)",
  ].join("\n"));

  // Device probes (not part of the default run; select them explicitly).
  if (only) {
    await step("recursion_depth", [
      "import sys",
      "def f(n): return 0 if n == 0 else f(n - 1) + 1",
      "print('default limit', sys.getrecursionlimit())",
      "res = {}",
      "for depth in (500, 1000, 2000, 4000, 8000, 16000, 32000):",
      "    sys.setrecursionlimit(depth + 200)",
      "    try:",
      "        f(depth); res[depth] = 'ok'",
      "    except RecursionError:",
      "        res[depth] = 'RecursionError'",
      "    except BaseException as e:",
      "        res[depth] = f'{type(e).__name__}: {str(e)[:60]}'",
      "print(res)",
    ].join("\n"));
    // One step (= one fresh worker) per case, since a native stack overflow
    // kills the interpreter. Select with "crec".
    const crecCases = {
      json: (n) => `import json\njson.loads('[' * ${n} + ']' * ${n})`,
      repr: (n) => `x = []\nfor _ in range(${n}): x = [x]\nrepr(x)`,
      deepcopy: (n) => `import copy\nx = []\nfor _ in range(${n}): x = [x]\ncopy.deepcopy(x)`,
      map: (n) => `import sys\nsys.setrecursionlimit(100000)\ndef f(n): return 0 if n == 0 else sum(map(f, [n - 1])) + 1\nf(${n})`,
    };
    for (const [name, code] of Object.entries(crecCases)) {
      for (const n of [100, 250, 500, 1000, 2000, 5000]) {
        await step(`crec_${name}_${n}`, `${code(n)}\nprint('ok')`);
        if (r[`crec_${name}_${n}`] && !r[`crec_${name}_${n}`].ok) break;
      }
    }
    await step("fatal_stack_overflow", "import json\njson.loads('[' * 5000 + ']' * 5000)\nprint('survived')");
    await step("after_fatal", "print('next run works')");
    await step("memory_ceiling", [
      "import host",
      "chunks = []; mb = 0",
      "try:",
      "    while True:",
      "        chunks.append(bytearray(64 * 1024 * 1024)); mb += 64",
      "        host.call_sync('log', f'memory_ceiling: {mb} MB')",
      "except MemoryError:",
      "    print('MemoryError after', mb, 'MB')",
    ].join("\n"));
    await step("background_ticks", [
      "import time, host",
      "t0 = time.monotonic(); last = t0; gaps = []",
      "for i in range(int(host.call_sync('echo', 75))):",
      "    time.sleep(1)",
      "    now = time.monotonic(); gaps.append(round(now - last, 2)); last = now",
      "    host.call_sync('log', f'tick {i} t={now - t0:.1f} gap={gaps[-1]}')",
      "print('max gap', max(gaps), 'total', round(last - t0, 1), 'big gaps', [g for g in gaps if g > 1.5])",
    ].join("\n"));
  }

  await step("memory_1gb", `x = bytearray(1024 * 1024 * 1024)\nprint(len(x) // 2**20, "MB")`);

  const t0 = performance.now();
  await pool.take();
  r.pool_take_after_runs_ms = Math.round(performance.now() - t0);

  return r;
}

