// HOSTFS (D35): the program's project folder as an Emscripten file system
// whose files are the host's. Modelled on Emscripten's NODEFS; every
// operation that reaches the host is one blocking request to /__fs
// (HostFS.swift): through the fetch relay (Q25), or a synchronous XHR without one.
//
// Round trips cost 0.1-0.2 ms (simulator; spikes/host-fs), so the worker keeps:
// - a write-behind queue: writes to any file wait in the worker and go to the
//   host in one call before any other call is made (so the host sees every
//   operation in program order) and when the program idles, blocks or ends.
//   A killed worker looks like a crash before the queued writes; SQLite's
//   journal recovers from that like from any crash.
// - a stat cache (missing files included) that this worker's own changes keep
//   current. Entries live for a second.
// - a read cache of 64 KB blocks per file, checked against the file's size and
//   mtime when it is opened. This worker's writes drop the blocks they touch.
// Both caches are dropped when the host's generation for the mount changes:
// it goes up when the editor, the agent or another interpreter changes files.

const BLOCK = 64 * 1024;
const MAX_CACHED = 64 * 1024 * 1024; // bytes of blocks, for all files
const MAX_QUEUED = 1024 * 1024;
const ATTR_TTL = 1000;

export function createHostFS(py, token, fetchSync = null) {
  const FS = py.FS;
  const ERRNO = py.ERRNO_CODES;
  const errno = (name) => new FS.ErrnoError(ERRNO[name] ?? ERRNO.EIO);

  // -- transport --------------------------------------------------------------------

  let generation = null;
  const attrs = new Map(); // path -> {stat, at} | {missing, at}
  const cachedNodes = new Set(); // nodes with blocks
  let cachedBytes = 0;

  function dropCaches() {
    attrs.clear();
    for (const node of cachedNodes) node.blocks = null;
    cachedNodes.clear();
    cachedBytes = 0;
  }

  /** The host's answer: the X-Fs-Result header and the body. */
  function request(meta, data) {
    const headers = { "X-Fs-Mount": token, "X-Fs": encodeURIComponent(JSON.stringify(meta)) };
    if (fetchSync) {
      try {
        const response = fetchSync("/__fs", { method: "POST", headers, body: data ?? null });
        return { header: response.headers["x-fs-result"], body: response.body };
      } catch {
        return { header: null, body: null };
      }
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/__fs", false);
    xhr.responseType = "arraybuffer";
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.send(data ?? null);
    return { header: xhr.getResponseHeader("X-Fs-Result"), body: new Uint8Array(xhr.response ?? new ArrayBuffer(0)) };
  }

  function send(meta, data) {
    const { header, body } = request(meta, data);
    const result = header ? JSON.parse(decodeURIComponent(header)) : { error: "EIO" };
    if (result.gen !== undefined && result.gen !== generation) {
      if (generation !== null) dropCaches();
      generation = result.gen;
    }
    if (result.error) throw errno(result.error);
    return { meta: result, data: body ?? new Uint8Array(0) };
  }

  // -- write-behind ------------------------------------------------------------------

  let queue = { runs: [], chunks: [], bytes: 0 };

  function flush() {
    if (!queue.runs.length) return;
    const data = new Uint8Array(queue.bytes);
    let offset = 0;
    for (const chunk of queue.chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    const runs = queue.runs;
    queue = { runs: [], chunks: [], bytes: 0 };
    send({ op: "writev", runs }, data);
  }

  /** Every call but a queued write: the queue goes first. */
  function host(meta, data) {
    flush();
    return send(meta, data);
  }

  // -- stat cache ----------------------------------------------------------------------

  const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  function forget(path) {
    attrs.delete(path);
    attrs.delete(parentOf(path)); // the directory's mtime changed too
  }

  function lstat(path) {
    const hit = attrs.get(path);
    if (hit && performance.now() - hit.at < ATTR_TTL) {
      if (hit.missing) throw errno("ENOENT");
      return hit.stat;
    }
    try {
      const stat = host({ op: "lstat", path }).meta;
      attrs.set(path, { stat, at: performance.now() });
      return stat;
    } catch (e) {
      if (e.errno === ERRNO.ENOENT) attrs.set(path, { missing: true, at: performance.now() });
      throw e;
    }
  }

  // -- paths and nodes ----------------------------------------------------------------

  function realPath(node) {
    const parts = [];
    while (node.parent !== node) {
      parts.push(node.name);
      node = node.parent;
    }
    return parts.reverse().join("/");
  }
  const child = (parent, name) => {
    const base = realPath(parent);
    return base ? `${base}/${name}` : name;
  };

  function attr(node, s) {
    return {
      dev: 1, ino: node.id, mode: s.mode, nlink: s.nlink ?? 1, uid: 0, gid: 0, rdev: 0, size: s.size,
      atime: new Date(s.atime), mtime: new Date(s.mtime), ctime: new Date(s.ctime),
      blksize: 4096, blocks: Math.ceil(s.size / 4096),
    };
  }

  /** The node FS keeps for parent/name, without asking the host. */
  function known(parent, name) {
    for (let node = FS.nameTable[FS.hashName(parent.id, name)]; node; node = node.name_next) {
      if (node.parent.id === parent.id && node.name === name) return node;
    }
    return null;
  }

  // -- read cache ----------------------------------------------------------------------

  function dropBlocks(node, from = 0, to = Infinity) {
    if (!node.blocks) return;
    for (const [index, block] of node.blocks) {
      if (index * BLOCK + BLOCK <= from || index * BLOCK >= to) continue;
      node.blocks.delete(index);
      cachedBytes -= block.length;
    }
  }

  function cachedRead(stream, target, length, position) {
    const node = stream.node;
    if (!node.blocks) {
      node.blocks = new Map();
      cachedNodes.add(node);
    }
    let done = 0;
    while (done < length) {
      const pos = position + done;
      const index = Math.floor(pos / BLOCK);
      let block = node.blocks.get(index);
      if (!block) {
        if (cachedBytes > MAX_CACHED) dropCaches();
        if (!node.blocks) {
          node.blocks = new Map();
          cachedNodes.add(node);
        }
        block = host({ op: "read", fd: stream.nfd, length: BLOCK, position: index * BLOCK }).data;
        node.blocks.set(index, block);
        cachedBytes += block.length;
      }
      const start = pos - index * BLOCK;
      if (start >= block.length) break; // end of file
      const n = Math.min(length - done, block.length - start);
      target.set(block.subarray(start, start + n), done);
      done += n;
      if (block.length < BLOCK) break; // the last block
    }
    return done;
  }

  // -- the file system --------------------------------------------------------------

  const node_ops = {
    getattr(node) {
      return attr(node, lstat(realPath(node)));
    },
    setattr(node, a) {
      const path = realPath(node);
      if (a.size !== undefined) {
        host({ op: "truncate", path, size: a.size });
        dropBlocks(node, a.size);
      }
      if (typeof (a.atime ?? a.mtime) === "number") {
        const now = Date.now();
        host({ op: "utimes", path, atime: a.atime ?? now, mtime: a.mtime ?? now });
      }
      if (a.mode !== undefined) node.mode = a.mode; // permissions stay the host's
      forget(path);
    },
    lookup(parent, name) {
      return HOSTFS.createNode(parent, name, lstat(child(parent, name)).mode);
    },
    mknod(parent, name, mode) {
      const path = child(parent, name);
      host({ op: FS.isDir(mode) ? "mkdir" : "create", path });
      forget(path);
      return HOSTFS.createNode(parent, name, mode);
    },
    rename(oldNode, newDir, newName) {
      const from = realPath(oldNode);
      const to = child(newDir, newName);
      host({ op: "rename", from, to });
      forget(from);
      forget(to);
      if (FS.isDir(oldNode.mode)) attrs.clear(); // paths below it changed
      // The host replaced the target; forget FS's node for it.
      const replaced = known(newDir, newName);
      if (replaced && replaced !== oldNode) FS.hashRemoveNode(replaced);
      oldNode.name = newName;
    },
    unlink(parent, name) {
      const path = child(parent, name);
      host({ op: "unlink", path });
      forget(path);
      const node = known(parent, name);
      if (node) dropBlocks(node);
    },
    rmdir(parent, name) {
      const path = child(parent, name);
      host({ op: "rmdir", path });
      forget(path);
    },
    readdir(node) {
      // The host sends each entry's stat along, so listing a folder doesn't
      // cost a call per entry.
      const path = realPath(node);
      const entries = JSON.parse(new TextDecoder().decode(host({ op: "readdir", path }).data));
      const now = performance.now();
      for (const e of entries) {
        if (!known(node, e.name)) HOSTFS.createNode(node, e.name, e.mode);
        attrs.set(path ? `${path}/${e.name}` : e.name, { stat: e, at: now });
      }
      return [".", "..", ...entries.map((e) => e.name)];
    },
    symlink() {
      throw errno("EPERM");
    },
    readlink() {
      throw errno("EINVAL");
    },
  };

  const stream_ops = {
    open(stream) {
      const node = stream.node;
      if (FS.isDir(node.mode)) return;
      // Emscripten created and truncated the file already, and positions
      // appends itself: only the access mode matters.
      const s = host({ op: "open", path: realPath(node), flags: stream.flags & 3 }).meta;
      stream.nfd = s.fd;
      stream.shared.refcount = 1;
      // Cached blocks are good only if nobody changed the file since.
      const stamp = `${s.size}:${s.mtime}`;
      if (node.blocks && node.stamp !== stamp) dropBlocks(node);
      node.stamp = stamp;
      attrs.set(realPath(node), { stat: s, at: performance.now() });
    },
    close(stream) {
      if (!stream.nfd || --stream.shared.refcount > 0) return;
      host({ op: "close", fd: stream.nfd });
    },
    dup(stream) {
      stream.shared.refcount++;
    },
    getattr(stream) {
      return attr(stream.node, lstat(realPath(stream.node)));
    },
    setattr(stream, a) {
      if (a.size !== undefined) {
        host({ op: "ftruncate", fd: stream.nfd, size: a.size });
        dropBlocks(stream.node, a.size);
      }
      if (a.mode !== undefined) stream.node.mode = a.mode;
      forget(realPath(stream.node));
    },
    read(stream, buffer, offset, length, position) {
      const target = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      if (length >= 2 * BLOCK) {
        // Big reads in one call, past the cache.
        const { data } = host({ op: "read", fd: stream.nfd, length, position });
        target.set(data);
        return data.length;
      }
      return cachedRead(stream, target, length, position);
    },
    write(stream, buffer, offset, length, position) {
      if (!length) return 0;
      const node = stream.node;
      dropBlocks(node, position, position + length);
      // Keep the cached size right instead of asking again.
      const path = realPath(node);
      const hit = attrs.get(path);
      if (hit?.stat) attrs.set(path, { stat: { ...hit.stat, size: Math.max(hit.stat.size, position + length), mtime: Date.now() }, at: hit.at });
      else forget(path);
      // Emscripten passes HEAP8 (an Int8Array) for writes from wasm memory.
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      const last = queue.runs[queue.runs.length - 1];
      if (last && last[0] === stream.nfd && last[1] + last[2] === position) last[2] += length;
      else queue.runs.push([stream.nfd, position, length]);
      queue.chunks.push(bytes.slice());
      queue.bytes += length;
      if (queue.bytes > MAX_QUEUED) flush();
      return length;
    },
    llseek(stream, offset, whence) {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2 && FS.isFile(stream.node.mode)) position += lstat(realPath(stream.node)).size;
      if (position < 0) throw errno("EINVAL");
      return position;
    },
    fsync(stream) {
      host({ op: "fsync", fd: stream.nfd });
      return 0;
    },
    mmap(stream, length, position) {
      // A copy, like NODEFS: fine for one connection (SQLite's WAL index
      // included), not shared between processes.
      if (!FS.isFile(stream.node.mode)) throw errno("ENODEV");
      const ptr = py._module._malloc(length);
      if (!ptr) throw errno("ENOMEM");
      stream_ops.read(stream, py._module.HEAP8, ptr, length, position);
      return { ptr, allocated: true };
    },
    msync(stream, buffer, offset, length) {
      stream_ops.write(stream, buffer, 0, length, offset);
      return 0;
    },
  };

  const HOSTFS = {
    flush,
    mount() {
      return HOSTFS.createNode(null, "/", host({ op: "stat", path: "" }).meta.mode);
    },
    createNode(parent, name, mode) {
      const node = FS.createNode(parent, name, mode);
      node.node_ops = node_ops;
      node.stream_ops = stream_ops;
      return node;
    },
  };
  return HOSTFS;
}
