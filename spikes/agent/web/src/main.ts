// Step runner. Steps come from the URL hash ("all" or "boot,storage,…"). The
// runner's state lives in the host (kv.*) so a step can reload the page and
// carry on in a later phase.
import { call, type Config, log } from "./bridge";
import { installProxyFetch } from "./proxy";
import { DEFAULT_STEPS, type Result, STEPS } from "./steps";

interface RunnerState {
  steps: string[];
  index: number;
  results: Record<string, Result>;
  phases: Record<string, number>;
}

const config = await call<Config>("config");
installProxyFetch(config.token);

const saved = await call<string | null>("kv.get", { key: "runner" });
const hash = decodeURIComponent(location.hash.slice(1));
const state: RunnerState = saved
  ? JSON.parse(saved)
  : { steps: !hash || hash === "all" ? DEFAULT_STEPS : hash.split(","), index: 0, results: {}, phases: {} };
const save = () => call("kv.set", { key: "runner", value: JSON.stringify(state) });

log(`page load ${config.loads}, steps ${state.steps.join(",")}, at ${state.index}`);
while (state.index < state.steps.length) {
  const name = state.steps[state.index];
  const step = STEPS[name];
  const phase = state.phases[name] ?? 0;
  log(`▶ ${name}${phase ? ` (phase ${phase})` : ""}`);
  let result: Result;
  try {
    if (!step) throw new Error(`unknown step ${name}`);
    result = await step({
      config,
      phase,
      reloadAt: async (next) => {
        state.phases[name] = next;
        await save();
        await call("reload");
        return new Promise<never>(() => {});
      },
    });
  } catch (e) {
    result = { ok: false, error: String((e as Error)?.stack ?? e).slice(0, 1500) };
  }
  log(`${result.ok ? "✓" : "✗"} ${name}`, result);
  state.results[name] = result;
  state.index++;
  await save();
}

const ok = Object.values(state.results).every((r) => r.ok);
await call("result", { value: JSON.stringify({ ok, pageLoads: config.loads, steps: state.results }, null, 2) });
log(ok ? "all passed" : "FAILED");
