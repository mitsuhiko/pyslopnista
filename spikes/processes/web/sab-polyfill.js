// WKWebView on app:// is cross-origin isolated but hides the SharedArrayBuffer
// global. Shared wasm memory still provides a working constructor (see D9).
globalThis.SharedArrayBuffer ??=
  new WebAssembly.Memory({ initial: 0, maximum: 0, shared: true }).buffer.constructor;
