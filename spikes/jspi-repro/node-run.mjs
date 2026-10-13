// Baseline: run every test under Node (V8), each with a timeout.
import { runTest, tests } from "./web/tests.js";

for (const name of Object.keys(tests)) {
  const result = await Promise.race([
    runTest(name),
    new Promise((r) => setTimeout(() => r({ name, ok: false, value: "TIMEOUT" }), 3000)),
  ]);
  console.log(`${result.ok ? "PASS" : "FAIL"} ${name.padEnd(26)} ${result.value} ${result.ms ?? ""}ms`);
}
process.exit(0);
