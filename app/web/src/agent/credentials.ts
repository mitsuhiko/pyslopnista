// pi-ai's CredentialStore on the Keychain (D33): API keys and OAuth tokens
// live in the engine page's memory while the app runs and in the Keychain
// (this device only) otherwise. Only the engine page can reach these bridge
// ops; Python workers have no bridge.
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { call } from "../host";

export class KeychainCredentialStore implements CredentialStore {
  /** One engine page owns the store, so a promise chain per provider is the lock. */
  private chains = new Map<string, Promise<unknown>>();

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(fn);
    this.chains.set(id, next.catch(() => {}));
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const json = await call<string | null>("agent.keychain.get", { account: providerId });
    return json ? (JSON.parse(json) as Credential) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const ids = await call<string[]>("agent.keychain.list");
    const out: CredentialInfo[] = [];
    for (const id of ids) {
      if (id.startsWith("@")) continue; // our own items (the device ID)
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
      await call("agent.keychain.set", { account: providerId, value: JSON.stringify(next) });
      return next;
    });
  }

  delete(providerId: string) {
    return this.serial(providerId, () => call("agent.keychain.delete", { account: providerId }).then(() => {}));
  }
}

/** A stable ID for this installation (Sign in with ChatGPT needs one). */
export async function deviceId(): Promise<string> {
  const existing = await call<string | null>("agent.keychain.get", { account: "@device-id" });
  if (existing) return existing;
  const id = crypto.randomUUID();
  await call("agent.keychain.set", { account: "@device-id", value: id });
  return id;
}
