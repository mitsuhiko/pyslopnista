// node count.mjs file...: how many XHRs were slow (>100 ms), per case kind.
import fs from "node:fs";
for (const file of process.argv.slice(2)) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const slow = {}; let total = 0, nslow = 0;
  const add = (kind, x) => { if (!x) return; total++; if (x.ms > 100) { nslow++; (slow[kind] ??= []).push(Math.round(x.ms)); } };
  for (const c of j.cases) {
    const kind = `${c.kind}:${JSON.stringify(c.arg)}`;
    add(kind + ":warm", c.warm);
    if (c.rounds) for (const r of c.rounds) { add(kind + ":r", r.first); add(kind + ":r2", r.second); }
    else { add(kind, c.first); add(kind + ":2nd", c.second); add(kind + ":after", c.after); }
    if (c.blockedMs > (typeof c.arg === "number" ? c.arg + 150 : 1e9)) (slow[kind + ":blocked"] ??= []).push(c.blockedMs);
  }
  console.log(`${file}: ${nslow}/${total} slow`, JSON.stringify(slow));
}
