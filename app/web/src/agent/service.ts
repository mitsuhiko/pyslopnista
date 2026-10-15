// The coding agent in the engine page (D34): a pi-durable Harness on native
// SQLite (D32), one conversation per project folder, models from pi-ai with
// credentials in the Keychain (D33). The host drives it through the engine's
// `agent` command and gets a compact transcript (`agent.state`) to draw
// natively. Everything is committed before it is shown, so a crash or a
// reload of the engine page resumes the turn where it was.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import type { AuthType, Model, MutableModels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import {
  type Conversation,
  type ConversationId,
  type ConversationView,
  createRegistry,
  Harness,
  type Submission,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { call } from "../host";
import { KeychainCredentialStore } from "./credentials";
import { ProjectEnv } from "./env";
import { cancelLogin, login } from "./login";
import { Prompt } from "./prompt";
import { installProxyFetch } from "./proxy";
import { BridgeSqlite } from "./sqlite";
import { ProjectTools } from "./tools";

const ctx = BACKGROUND_CONTEXT;
type ModelRef = { provider: string; modelId: string };

/** Where the user is when they send a message (from the host). Paths are app paths. */
export interface EditorContext {
  file?: string | null;
  line?: number | null;
  selection?: { text: string; fromLine: number; toLine: number } | null;
  /** The end of the console output when the open file's last run failed. */
  error?: string | null;
}

/** Our user entries: the model sees the message with the editor context, the app shows the text and the file. */
const USER_ENTRY = "pyslopnista.user";

/** A project path for an app path ("Examples/Hello.py" in project "Examples" -> "Hello.py"). */
function projectPath(project: string, path: string): string | null {
  if (!project) return path;
  return path.startsWith(project + "/") ? path.slice(project.length + 1) : null;
}

function contextBlock(project: string, context: EditorContext | undefined): { block: string; file: string | null; line: number | null } {
  if (!context?.file) return { block: "", file: null, line: null };
  const rel = projectPath(project, context.file);
  const name = rel ?? `${context.file} (outside the project)`;
  const lines = [`The user has ${name} open in the editor${context.line ? `, cursor on line ${context.line}` : ""}.`];
  if (context.selection?.text) {
    const { fromLine, toLine, text } = context.selection;
    lines.push(`They selected ${fromLine === toLine ? `line ${fromLine}` : `lines ${fromLine}-${toLine}`}:\n\`\`\`\n${text}\n\`\`\``);
  }
  if (context.error) lines.push(`The last run of this file failed:\n\`\`\`\n${context.error}\n\`\`\``);
  return { block: `<editor>\n${lines.join("\n")}\n</editor>\n\n`, file: rel ?? context.file, line: context.line ?? null };
}

/** Radius (pi's gateway) comes first: in the account list and as the default model. */
const FEATURED_PROVIDER = "radius";
/** Defaults within a provider; the user picks in the app. */
const PREFERRED = [/sonnet/, /haiku/, /gpt-5[.\d]*-codex/, /gpt-5/, /gemini-[\d.]+-pro/, /flash/];
/** Providers whose model list comes from the server (refreshed at start and after sign-in). */
const DYNAMIC_CATALOGS = ["radius", "github-copilot", "openrouter"];

// -- the transcript the app draws ---------------------------------------------------

export interface Item {
  id: string;
  kind: "user" | "assistant" | "tool" | "error" | "note";
  text: string;
  thinking?: string;
  streaming?: boolean;
  tool?: string;
  summary?: string;
  status?: "pending" | "running" | "done" | "error";
  output?: string;
  diff?: string;
  path?: string;
  line?: number;
  images?: number;
}

const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
      : "";

function summarize(name: string, args: any): { summary: string; path?: string } {
  const path = typeof args?.path === "string" ? args.path.replace(/^\/+/, "") : undefined;
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "ls":
      return { summary: path ?? "/", path: name === "ls" ? undefined : path };
    case "find":
      return { summary: args?.pattern ?? "all files" };
    case "grep":
      return { summary: `${args?.pattern ?? ""}${args?.glob ? `  in ${args.glob}` : ""}` };
    case "run_python": {
      if (path) return { summary: path, path };
      const first = String(args?.code ?? "").split("\n").find((l: string) => l.trim() && !l.trim().startsWith("#")) ?? "";
      return { summary: first.trim().slice(0, 80) };
    }
    case "check":
    case "format":
      return { summary: Array.isArray(args?.paths) && args.paths.length ? args.paths.join(", ") : "all Python files" };
    default:
      return { summary: JSON.stringify(args ?? {}).slice(0, 80) };
  }
}

function buildItems(view: ConversationView): { items: Item[]; busy: boolean; status: string | null } {
  const items: Item[] = [];
  const tools = new Map<string, Item>();
  const addAssistant = (id: string, message: any, streaming: boolean) => {
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const thinking = content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join("");
    if (text || thinking || streaming) items.push({ id, kind: "assistant", text, thinking: thinking || undefined, streaming: streaming || undefined });
    for (const c of content) {
      if (c.type !== "toolCall") continue;
      const { summary, path } = summarize(c.name, c.arguments);
      const item: Item = { id: c.id, kind: "tool", text: "", tool: c.name, summary, path, status: "pending" };
      tools.set(c.id, item);
      items.push(item);
    }
    if ((message?.stopReason === "error" || message?.stopReason === "aborted") && !streaming) {
      items.push({ id: `${id}:error`, kind: "error", text: message.stopReason === "aborted" ? "Stopped." : (message.errorMessage ?? "The model failed.") });
    }
  };
  for (const entry of view.entries) {
    const m: any = entry.model?.[0];
    switch (entry.kind) {
      case "pi.user":
        items.push({ id: String(entry.id), kind: "user", text: contentText(m?.content) });
        break;
      case USER_ENTRY: {
        const data: any = entry.data ?? {};
        items.push({ id: String(entry.id), kind: "user", text: String(data.text ?? ""), path: data.file ?? undefined, line: data.line ?? undefined });
        break;
      }
      case "pi.assistant":
        addAssistant(String(entry.id), m, false);
        break;
      case "pi.tool-result": {
        const item = m && tools.get(m.toolCallId);
        if (!item) break;
        item.status = m.isError ? "error" : "done";
        const out = contentText(m.content);
        item.output = out.length > 6000 ? `${out.slice(0, 6000)}\n…` : out;
        item.images = (m.content ?? []).filter((c: any) => c.type === "image").length || undefined;
        const details = m.details ?? {};
        if (typeof details.diff === "string") item.diff = details.diff;
        else if (typeof details.patch === "string" && details.patch) item.diff = details.patch;
        if (typeof details.firstChangedLine === "number") item.line = details.firstChangedLine;
        break;
      }
      case "pi.compaction":
        items.push({ id: String(entry.id), kind: "note", text: "Earlier messages were summarized to save space." });
        break;
      case "pi.reset":
        items.push({ id: String(entry.id), kind: "note", text: "New context." });
        break;
    }
  }
  const live: any = view.docs["pi.live"] ?? {};
  if (live.generation?.message) addAssistant("live", live.generation.message, true);
  for (const slot of live.tools ?? []) {
    const item = tools.get(slot.callId);
    if (!item || item.status === "done" || item.status === "error") continue;
    item.status = slot.status === "pending" ? "pending" : "running";
    if (slot.output) item.output = slot.output.length > 6000 ? `…${slot.output.slice(-6000)}` : slot.output;
  }
  const busy = !!live.run;
  let status: string | null = null;
  if (live.generation?.retry) status = `Retrying: ${String(live.generation.retry.error).slice(0, 200)}`;
  else if (live.compactions?.length) status = "Summarizing earlier messages…";
  else if (busy && !live.generation?.message && !(live.tools ?? []).some((t: any) => t.status === "running")) status = "Thinking…";
  return { items, busy, status };
}

// -- the service ----------------------------------------------------------------------

export class AgentService {
  readonly store = new KeychainCredentialStore();
  readonly models: MutableModels;
  private starting: Promise<Harness> | null = null;
  private current: { project: string; conversation: Conversation; view: AttachedReplicatedState<ConversationView> } | null = null;
  private error: string | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Scripted model for the self-test. */
  faux: FauxProviderHandle | null = null;

  constructor() {
    installProxyFetch();
    // No ambient credentials on iOS: no environment variables or files.
    this.models = createModels({ credentials: this.store, authContext: { env: async () => undefined, fileExists: async () => false } });
    for (const provider of [
      radiusProvider(),
      anthropicProvider(),
      openaiProvider(),
      openaiCodexProvider(),
      githubCopilotProvider(),
      googleProvider(),
      openrouterProvider(),
      xaiProvider(),
      mistralProvider(),
      groqProvider(),
      deepseekProvider(),
      kimiCodingProvider(),
      metaProvider(),
    ]) {
      this.models.setProvider(provider);
    }
  }

  start(): Promise<Harness> {
    this.starting ??= (async () => {
      const storage = await SqliteStorage.open(await BridgeSqlite.open("agent"));
      const registry = createRegistry();
      registry.install(Prompt);
      registry.install(ProjectTools);
      const harness = await Harness.open(
        storage,
        {
          models: this.models,
          registry,
          env: (target) => (target.cwd === undefined ? undefined : this.env(target.cwd)),
          settings: {
            // A browser WebSocket cannot carry auth headers (OpenAI Codex prefers one).
            stream: { transport: "sse" },
            retry: { maxRetries: 4 },
            progress: { partialIntervalMs: 150, outputIntervalMs: 250 },
          },
          onReport: (report: unknown) => void call("log", `[agent] ${JSON.stringify(report).slice(0, 2000)}`).catch(() => {}),
        },
        ctx,
      );
      harness.resume(); // finish what the last page left running
      void this.refreshCatalogs();
      return harness;
    })();
    return this.starting;
  }

  /** Fetch the model lists of signed-in providers whose catalogs live on their servers. */
  private async refreshCatalogs() {
    const signedIn = new Set((await this.store.list()).map((c) => c.providerId));
    const providers = DYNAMIC_CATALOGS.filter((id) => signedIn.has(id));
    if (!providers.length) return;
    await this.models.refresh({ providers, allowNetwork: true }).catch(() => {});
    this.scheduleState();
  }

  private env(project: string) {
    return new ProjectEnv({
      project,
      onWrite: (paths) => void call("files.changed", { paths }).catch(() => {}),
    });
  }

  // -- models and accounts ---------------------------------------------------------------

  /** Providers and how one signs in to them. */
  async accounts() {
    const stored = new Map((await this.store.list()).map((c) => [c.providerId, c.type]));
    return this.models
      .getProviders()
      .filter((p) => p.id !== "faux" && p.id !== "selftest")
      .map((p) => ({
        id: p.id,
        name: p.name,
        featured: p.id === FEATURED_PROVIDER,
        oauth: p.auth.oauth ? { name: p.auth.oauth.name, label: p.auth.oauth.loginLabel ?? null, subscription: !!p.auth.oauth.isSubscription } : null,
        apiKey: p.auth.apiKey?.login ? { name: p.auth.apiKey.name } : null,
        signedIn: stored.get(p.id) ?? null,
      }));
  }

  /** Chat models of the providers that have credentials. */
  async availableModels() {
    const out: { provider: string; providerName: string; id: string; name: string; reasoning: boolean }[] = [];
    for (const p of this.models.getProviders()) {
      if (!(await this.store.read(p.id)) && p.id !== "selftest") continue;
      for (const m of await this.models.getAvailable(p.id)) {
        out.push({ provider: p.id, providerName: p.name, id: m.id, name: m.name ?? m.id, reasoning: !!m.reasoning });
      }
    }
    return out;
  }

  private async defaultModel(preferred?: ModelRef | null): Promise<ModelRef | null> {
    const available = await this.availableModels();
    if (preferred && available.some((m) => m.provider === preferred.provider && m.id === preferred.modelId)) return preferred;
    // The featured provider's models first, then everyone else's.
    const featured = available.filter((m) => m.provider === FEATURED_PROVIDER);
    for (const pool of [featured, available]) {
      for (const re of PREFERRED) {
        const m = pool.find((x) => re.test(x.id));
        if (m) return { provider: m.provider, modelId: m.id };
      }
      if (pool[0]) return { provider: pool[0].provider, modelId: pool[0].id };
    }
    return null;
  }

  async login(providerId: string, type: AuthType) {
    this.error = null;
    await login(this.models, providerId, type);
    if (DYNAMIC_CATALOGS.includes(providerId)) await this.models.refresh({ providers: [providerId], allowNetwork: true, force: true }).catch(() => {});
    this.scheduleState();
    return true;
  }

  cancelLogin() {
    cancelLogin();
  }

  async logout(providerId: string) {
    await this.models.logout(providerId);
    this.scheduleState();
  }

  // -- conversations -----------------------------------------------------------------------

  /** Show the project's conversation (or start one); returns its ID for the host to remember. */
  async open(project: string, conversationId?: number | null, preferred?: ModelRef | null): Promise<number> {
    const harness = await this.start();
    let conversation: Conversation | undefined;
    if (conversationId) conversation = await harness.conversation(conversationId as unknown as ConversationId, ctx);
    if (!conversation) {
      const model = await this.defaultModel(preferred);
      conversation = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { cwd: project, ...(model ? { model } : {}) } },
        ctx,
      );
    }
    await this.attach(project, conversation);
    return Number(conversation.id);
  }

  async newConversation(project: string, preferred?: ModelRef | null): Promise<number> {
    const model = (await this.currentModel()) ?? (await this.defaultModel(preferred));
    const harness = await this.start();
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { cwd: project, ...(model ? { model } : {}) } },
      ctx,
    );
    await this.attach(project, conversation);
    return Number(conversation.id);
  }

  private async attach(project: string, conversation: Conversation) {
    if (this.current?.conversation.id === conversation.id) return;
    this.current?.view.dispose();
    const view = await conversation.viewState(ctx);
    this.current = { project, conversation, view };
    this.error = null;
    view.subscribe(() => this.scheduleState());
    this.scheduleState();
  }

  private async currentModel(): Promise<ModelRef | null> {
    const agent: any = this.current?.view.value?.docs["pi.agent"];
    const m = agent?.model;
    return m?.provider && m?.modelId ? { provider: m.provider, modelId: m.modelId } : null;
  }

  async setModel(provider: string, modelId: string) {
    if (!this.current) return;
    await this.current.conversation.configure({ model: { provider, modelId } }, ctx);
    this.scheduleState();
  }

  async submit(text: string, context?: EditorContext) {
    const c = this.current;
    if (!c || !text.trim()) return;
    this.error = null;
    let model = await this.currentModel();
    if (!model) {
      model = await this.defaultModel();
      if (!model) {
        this.error = "Sign in to a model provider first (Accounts).";
        return this.scheduleState();
      }
      await c.conversation.configure({ model }, ctx);
    }
    // The model reads the editor context before the message; the transcript keeps them apart.
    const { block, file, line } = contextBlock(c.project, context);
    const submission: Submission = await c.conversation.submit(
      {
        type: "input",
        content: block + text,
        entry: { kind: USER_ENTRY, data: { text, file, line, selection: !!context?.selection?.text, error: !!context?.error } },
        requestId: crypto.randomUUID(),
      },
      ctx,
    );
    void submission.wait(ctx).then((settled) => {
      if (settled.status === "unanswered" && settled.reason !== "aborted") {
        const detail = settled.detail === undefined ? "" : `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}`;
        this.error = `${settled.reason.replace(/_/g, " ")}${detail}`.slice(0, 600);
        this.scheduleState();
      }
    });
  }

  async abort() {
    await this.current?.conversation.abort(ctx);
  }

  // -- state for the host ---------------------------------------------------------------

  private scheduleState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.sendState();
    }, 60);
  }

  async state() {
    const c = this.current;
    const value = c?.view.value;
    const built = value ? buildItems(value) : { items: [], busy: false, status: null };
    const ref = await this.currentModel();
    const model: Model<any> | undefined = ref ? this.models.getModel(ref.provider, ref.modelId) : undefined;
    return {
      project: c?.project ?? null,
      conversationId: c ? Number(c.conversation.id) : null,
      items: built.items,
      busy: built.busy,
      status: built.status,
      error: this.error,
      model: ref ? { provider: ref.provider, id: ref.modelId, name: model?.name ?? ref.modelId } : null,
      signedIn: (await this.store.list()).length > 0 || !!this.faux,
    };
  }

  private async sendState() {
    try {
      await call("agent.state", { json: JSON.stringify(await this.state()) });
    } catch {
      // the host is not listening yet
    }
  }

  // -- self-test ------------------------------------------------------------------------------

  /** A scripted model (pi-ai's faux provider, as "selftest") for the self-test. */
  useFaux(): FauxProviderHandle {
    if (!this.faux) {
      this.faux = fauxProvider({ provider: "selftest" });
      this.models.setProvider(this.faux.provider);
    }
    return this.faux;
  }
}

export const agent = new AgentService();
