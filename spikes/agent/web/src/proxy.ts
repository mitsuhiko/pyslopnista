// Provider HTTP goes through the host's /__http proxy (D25): no CORS, and the
// host adds the API key for the target host when the request carries the
// launch token. The page only ever holds a placeholder key; Python workers
// never see the token, so they cannot borrow the credential.
const PROXY = new URL("/__http", location.href).href;

/** Headers fetch may not set; the proxy never needs them from us. */
const FORBIDDEN = new Set(["user-agent", "cookie", "referer", "origin", "host", "connection", "accept-encoding", "content-length"]);

/** fetch before the patch (the credential check uses it to call the proxy without the token). */
export const rawFetch = globalThis.fetch.bind(globalThis);

export function installProxyFetch(token: string) {
  const original = rawFetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!(url.protocol === "http:" || url.protocol === "https:")) return original(request);
    const headers = new Headers();
    request.headers.forEach((value, name) => {
      if (!FORBIDDEN.has(name)) headers.set(name, value);
    });
    headers.set("X-Pyslop-Token", token);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    return original(`${PROXY}?url=${encodeURIComponent(url.href)}`, { method: request.method, headers, body, signal: request.signal });
  };
}
