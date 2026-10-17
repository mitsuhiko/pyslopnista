// The fetch relay (Q25): makes HTTP requests for Python workers that block
// until the answer is there (HostFS, D35; synchronous XHRs of programs to the
// /__http proxy, D25).
//
// A worker's synchronous XHR is sometimes answered about a second late by
// WebKit after the worker slept in Atomics.wait (spikes/xhr-wait). So the
// blocked worker doesn't make the request itself: it puts it into a
// SharedArrayBuffer and waits there; this worker, which never blocks, makes it
// asynchronously and puts the response back. One relay serves every worker of
// the page, each over its own buffer (relay-client.js has the other side and
// the layout).
const HEADER = 16; // Int32 state, length, more; the bytes follow
const REQUEST = 1;
const REPLY = 2;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const served = new Map(); // SharedArrayBuffer -> {stopped}

onmessage = (e) => {
  const { type, channel } = e.data;
  if (type === "attach" && !served.has(channel)) {
    const state = { stopped: false };
    served.set(channel, state);
    serve(channel, state);
  } else if (type === "detach") {
    const state = served.get(channel);
    if (!state) return;
    served.delete(channel);
    state.stopped = true;
    Atomics.notify(new Int32Array(channel, 0, 1), 0); // ends the waitAsync below
  }
};

function concat(parts) {
  if (parts.length === 1) return parts[0];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    all.set(p, offset);
    offset += p.length;
  }
  return all;
}

/** One message: [u32 length of the JSON][JSON][body]. */
function pack(meta, body) {
  const json = encoder.encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + json.length + (body?.length ?? 0));
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  if (body) out.set(body, 4 + json.length);
  return out;
}
function unpack(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  return { meta: JSON.parse(decoder.decode(bytes.subarray(4, 4 + n))), body: bytes.subarray(4 + n) };
}

/** The request with an asynchronous XHR: about 0.03 ms cheaper per call than
 * fetch() here (simulator), which matters for HostFS's many small calls. */
async function perform(bytes) {
  try {
    const { meta, body } = unpack(bytes);
    const xhr = new XMLHttpRequest();
    xhr.open(meta.method ?? "GET", meta.url);
    xhr.responseType = "arraybuffer";
    for (const [name, value] of Object.entries(meta.headers ?? {})) xhr.setRequestHeader(name, value);
    if (meta.timeout > 0) xhr.timeout = meta.timeout;
    await new Promise((resolve, reject) => {
      xhr.onload = resolve;
      xhr.onerror = () => reject(new Error("the request failed"));
      xhr.onabort = () => reject(new Error("the request was aborted"));
      xhr.ontimeout = () => reject(Object.assign(new Error("the request timed out"), { timeout: true }));
      xhr.send(body.length ? body : null);
    });
    const headers = {};
    for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return pack({ status: xhr.status, statusText: xhr.statusText, headers }, new Uint8Array(xhr.response ?? new ArrayBuffer(0)));
  } catch (e) {
    return pack({ error: String(e?.message ?? e), ...(e?.timeout ? { timeout: true } : {}) });
  }
}

async function serve(channel, state) {
  const ints = new Int32Array(channel, 0, 3);
  const bytes = new Uint8Array(channel);
  const capacity = channel.byteLength - HEADER;
  let incoming = [];
  let outgoing = null;
  let sent = 0;

  const reply = (n, more) => {
    ints[1] = n;
    ints[2] = more ? 1 : 0;
    Atomics.store(ints, 0, REPLY);
    Atomics.notify(ints, 0);
  };
  const sendNext = () => {
    const n = Math.min(capacity, outgoing.length - sent);
    bytes.set(outgoing.subarray(sent, sent + n), HEADER);
    sent += n;
    const more = sent < outgoing.length;
    if (!more) outgoing = null;
    reply(n, more);
  };

  while (!state.stopped) {
    const now = Atomics.load(ints, 0);
    if (now !== REQUEST) {
      const wait = Atomics.waitAsync(ints, 0, now);
      if (wait.async) await wait.value;
      continue;
    }
    if (outgoing) {
      sendNext(); // the worker asks for the next piece of a big response
      continue;
    }
    incoming.push(bytes.slice(HEADER, HEADER + ints[1]));
    if (ints[2]) {
      reply(0, false); // got this piece of a big request; next
      continue;
    }
    const request = concat(incoming);
    incoming = [];
    outgoing = await perform(request);
    sent = 0;
    if (state.stopped) return;
    sendNext();
  }
}
