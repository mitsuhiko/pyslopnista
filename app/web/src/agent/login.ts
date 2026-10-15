// Sign-in (D33): pi-ai's own login flows, run in the engine page.
// - The OAuth flows are bundled and registered like pi-ai's Bun build does
//   (vite aliases); node:http runs on the host's loopback listener.
// - Auth URLs and device-code links open in ASWebAuthenticationSession.
// - Prompts (login method, API key, a pasted code) are a native sheet: the
//   bridge call stays pending until the user answers.
import type { AuthInteraction, AuthType, MutableModels } from "@earendil-works/pi-ai";
import { anthropicOAuth } from "@oauth/anthropic.js";
import { githubCopilotOAuth } from "@oauth/github-copilot.js";
import { kimiCodingOAuth } from "@oauth/kimi-coding.js";
import { registerBundledOAuthFlowLoaders } from "@oauth/load.js";
import { metaOAuth } from "@oauth/meta.js";
import { openaiChatGPTOAuth } from "@oauth/openai-chatgpt.js";
import { openaiCodexOAuth } from "@oauth/openai-codex.js";
import { openRouterOAuth } from "@oauth/openrouter.js";
import { createRadiusOAuth } from "@oauth/radius.js";
import { xaiOAuth } from "@oauth/xai.js";
import { call } from "../host";
import { deviceId } from "./credentials";

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

let current: AbortController | null = null;
let promptSeq = 0;

function interaction(signal: AbortSignal): AuthInteraction {
  return {
    signal,
    async prompt(prompt) {
      const id = ++promptSeq;
      // A flow may withdraw a prompt (the browser callback won the race).
      const dismiss = () => void call("agent.login.dismiss", { id }).catch(() => {});
      prompt.signal?.addEventListener("abort", dismiss, { once: true });
      try {
        return await call<string>("agent.login.prompt", {
          id,
          type: prompt.type,
          message: prompt.message,
          placeholder: "placeholder" in prompt ? (prompt.placeholder ?? null) : null,
          options: prompt.type === "select" ? prompt.options.map((o) => ({ id: o.id, label: o.label, description: o.description ?? null })) : null,
        });
      } catch {
        throw new Error("Login cancelled");
      } finally {
        prompt.signal?.removeEventListener("abort", dismiss);
      }
    },
    notify(event) {
      if (event.type === "auth_url") {
        void call("agent.auth.open", { url: event.url }).catch(() => {});
      } else if (event.type === "device_code") {
        void call("agent.clipboard", { value: event.userCode }).catch(() => {});
        void call("agent.auth.open", { url: event.verificationUri }).catch(() => {});
      }
      void call("agent.login.event", { event }).catch(() => {});
    },
  };
}

/** Sign in to a provider; the credential lands in the Keychain. */
export async function login(models: MutableModels, providerId: string, type: AuthType) {
  current?.abort();
  const controller = new AbortController();
  current = controller;
  const id = await deviceId();
  try {
    await models.login(providerId, type, interaction(controller.signal), { getDeviceId: () => id });
  } finally {
    if (current === controller) current = null;
    await call("agent.auth.close").catch(() => {});
  }
}

export function cancelLogin() {
  current?.abort();
}
