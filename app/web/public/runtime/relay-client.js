// A blocking fetch through the fetch relay (fetch-relay.js, Q25): the request
// goes into a SharedArrayBuffer shared with the relay, and this worker sleeps
// in Atomics.wait until the response is there.
//
// Layout: Int32 [state, length, more], then the bytes from offset 16. The
// state is IDLE, REQUEST (this side wrote a piece, or asks for the next piece
// of the response) or REPLY (the relay wrote a piece, or took a piece of the
// request). Messages longer than the buffer go in pieces with `more` set.
const HEADER = 16;
const IDLE = 0;
const REQUEST = 1;
const REPLY = 2;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function createRelayClient(channel) {
  const ints = new Int32Array(channel, 0, 3);
  const bytes = new Uint8Array(channel);
  const capacity = channel.byteLength - HEADER;

  /** Hand the relay a piece (or ask for the next one) and wait for its answer. */
  function exchange(piece, more) {
    if (piece) bytes.set(piece, HEADER);
    ints[1] = piece?.length ?? 0;
    ints[2] = more ? 1 : 0;
    Atomics.store(ints, 0, REQUEST);
    Atomics.notify(ints, 0);
    while (Atomics.load(ints, 0) === REQUEST) Atomics.wait(ints, 0, REQUEST);
  }

  /** fetch(), blocking: {status, statusText, headers (lowercase names), body:
   * Uint8Array}. A network error throws (with `timeout` set when the
   * request took longer than `timeout` ms; 0 waits forever). */
  return function fetchSync(url, { method = "GET", headers = {}, body = null, timeout = 0 } = {}) {
    const json = encoder.encode(JSON.stringify({ url, method, headers, timeout }));
    const request = new Uint8Array(4 + json.length + (body?.length ?? 0));
    new DataView(request.buffer).setUint32(0, json.length, true);
    request.set(json, 4);
    if (body) request.set(body, 4 + json.length);

    for (let offset = 0; ; ) {
      const n = Math.min(capacity, request.length - offset);
      const more = offset + n < request.length;
      exchange(request.subarray(offset, offset + n), more);
      offset += n;
      if (!more) break;
    }
    const parts = [];
    for (;;) {
      parts.push(bytes.slice(HEADER, HEADER + ints[1]));
      if (!ints[2]) break;
      exchange(null, false);
    }
    Atomics.store(ints, 0, IDLE);

    let response = parts[0];
    if (parts.length > 1) {
      response = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const p of parts) {
        response.set(p, offset);
        offset += p.length;
      }
    }
    const n = new DataView(response.buffer, response.byteOffset).getUint32(0, true);
    const meta = JSON.parse(decoder.decode(response.subarray(4, 4 + n)));
    if (meta.error) throw Object.assign(new Error(`Network error: ${meta.error}`), { timeout: !!meta.timeout });
    return { status: meta.status, statusText: meta.statusText ?? "", headers: meta.headers, body: response.subarray(4 + n) };
  };
}
