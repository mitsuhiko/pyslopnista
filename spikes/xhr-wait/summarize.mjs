// node summarize.mjs result.json: one line per case.
import fs from "node:fs";
const j = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (j.error) { console.log(j.error); process.exit(1); }
console.log(j.visibility, j.userAgent.slice(0, 60));
const f = (x) => (x ? `${x.ms}ms(to ${x.toHost}, back ${x.back})` : "-");
for (const c of j.cases) {
  if (c.rounds) console.log(`${c.kind} ${JSON.stringify(c.arg)}: ` + c.rounds.map((r) => `[${r.wait}] ${f(r.first)} ${f(r.second)}`).join("  "));
  else console.log(`${c.kind} ${c.arg}: warm ${f(c.warm)} blocked ${c.blockedMs} first ${f(c.first)} second ${f(c.second)}${c.fetch ? ` fetch ${c.fetch.ms}ms after ${f(c.after)}` : ""}`);
}
