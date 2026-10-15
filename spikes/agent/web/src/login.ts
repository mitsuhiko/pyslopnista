// Logins: pi-ai's own flows, run in the page.
// - Credentials are kept in the Keychain, through a CredentialStore over the bridge.
// - The OAuth flows are bundled and registered like the Bun build does
//   (vite aliases), with node:http on the host's loopback listener.
// - auth URLs and device-code links open in ASWebAuthenticationSession.
// - The prompts (method, key, pasted code) are HTML here; in the app they
//   would be a native sheet.
//
// Steps:
//   oauth-mock                       automated: the mock server's OAuth, end to end
//   oauth:<provider>[:<method>[:<model>]]   a real provider; you complete the sign-in
//   apikey:<provider>[:<model>]      paste an API key
// The interactive ones log in, make a request, force a token refresh and
// make another, then reload the page and make one more with what the
// Keychain kept.
import type {
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { anthropicOAuth } from "@oauth/anthropic.js";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "@oauth/callback-server.js";
import { githubCopilotOAuth } from "@oauth/github-copilot.js";
import { kimiCodingOAuth } from "@oauth/kimi-coding.js";
import { registerBundledOAuthFlowLoaders } from "@oauth/load.js";
import { metaOAuth } from "@oauth/meta.js";
import { openaiChatGPTOAuth } from "@oauth/openai-chatgpt.js";
import { openaiCodexOAuth } from "@oauth/openai-codex.js";
import { openRouterOAuth } from "@oauth/openrouter.js";
import { generatePKCE } from "@oauth/pkce.js";
import { createRadiusOAuth } from "@oauth/radius.js";
import { xaiOAuth } from "@oauth/xai.js";
import { call, type Config, log } from "./bridge";

registerBundledOAuthFlowLoaders({
  anthropic: () => anthropicOAuth,
  openaiCodex: () => openaiCodexOAuth,
  openaiChatGPT: () => openaiChatGPTOAuth,
  githubCopilot: () => githubCopilotOAuth,
  openrouter: () => openRouterOAuth,
  kimiCoding: () => kimiCodingOAuth,
  meta: () => metaOAuth,
  xai: () => xaiOAuth,
  radius: createRadiusOAuth,
});

// -- credentials --------------------------------------------------------------

/** pi-ai's CredentialStore on the Keychain; one engine page, so a promise chain per provider is the lock. */
export class KeychainCredentialStore implements CredentialStore {
  private chains = new Map<string, Promise<unknown>>();

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(fn);
    this.chains.set(id, next.catch(() => {}));
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const json = await call<string | null>("keychain.get", { account: providerId });
    return json ? (JSON.parse(json) as Credential) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const ids = await call<string[]>("keychain.list");
    const out: CredentialInfo[] = [];
    for (const id of ids) {
      const c = await this.read(id);
      if (c) out.push({ providerId: id, type: c.type });
    }
    return out;
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.serial(providerId, async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      await call("keychain.set", { account: providerId, value: JSON.stringify(next) });
      return next;
    });
  }

  delete(providerId: string) {
    return this.serial(providerId, () => call("keychain.delete", { account: providerId }).then(() => {}));
  }
}

/** What a credential looks like without its secrets. */
function describe(c: Credential | undefined) {
  if (!c) return null;
  if (c.type === "api_key") return { type: c.type, key: c.key ? `${c.key.length} chars` : "none", env: Object.keys(c.env ?? {}) };
  const { access, refresh, expires, type, ...rest } = c;
  return {
    type,
    access: access ? `${access.length} chars` : "none",
    refresh: refresh ? `${refresh.length} chars` : "none",
    expiresInMin: Math.round((expires - Date.now()) / 60000),
    extra: Object.keys(rest),
  };
}

async function deviceId(): Promise<string> {
  const existing = await call<string | null>("keychain.get", { account: "@device-id" });
  if (existing) return existing;
  const id = crypto.randomUUID();
  await call("keychain.set", { account: "@device-id", value: id });
  return id;
}

// -- models -------------------------------------------------------------------

/** A provider whose OAuth is the mock server's: pi-ai's own callback server, redirect to localhost. */
function mockOAuthProvider(mockUrl: string) {
  const token = async (body: Record<string, string>, signal?: AbortSignal) => {
    const response = await fetch(`${mockUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`token endpoint ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return { type: "oauth" as const, access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000 };
  };
  return createProvider({
    id: "mockoauth",
    name: "Mock OAuth",
    baseUrl: mockUrl,
    auth: {
      oauth: {
        name: "Mock OAuth",
        async login(interaction) {
          const { verifier, challenge } = await generatePKCE();
          const callback = await startOAuthCallbackServer({
            providerName: "Mock",
            host: "127.0.0.1",
            port: 0,
            path: "/callback",
            redirectHost: "localhost", // like Anthropic's: the browser resolves localhost itself
            state: verifier,
            complete: async (code) => code,
            signal: interaction.signal,
            timeoutMs: 60_000,
          });
          try {
            const params = new URLSearchParams({
              response_type: "code",
              redirect_uri: callback.redirectUri,
              code_challenge: challenge,
              code_challenge_method: "S256",
              state: verifier,
            });
            interaction.notify({ type: "auth_url", url: `${mockUrl}/oauth/authorize?${params}` });
            const result = await waitForCallbackOrManualInput(interaction, callback, { message: "Paste the redirect URL", placeholder: callback.redirectUri });
            if (result.type !== "callback") throw new Error("expected the loopback callback, got a pasted code");
            interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
            return token({ grant_type: "authorization_code", code: result.value, code_verifier: verifier, redirect_uri: callback.redirectUri }, interaction.signal);
          } finally {
            callback.close();
          }
        },
        refresh: (credential, signal) => token({ grant_type: "refresh_token", refresh_token: credential.refresh }, signal),
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    models: [
      {
        id: "mock-1",
        name: "Mock 1",
        api: "anthropic-messages",
        provider: "mockoauth",
        baseUrl: mockUrl,
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

export function loginModels(store: CredentialStore, mockUrl: string): MutableModels {
  // No ambient credentials on iOS: no environment variables, no files.
  const models = createModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
  for (const provider of [
    anthropicProvider(),
    openaiProvider(),
    openaiCodexProvider(),
    githubCopilotProvider(),
    openrouterProvider(),
    xaiProvider(),
    kimiCodingProvider(),
    metaProvider(),
  ]) {
    models.setProvider(provider);
  }
  if (mockUrl) models.setProvider(mockOAuthProvider(mockUrl));
  return models;
}

// -- the prompts (a native sheet in the app) -------------------------------------

function panel(): HTMLElement {
  let el = document.getElementById("auth");
  if (!el) {
    el = document.createElement("div");
    el.id = "auth";
    document.body.prepend(el);
  }
  return el;
}

function status(text: string) {
  const line = document.createElement("div");
  line.className = "status";
  line.textContent = text;
  panel().append(line);
  log(`[auth] ${text}`);
}

function showPrompt(prompt: AuthPrompt): Promise<string> {
  return new Promise((resolve, reject) => {
    const box = document.createElement("div");
    box.className = "prompt";
    const label = document.createElement("div");
    label.textContent = prompt.message;
    box.append(label);
    const done = (value: string | null) => {
      box.remove();
      if (value === null) reject(new Error("Login cancelled"));
      else resolve(value);
    };
    if (prompt.type === "select") {
      for (const option of prompt.options) {
        const button = document.createElement("button");
        button.textContent = option.label;
        button.onclick = () => done(option.id);
        box.append(button);
      }
    } else {
      const input = document.createElement("input");
      input.type = prompt.type === "secret" ? "password" : "text";
      input.placeholder = prompt.placeholder ?? "";
      input.autocapitalize = "off";
      input.autocomplete = "off";
      input.spellcheck = false;
      const submit = document.createElement("button");
      submit.textContent = "Submit";
      submit.onclick = () => done(input.value);
      input.onkeydown = (e) => e.key === "Enter" && done(input.value);
      box.append(input, submit);
    }
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => done(null);
    box.append(cancel);
    prompt.signal?.addEventListener("abort", () => done(null), { once: true });
    panel().append(box);
    log(`[auth] prompt (${prompt.type}): ${prompt.message}`);
  });
}

function showDeviceCode(code: string, uri: string) {
  const box = document.createElement("div");
  box.className = "device";
  box.innerHTML = `<div>Enter this code (copied to the clipboard):</div><div class="code"></div><div class="uri"></div>`;
  box.querySelector(".code")!.textContent = code;
  box.querySelector(".uri")!.textContent = uri;
  panel().append(box);
  log(`[auth] device code ${code} at ${uri}`);
}

interface LoginOptions {
  method?: string;
  ephemeral: boolean;
  signal: AbortSignal;
  events: string[];
}

function interaction(o: LoginOptions): AuthInteraction {
  return {
    signal: o.signal,
    prompt: async (prompt) => {
      o.events.push(`prompt:${prompt.type}`);
      if (prompt.type === "select" && o.method) {
        if (!prompt.options.some((x) => x.id === o.method)) {
          throw new Error(`method "${o.method}" is not one of ${prompt.options.map((x) => x.id).join(", ")}`);
        }
        return o.method;
      }
      return showPrompt(prompt);
    },
    notify: (event) => {
      o.events.push(event.type);
      if (event.type === "auth_url") {
        status(event.instructions ?? "Sign in in the browser sheet");
        void call<boolean>("auth.open", { url: event.url, ephemeral: o.ephemeral }).then((started) => o.events.push(`sheet:${started}`));
      } else if (event.type === "device_code") {
        showDeviceCode(event.userCode, event.verificationUri);
        void call("clipboard.set", { value: event.userCode });
        void call("auth.open", { url: event.verificationUri, ephemeral: o.ephemeral });
      } else {
        status(event.message);
      }
    },
  };
}

async function runLogin(models: MutableModels, providerId: string, type: "oauth" | "api_key", o: LoginOptions) {
  const id = await deviceId();
  const closed = (reason: string) => {
    o.events.push(`sheet-closed:${reason}`);
    status(`browser sheet closed (${reason})`);
  };
  (window as any).__authClosed = closed;
  try {
    return await models.login(providerId, type, interaction(o), { getDeviceId: () => id });
  } finally {
    await call("auth.close");
    (window as any).__authClosed = undefined;
  }
}

// -- requests -----------------------------------------------------------------------

const CHEAP = [/haiku/, /mini/, /flash/, /lite/, /small/, /fast/];

function pickModel(models: MutableModels, providerId: string, wanted?: string): Model<any> {
  const all = models.getModels().filter((m) => m.provider === providerId);
  if (!all.length) throw new Error(`no models for ${providerId}`);
  if (wanted) {
    const m = all.find((x) => x.id === wanted);
    if (!m) throw new Error(`no model ${wanted}; have ${all.map((x) => x.id).join(", ")}`);
    return m;
  }
  for (const pattern of CHEAP) {
    const m = all.find((x) => pattern.test(x.id));
    if (m) return m;
  }
  return all[0];
}

async function request(models: MutableModels, providerId: string, wanted?: string) {
  const model = pickModel(models, providerId, wanted);
  const t = performance.now();
  try {
    const message = await models.complete(
      model,
      { systemPrompt: "You are a test probe. Answer tersely.", messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }] },
      { transport: "sse" }, // a browser WebSocket cannot carry auth headers
    );
    const text = message.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
    return {
      ok: message.stopReason !== "error" && message.stopReason !== "aborted",
      model: model.id,
      ms: Math.round(performance.now() - t),
      stopReason: message.stopReason,
      text: text.slice(0, 80),
      error: message.errorMessage?.slice(0, 300),
    };
  } catch (e) {
    return { ok: false, model: model.id, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

// -- steps --------------------------------------------------------------------

type StepContext = { config: Config; phase: number; reloadAt(phase: number): Promise<never> };
export type LoginResult = { ok: boolean; [key: string]: unknown };

async function mockStats(config: Config) {
  return (await fetch(`${config.mockUrl}/stats`)).json();
}

/**
 * Fully automated: pi-ai's callback server on the host's loopback listener,
 * the mock's authorize page in an ephemeral browser sheet (no consent alert),
 * redirect to localhost, code exchange, an OAuth request (Bearer, claude-cli
 * User-Agent through the proxy), a forced refresh, then a reload and a
 * request with the credential the Keychain kept.
 */
export async function oauthMock(c: StepContext): Promise<LoginResult> {
  const store = new KeychainCredentialStore();
  const models = loginModels(store, c.config.mockUrl);
  if (c.phase === 0) {
    await fetch(`${c.config.mockUrl}/reset`, { method: "POST" });
    await store.delete("mockoauth");
    const events: string[] = [];
    const controller = new AbortController();
    const t = performance.now();
    await runLogin(models, "mockoauth", "oauth", { ephemeral: true, signal: controller.signal, events });
    const loginMs = Math.round(performance.now() - t);
    const stored = await store.read("mockoauth");
    const first = await request(models, "mockoauth");
    await store.modify("mockoauth", async (cur) => (cur?.type === "oauth" ? { ...cur, expires: 0 } : cur));
    const second = await request(models, "mockoauth");
    const refreshed = (await store.read("mockoauth")) as any;
    const before = { loginMs, events, stored: describe(stored), first, second, accessChanged: refreshed?.access !== (stored as any)?.access };
    await call("kv.set", { key: "oauth-mock", value: JSON.stringify(before) });
    await c.reloadAt(1);
  }
  const before = JSON.parse((await call<string>("kv.get", { key: "oauth-mock" })) ?? "{}");
  const third = await request(models, "mockoauth");
  const stats = await mockStats(c.config);
  await store.delete("mockoauth");
  return {
    ok:
      before.stored?.type === "oauth" &&
      before.first?.ok &&
      before.second?.ok &&
      before.accessChanged &&
      third.ok &&
      stats.oauth_code === 1 &&
      stats.oauth_refresh === 1 &&
      stats.bearer_ok >= 3 &&
      String(stats.last_user_agent).startsWith("claude-cli/"),
    ...before,
    afterReload: third,
    mockStats: stats,
  };
}

/** A real provider: you complete the sign-in (or paste the key) in the simulator. */
export async function interactive(c: StepContext, kind: "oauth" | "api_key", args: string[]): Promise<LoginResult> {
  const [providerId, a, b] = args;
  const method = kind === "oauth" ? a : undefined;
  const wanted = kind === "oauth" ? b : a;
  if (!providerId) throw new Error("usage: oauth:<provider>[:<method>[:<model>]] or apikey:<provider>[:<model>]");
  const key = `login:${kind}:${providerId}`;
  const store = new KeychainCredentialStore();
  const models = loginModels(store, "");
  if (c.phase === 0) {
    await store.delete(providerId);
    const events: string[] = [];
    const controller = new AbortController();
    const t = performance.now();
    let loginError: string | undefined;
    try {
      await runLogin(models, providerId, kind, { method, ephemeral: false, signal: controller.signal, events });
    } catch (e) {
      loginError = String((e as Error)?.message ?? e).slice(0, 500);
    }
    const loginMs = Math.round(performance.now() - t);
    const stored = await store.read(providerId);
    if (!stored) return { ok: false, loginMs, events, loginError };
    status("Signed in; making a request…");
    const first = await request(models, providerId, wanted);
    let refresh: unknown = "not an OAuth credential";
    if (stored.type === "oauth") {
      await store.modify(providerId, async (cur) => (cur?.type === "oauth" ? { ...cur, expires: 0 } : cur));
      const second = await request(models, providerId, wanted);
      const after = (await store.read(providerId)) as any;
      refresh = { request: second, accessChanged: after?.access !== stored.access, credential: describe(after) };
    }
    const before = { loginMs, events, loginError, stored: describe(stored), first, refresh };
    await call("kv.set", { key, value: JSON.stringify(before) });
    status("Reloading to check what the Keychain kept…");
    await c.reloadAt(1);
  }
  const before = JSON.parse((await call<string>("kv.get", { key })) ?? "{}");
  const third = await request(models, providerId, wanted);
  const refresh = before.refresh as { request?: { ok: boolean }; accessChanged?: boolean } | string;
  const refreshOk = typeof refresh === "string" || (!!refresh.request?.ok && !!refresh.accessChanged);
  return { ok: !!before.first?.ok && refreshOk && third.ok, ...before, afterReload: third };
}

export async function listLogins(): Promise<LoginResult> {
  const store = new KeychainCredentialStore();
  const out: Record<string, unknown> = {};
  for (const info of await store.list()) out[info.providerId] = describe(await store.read(info.providerId));
  return { ok: true, credentials: out };
}

export async function logout(_c: StepContext, args: string[]): Promise<LoginResult> {
  const store = new KeychainCredentialStore();
  for (const id of args.length ? args : (await store.list()).map((i) => i.providerId)) await store.delete(id);
  return { ok: true, removed: args.length ? args : "all" };
}
