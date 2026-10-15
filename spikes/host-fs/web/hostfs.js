// HOSTFS: an Emscripten file system whose files are the host's (the app's
// project folder), modelled on Emscripten's NODEFS. Every operation is a
// synchronous call to the host (`call(meta, data) -> {meta, data}`).
//
// Options:
//   buffered: write-behind. Writes queue up in the worker (all files, in
//             order) and go to the host in one call before any other call
//             is made, so the host still sees every operation in program
//             order; a killed worker looks like a crash before the queued
//             writes. At most 1 MB is queued.
//   fsync:    forward fsync to the host (F_FULLFSYNC is not used either way).
//   attrCache: remember stat results (and missing files) until this worker
//             changes them itself. Changes made by others (the editor, the
//             host) are not seen; the host would have to send invalidations.
//   readCache: keep file contents in 64 KB blocks in the worker; this
//             worker's writes and truncates drop the blocks they touch.
//             Same caveat as attrCache. No size limit in the spike.

const BLOCK = 65536;

export function createHostFS(py, call, { buffered = false, fsync = true, attrCache = false, readCache = false } = {}) {
  const FS = py.FS;
  const ERRNO = py.ERRNO_CODES;
  const stats = { calls: 0, byOp: {} };

  // write-behind queue (buffered): runs [fd, position, length] and their bytes
  let queue = { runs: [], chunks: [], bytes: 0 };

  function flushQueue() {
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

  function host(meta, data) {
    flushQueue();
    return send(meta, data);
  }

  function send(meta, data) {
    stats.calls++;
    stats.byOp[meta.op] = (stats.byOp[meta.op] ?? 0) + 1;
    const reply = call(meta, data);
    if (reply.meta.error) throw new FS.ErrnoError(ERRNO[reply.meta.error] ?? ERRNO.EIO);
    return reply;
  }

  // path -> stat (or "ENOENT"), when attrCache is on
  const attrs = new Map();
  const forget = (path) => {
    attrs.delete(path);
    const slash = path.lastIndexOf("/");
    attrs.delete(slash < 0 ? "" : path.slice(0, slash)); // the directory's mtime changed
  };
  function lstat(path) {
    if (attrCache) {
      const hit = attrs.get(path);
      if (hit === "ENOENT") throw new FS.ErrnoError(ERRNO.ENOENT);
      if (hit) return hit;
    }
    try {
      const s = host({ op: "lstat", path }).meta;
      if (attrCache) attrs.set(path, s);
      return s;
    } catch (e) {
      if (attrCache && e.errno === ERRNO.ENOENT) attrs.set(path, "ENOENT");
      throw e;
    }
  }

  function realPath(node) {
    const parts = [];
    while (node.parent !== node) {
      parts.push(node.name);
      node = node.parent;
    }
    return parts.reverse().join("/");
  }
  const child = (parent, name) => (realPath(parent) ? `${realPath(parent)}/${name}` : name);

  function attr(node, s) {
    return {
      dev: 1, ino: node.id, mode: s.mode, nlink: s.nlink, uid: 0, gid: 0, rdev: 0, size: s.size,
      atime: new Date(s.atime), mtime: new Date(s.mtime), ctime: new Date(s.ctime),
      blksize: 4096, blocks: Math.ceil(s.size / 4096),
    };
  }

  /** The node FS keeps for parent/name, if any, without asking the host. */
  function cached(parent, name) {
    for (let node = FS.nameTable[FS.hashName(parent.id, name)]; node; node = node.name_next) {
      if (node.parent.id === parent.id && node.name === name) return node;
    }
    return null;
  }

  // -- the file system ----------------------------------------------------------

  const node_ops = {
    getattr(node) {
      return attr(node, lstat(realPath(node)));
    },
    setattr(node, a) {
      const path = realPath(node);
      forget(path);
      if (a.size !== undefined) node.blocks?.clear();
      if (a.size !== undefined) host({ op: "truncate", path, size: a.size });
      if (typeof (a.atime ?? a.mtime) === "number") {
        const now = Date.now();
        host({ op: "utimes", path, atime: a.atime ?? now, mtime: a.mtime ?? now });
      }
      if (a.mode !== undefined) node.mode = a.mode; // permissions stay the host's
    },
    lookup(parent, name) {
      const s = lstat(child(parent, name));
      return HOSTFS.createNode(parent, name, s.mode);
    },
    mknod(parent, name, mode) {
      const path = child(parent, name);
      forget(path);
      if (FS.isDir(mode)) host({ op: "mkdir", path, mode });
      else host({ op: "writefile", path }, new Uint8Array(0));
      return HOSTFS.createNode(parent, name, mode);
    },
    rename(oldNode, newDir, newName) {
      forget(realPath(oldNode));
      forget(child(newDir, newName));
      host({ op: "rename", from: realPath(oldNode), to: child(newDir, newName) });
      // The host replaced the target atomically; forget FS's node for it.
      const replaced = cached(newDir, newName);
      if (replaced && replaced !== oldNode) FS.hashRemoveNode(replaced);
      oldNode.name = newName;
    },
    unlink(parent, name) {
      forget(child(parent, name));
      host({ op: "unlink", path: child(parent, name) });
    },
    rmdir(parent, name) {
      forget(child(parent, name));
      host({ op: "rmdir", path: child(parent, name) });
    },
    readdir(node) {
      // The host sends each entry's stat along: create FS's nodes now, so
      // listing a directory doesn't cost a lookup per entry.
      const { entries } = host({ op: "readdir", path: realPath(node) }).meta;
      for (const e of entries) {
        if (!cached(node, e.name)) HOSTFS.createNode(node, e.name, e.mode);
        if (attrCache) attrs.set(child(node, e.name), e);
      }
      return [".", "..", ...entries.map((e) => e.name)];
    },
    symlink() {
      throw new FS.ErrnoError(ERRNO.EPERM);
    },
    readlink() {
      throw new FS.ErrnoError(ERRNO.EINVAL);
    },
  };

  function cachedRead(stream, buffer, offset, length, position) {
    const blocks = (stream.node.blocks ??= new Map());
    const target = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
    let done = 0;
    while (done < length) {
      const pos = position + done;
      const index = Math.floor(pos / BLOCK);
      let block = blocks.get(index);
      if (!block) {
        block = host({ op: "read", fd: stream.nfd, length: BLOCK, position: index * BLOCK }).data;
        blocks.set(index, block);
      }
      const start = pos - index * BLOCK;
      if (start >= block.length) break; // end of file
      const n = Math.min(length - done, block.length - start);
      target.set(block.subarray(start, start + n), done);
      done += n;
      if (block.length < BLOCK && start + n >= block.length) break;
    }
    return done;
  }

  const stream_ops = {
    open(stream) {
      if (FS.isDir(stream.node.mode)) return;
      // FS.open already created and truncated the file; Emscripten positions
      // appends itself.
      const flags = stream.flags & ~(64 | 128 | 512 | 1024);
      stream.nfd = host({ op: "open", path: realPath(stream.node), flags }).meta.fd;
      stream.shared.refcount = 1;
    },
    close(stream) {
      if (!stream.nfd || --stream.shared.refcount > 0) return;
      host({ op: "close", fd: stream.nfd });
    },
    dup(stream) {
      stream.shared.refcount++;
    },
    getattr(stream) {
      if (attrCache) return attr(stream.node, lstat(realPath(stream.node)));
      return attr(stream.node, host({ op: "fstat", fd: stream.nfd }).meta);
    },
    setattr(stream, a) {
      forget(realPath(stream.node));
      if (a.size !== undefined) stream.node.blocks?.clear();
      if (a.size !== undefined) host({ op: "ftruncate", fd: stream.nfd, size: a.size });
      if (a.mode !== undefined) stream.node.mode = a.mode;
    },
    read(stream, buffer, offset, length, position) {
      if (readCache) return cachedRead(stream, buffer, offset, length, position);
      const { data } = host({ op: "read", fd: stream.nfd, length, position });
      new Uint8Array(buffer.buffer, buffer.byteOffset + offset, data.length).set(data);
      return data.length;
    },
    write(stream, buffer, offset, length, position) {
      if (stream.node.blocks) {
        for (let b = Math.floor(position / BLOCK); b <= Math.floor((position + length - 1) / BLOCK); b++) stream.node.blocks.delete(b);
      }
      if (attrCache) {
        // Keep the cached size right instead of asking again.
        const path = realPath(stream.node);
        const s = attrs.get(path);
        if (s && s !== "ENOENT") attrs.set(path, { ...s, size: Math.max(s.size, position + length), mtime: Date.now() });
        else forget(path);
      }
      // Emscripten passes HEAP8 (an Int8Array) for writes from wasm memory.
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      if (!buffered) return host({ op: "write", fd: stream.nfd, position }, bytes).meta.n;
      const last = queue.runs[queue.runs.length - 1];
      if (last && last[0] === stream.nfd && last[1] + last[2] === position) last[2] += length;
      else queue.runs.push([stream.nfd, position, length]);
      queue.chunks.push(bytes.slice());
      queue.bytes += length;
      if (queue.bytes > 1 << 20) flushQueue();
      return length;
    },
    llseek(stream, offset, whence) {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2 && FS.isFile(stream.node.mode)) {
        position += attrCache ? lstat(realPath(stream.node)).size : host({ op: "fstat", fd: stream.nfd }).meta.size;
      }
      if (position < 0) throw new FS.ErrnoError(ERRNO.EINVAL);
      return position;
    },
    fsync(stream) {
      if (fsync) host({ op: "fsync", fd: stream.nfd });
      else flushQueue();
      return 0;
    },
    mmap(stream, length, position) {
      if (!FS.isFile(stream.node.mode)) throw new FS.ErrnoError(ERRNO.ENODEV);
      const ptr = py._module._malloc(length);
      stream_ops.read(stream, py._module.HEAP8, ptr, length, position);
      return { ptr, allocated: true };
    },
    msync(stream, buffer, offset, length) {
      stream_ops.write(stream, buffer, 0, length, offset);
      return 0;
    },
  };

  const HOSTFS = {
    stats,
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
