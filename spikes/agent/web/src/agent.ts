// Harness setup shared by the steps: models (faux, the mock server, real
// Anthropic), storage over the bridge, the project env and the tools.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type HarnessSettings,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { ProjectEnv } from "./env";
import { BridgeSqlite } from "./sqlite";

export const ctx = BACKGROUND_CONTEXT;

/** What the page puts in the key slot; the host replaces it (proxy.ts). */
const PLACEHOLDER_KEY = "host-injected";

export function mockProvider(baseUrl: string) {
  return createProvider({
    id: "mock",
    name: "Mock",
    baseUrl,
    auth: { apiKey: { name: "Host credential", resolve: async () => ({ auth: { apiKey: PLACEHOLDER_KEY }, source: "host" }) } },
    models: [
      {
        id: "mock-1",
        name: "Mock 1",
        api: "anthropic-messages",
        provider: "mock",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
    api: anthropicMessagesApi() as ProviderStreams,
  });
}

export function createSpikeModels(mockUrl: string): MutableModels {
  const models = createModels({
    // Real providers find "their" key here; the proxy swaps it for the Keychain's.
    authContext: {
      env: async (name: string) => (name === "ANTHROPIC_API_KEY" ? PLACEHOLDER_KEY : undefined),
      fileExists: async () => false,
    },
  });
  if (mockUrl) models.setProvider(mockProvider(mockUrl));
  models.setProvider(anthropicProvider());
  return models;
}

/** Started/finished signals of the sleep tool, for the resume step. */
export const sleepSignals = { started: () => {} };

/** Not replay-safe: a restart turns a running call into an "interrupted" result. */
const sleepTool = defineTool({
  name: "sleep",
  description: "Wait for the given number of milliseconds.",
  parameters: Type.Object({ ms: Type.Number() }),
  execute: async (args, _api, context) => {
    sleepSignals.started();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, args.ms);
      context.abortSignal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
    return { output: [{ type: "text", text: `slept ${args.ms} ms` }] };
  },
});

const noopTool = defineTool({
  name: "noop",
  description: "Does nothing.",
  parameters: Type.Object({ n: Type.Number() }),
  execute: async (args) => ({ output: [{ type: "text", text: `noop ${args.n}` }] }),
});

export const ProjectTools = defineExtension({
  name: "project-tools",
  tools: [createReadTool(), createWriteTool(), createEditTool(), sleepTool, noopTool],
});

export async function openStorage(name: string | null, fresh: boolean): Promise<{ storage: Storage; database?: BridgeSqlite; rolledBack?: boolean }> {
  if (name === null) return { storage: new MemoryStorage() };
  if (fresh) await BridgeSqlite.delete(name);
  const { database, rolledBack } = await BridgeSqlite.open(name);
  return { storage: await SqliteStorage.open(database), database, rolledBack };
}

export async function openHarness(storage: Storage, models: MutableModels, settings: HarnessSettings = {}) {
  const registry = createRegistry();
  registry.install(ProjectTools);
  return Harness.open(
    storage,
    {
      models,
      registry,
      env: () => new ProjectEnv(),
      settings: { retry: { maxRetries: 3, baseDelayMs: 200 }, ...settings },
      onReport: (report: unknown) => console.warn("harness report", report),
    },
    ctx,
  );
}
