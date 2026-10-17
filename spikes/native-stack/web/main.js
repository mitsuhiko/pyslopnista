// Q14: where does recursion through C code overflow the worker's native
// stack, measured in CPython's own currency (bytes of the linear stack)? And
// does a smaller stack protection (PyUnstable_ThreadState_SetStackProtection)
// turn those crashes into RecursionError without breaking normal programs?
//
// Steps (the URL fragment): cases=<regex>&modes=sync,async&limits=0,49152
// &n=<depth>&python=3.14&warm=1&repeat=1&wasm=1
const post = (op, value) => window.webkit?.messageHandlers?.bridge?.postMessage({ op, value });
const log = (text) => {
  document.getElementById("out").textContent += text + "\n";
  post("log", text);
};

const nested = (open, close) => `${open}*N + ${close}*N`;

// Recursion through C code that crashed the worker in spikes/device-perf, and
// more of the same kind. N is the depth.
export const CRASHERS = {
  repr_list: "x = []\nfor _ in range(N): x = [x]\nlen(repr(x))",
  json_loads: `import json\njson.loads(${nested("'['", "']'")})`,
  json_dumps: "import json\nx = []\nfor _ in range(N): x = [x]\nlen(json.dumps(x))",
  pickle_dumps: "import pickle\nx = []\nfor _ in range(N): x = [x]\nlen(pickle.dumps(x))",
  deepcopy: "import copy\nx = []\nfor _ in range(N): x = [x]\ncopy.deepcopy(x) is not None",
  eq_nested: "a = []; b = []\nfor _ in range(N): a = [a]; b = [b]\na == b",
  hash_tuple: "x = ()\nfor _ in range(N): x = (x,)\nhash(x)",
  py_repr: "class A:\n    def __init__(s, c): s.c = c\n    def __repr__(s): return 'A(%r)' % (s.c,)\nx = None\nfor _ in range(N): x = A(x)\nlen(repr(x))",
  py_str_fstring: "class A:\n    def __init__(s, c): s.c = c\n    def __str__(s): return f'<{s.c}>'\nx = 0\nfor _ in range(N): x = A(x)\nlen(str(x))",
  map_rec: "import sys\nsys.setrecursionlimit(10**6)\ndef f(n): return 0 if n == 0 else list(map(f, [n - 1]))[0] + 1\nf(N)",
  sorted_key: "import sys\nsys.setrecursionlimit(10**6)\ndef f(n): return 0 if n == 0 else sorted([n], key=lambda v: f(v - 1))[0]\nf(N)",
  lru_cache: "import functools, sys\nsys.setrecursionlimit(10**6)\n@functools.lru_cache(None)\ndef f(n): return 0 if n == 0 else f(n - 1) + 1\nf(N)",
  init_rec: "import sys\nsys.setrecursionlimit(10**6)\nclass A:\n    def __init__(s, n): s.c = A(n - 1) if n else None\nA(N) is not None",
  getattr_rec: "import sys\nsys.setrecursionlimit(10**6)\nclass A:\n    def __getattr__(s, name):\n        n = int(name[1:])\n        return 0 if n == 0 else getattr(s, f'a{n - 1}') + 1\ngetattr(A(), f'a{N}')",
  property_rec: "import sys\nsys.setrecursionlimit(10**6)\nclass A:\n    def __init__(s, n): s.n = n; s.c = A(n - 1) if n else None\n    @property\n    def depth(s): return 0 if s.c is None else s.c.depth + 1\nimport sys\nx = None\nfor i in range(N): y = A.__new__(A); y.n = i; y.c = x; x = y\nx.depth",
  yield_from: "import sys\nsys.setrecursionlimit(10**6)\ndef g(n):\n    if n: yield from g(n - 1)\n    else: yield 1\nnext(g(N))",
  py_recursion: "import sys\nsys.setrecursionlimit(10**6)\ndef f(n): return 0 if n == 0 else f(n - 1) + 1\nf(N)",
  dataclass_eq: "import dataclasses\n@dataclasses.dataclass\nclass N_:\n    c: object\na = None; b = None\nfor _ in range(N): a = N_(a); b = N_(b)\na == b",
  ast_parse: "import ast\nast.parse('x = ' + '-' * N + '1') is not None",
  re_compile: "import re\nre.compile('(' * N + 'a' + ')' * N) is not None",
  isinstance_nested: "t = int\nfor _ in range(N): t = (t,)\nisinstance(1, t)",
};

// Normal programs that use a lot of stack: they must keep working.
export const NORMAL = {
  import_numpy_pandas: { code: "import numpy, pandas\nint(pandas.DataFrame({'a': numpy.arange(10)}).a.sum())", packages: ["numpy", "pandas"] },
  matplotlib_plot: { code: "import matplotlib\nmatplotlib.use('agg')\nimport matplotlib.pyplot as plt, io\nplt.plot([1, 2, 3]); b = io.BytesIO(); plt.savefig(b, format='png'); len(b.getvalue()) > 1000", packages: ["matplotlib"] },
  python_recursion_900: { code: "def f(n): return 0 if n == 0 else f(n - 1) + 1\nf(900)" },
  py_repr_100: { code: CRASHERS.py_repr.replace("range(N)", "range(100)") },
  json_200: { code: CRASHERS.json_loads.replaceAll("N", "200") },
  repr_100: { code: CRASHERS.repr_list.replace("range(N)", "range(100)") },
  map_rec_100: { code: CRASHERS.map_rec.replace("f(N)", "f(100)") },
  lru_cache_300: { code: CRASHERS.lru_cache.replace("f(N)", "f(300)") },
  stdlib_imports: { code: "import asyncio, email.mime.multipart, http.client, xml.etree.ElementTree as ET, sqlite3, decimal, unittest, argparse, dataclasses, typing, json, csv, statistics, fractions, difflib, textwrap, pprint\nET.fromstring('<a>' * 50 + '</a>' * 50) is not None" },
  sqlite_query: { code: "import sqlite3\nc = sqlite3.connect(':memory:')\nc.execute('create table t(x)')\nc.executemany('insert into t values (?)', [(i,) for i in range(1000)])\nc.execute('with recursive r(n) as (select 1 union all select n + 1 from r where n < 500) select count(*) from r').fetchone()[0]" },
  pprint_nested: { code: "import pprint\nx = []\nfor _ in range(60): x = [x, {'k': x and 1}]\nlen(pprint.pformat(x))" },
};

// A warm-up that isn't any one case: calls through C code of the usual kinds,
// so JSC compiles CPython's hot functions with its optimizing tier (smaller
// native frames than the baseline tier's).
export const GENERIC_WARMUP = `
import functools, json, dataclasses
def _warm():
    class A:
        def __init__(s, c): s.c = c
        def __repr__(s): return 'A(%r)' % (s.c,)
        def __str__(s): return f'<{s.c}>'
        def __getattr__(s, n): return 0
        @property
        def p(s): return 1
    @functools.lru_cache(None)
    def f(n): return 0 if n == 0 else f(n - 1) + 1
    def g(n): return 0 if n == 0 else list(map(g, [n - 1]))[0] + 1
    def h(n): return 0 if n == 0 else sorted([n], key=lambda v: h(v - 1))[0]
    def gen(n):
        if n: yield from gen(n - 1)
        else: yield 1
    @dataclasses.dataclass
    class D:
        c: object
    for _ in range(300):
        x = None
        for _ in range(20): x = A(x)
        repr(x); str(x); x.zzz; x.p
        f.cache_clear(); f(20); g(20); h(20); next(gen(20))
        y = []
        for _ in range(20): y = [y]
        repr(y); json.loads(json.dumps(y)); y == [y]
        t = ()
        for _ in range(20): t = (t,)
        hash(t)
        a = None; b = None
        for _ in range(10): a = D(a); b = D(b)
        a == b
_warm()
del _warm
`;

const warmFor = (mode, code) =>
  mode === "generic" ? { reps: 1, code: GENERIC_WARMUP } : mode === "1" ? { reps: 200, code: code.replaceAll(/\bN\b/g, "20") } : null;

function runCase(msg, timeout = 30000) {
  return new Promise((resolve) => {
    const worker = new Worker("worker.js", { type: "module" });
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ case: msg.name, mode: msg.mode, limit: msg.limit, outcome: "timeout" }), timeout);
    worker.onerror = (e) => {
      e.preventDefault?.();
      // An error escaping the worker after the result is irrelevant; before
      // it, the worker died (no result posted).
      setTimeout(() => finish({ case: msg.name, mode: msg.mode, limit: msg.limit, outcome: "worker-error", error: String(e.message) }), 2000);
    };
    worker.onmessage = ({ data }) => finish(data);
    worker.postMessage(msg);
  });
}

async function main() {
  const p = new URLSearchParams(location.hash.slice(1));
  const python = p.get("python") ?? "3.14";
  const modes = (p.get("modes") ?? "sync,async").split(",");
  const limits = (p.get("limits") ?? "0").split(",").map(Number);
  const n = Number(p.get("n") ?? 100000);
  const pick = new RegExp(p.get("cases") ?? ".");
  const kinds = (p.get("kinds") ?? "crash").split(",");
  const repeat = Number(p.get("repeat") ?? 1);
  const warm = p.get("warm") && p.get("warm") !== "0" ? p.get("warm") : null;
  const results = { python, n, ua: navigator.userAgent, cores: navigator.hardwareConcurrency, at: new Date().toISOString(), cases: [] };

  if (p.get("wasm") === "1") {
    const r = await runCase({ name: "wasm_depth", wasmDepth: true });
    log(JSON.stringify(r));
    results.wasmDepth = r;
  }
  // find=1: the deepest N that doesn't crash, per case (a fresh worker per try).
  if (p.get("find") === "1") {
    for (const mode of modes) {
      for (const limit of limits) {
        for (const [name, code] of Object.entries(CRASHERS)) {
          if (!pick.test(name)) continue;
          let lo = 1;
          let hi = n;
          let last = null;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const msg = { name, mode, limit, python, code: code.replaceAll(/\bN\b/g, String(mid)) };
            if (warm) msg.warm = warmFor(warm, code);
            const r = await runCase(msg);
            if (r.outcome === "failed") throw new Error(`${name}: ${r.error}`);
            if (r.outcome === "crash" || r.outcome === "timeout" || r.outcome === "worker-error") hi = mid - 1;
            else {
              lo = mid;
              last = r;
            }
          }
          const r = { case: name, mode, limit, warm, maxDepth: lo, outcome: last?.outcome, error: last?.error, highWater: last?.highWater, warmMs: last?.warmMs };
          log(JSON.stringify(r));
          results.cases.push(r);
        }
      }
    }
    post("result", JSON.stringify(results));
    log("done");
    return;
  }
  for (let rep = 0; rep < repeat; rep++) {
    for (const limit of limits) {
      for (const mode of modes) {
        if (kinds.includes("crash")) {
          for (const [name, code] of Object.entries(CRASHERS)) {
            if (!pick.test(name)) continue;
            const msg = { name, mode, limit, python, code: code.replaceAll(/\bN\b/g, String(n)) };
            if (warm) msg.warm = warmFor(warm, code);
            const r = await runCase(msg);
            log(JSON.stringify(r));
            results.cases.push(r);
          }
        }
        if (kinds.includes("normal")) {
          for (const [name, c] of Object.entries(NORMAL)) {
            if (!pick.test(name)) continue;
            const setup = c.packages ? `import pyodide_js\nawait pyodide_js.loadPackage(${JSON.stringify(c.packages)})` : null;
            const r = await runCase({ name, mode: setup ? "async" : mode, limit, python, code: c.code, setup });
            log(JSON.stringify(r));
            results.cases.push(r);
          }
        }
      }
    }
  }
  post("result", JSON.stringify(results));
  log("done");
}

main().catch((e) => {
  log(`failed: ${e.stack ?? e}`);
  post("result", JSON.stringify({ failed: String(e.stack ?? e) }));
});
