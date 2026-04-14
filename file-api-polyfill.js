(function () {
  "use strict";

  if (typeof window === "undefined") return;
  if (!window.isSecureContext) return;
  if (typeof window.showOpenFilePicker === "function") return;

  // ── Promise bridge ─────────────────────────────────────────────────────────

  let _nextId = 1;
  const _pending = new Map();
  const _observers = new Map();

  window.__wFS_resolve = function (id, result) {
    const p = _pending.get(id);
    if (p) {
      _pending.delete(id);
      p.resolve(result);
    }
  };

  window.__wFS_reject = function (id, err) {
    const p = _pending.get(id);
    if (p) {
      _pending.delete(id);
      p.reject(new DOMException(err.message, err.name));
    }
  };

  window.__wFS_notify = function (payload) {
    const cb = _observers.get(payload.mid);
    if (!cb) return;
    const rec = payload.record;
    const handle =
      rec.changedHandle.kind === "directory"
        ? new FileSystemDirectoryHandle(rec.changedHandle)
        : new FileSystemFileHandle(rec.changedHandle);
    const record = {
      type: rec.type,
      changedHandle: handle,
      relativePathComponents: rec.relativePathComponents,
      relativePathMovedFrom: rec.relativePathMovedFrom ?? null,
    };
    try {
      cb([record], _observerInstances.get(payload.mid));
    } catch (_) {}
  };

  const _observerInstances = new Map();

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      const id = _nextId++;
      _pending.set(id, { resolve, reject });
      window.webkit.messageHandlers.widgetizrFS.postMessage(
        JSON.stringify({ id, method, args }),
      );
    });
  }

  // ── Handle lifetime registry ───────────────────────────────────────────────

  const _handleRegistry = new FinalizationRegistry((hid) => {
    call("closeHandle", { hid });
  });

  // ── FileSystemWritableFileStream ───────────────────────────────────────────

  class FileSystemWritableFileStream extends WritableStream {
    constructor(wid) {
      super();
      this._wid = wid;
      this._closed = false;
    }

    async write(data) {
      if (this._closed)
        throw new DOMException("Stream is closed", "InvalidStateError");
      let bytes;
      if (typeof data === "string") {
        bytes = new TextEncoder().encode(data);
      } else if (data && typeof data === "object" && "type" in data) {
        if (data.type === "seek")
          throw new DOMException("seek not implemented", "NotSupportedError");
        if (data.type === "truncate")
          throw new DOMException(
            "truncate not implemented",
            "NotSupportedError",
          );
        if (data.type === "write") {
          if (data.position != null)
            throw new DOMException(
              "positional write not implemented",
              "NotSupportedError",
            );
          return this.write(data.data);
        }
        throw new TypeError("Unknown WriteParams type: " + data.type);
      } else if (data instanceof Blob) {
        bytes = new Uint8Array(await data.arrayBuffer());
      } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        throw new TypeError("Unsupported data type passed to write()");
      }
      let _bin = "";
      const _chunk = 8192;
      for (let _i = 0; _i < bytes.length; _i += _chunk)
        _bin += String.fromCharCode(...bytes.subarray(_i, _i + _chunk));
      const b64 = btoa(_bin);
      await call("writableWrite", { wid: this._wid, base64: b64 });
    }

    async seek(_position) {
      throw new DOMException("seek not implemented", "NotSupportedError");
    }

    async truncate(_size) {
      throw new DOMException("truncate not implemented", "NotSupportedError");
    }

    async close() {
      if (this._closed)
        throw new DOMException("Stream is already closed", "InvalidStateError");
      await call("writableClose", { wid: this._wid });
      this._closed = true;
    }
  }

  // ── FileSystemHandle (base) ────────────────────────────────────────────────

  class FileSystemHandle {
    constructor({ kind, name, hid, persistentId }) {
      this.kind = kind;
      this.name = name;
      this._hid = hid;
      this._persistentId = persistentId ?? null;
      _handleRegistry.register(this, this._hid);
    }

    async isSameEntry(other) {
      return this._hid === other._hid;
    }

    async queryPermission(_descriptor) {
      return "granted";
    }

    async requestPermission(_descriptor) {
      return "granted";
    }
  }

  // ── FileSystemFileHandle ───────────────────────────────────────────────────

  class FileSystemFileHandle extends FileSystemHandle {
    constructor(init) {
      super({
        kind: "file",
        name: init.name,
        hid: init.hid,
        persistentId: init.persistentId,
      });
    }

    async getFile() {
      const { base64 } = await call("readFile", { hid: this._hid });
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], this.name);
    }

    async createWritable(_options) {
      const { wid } = await call("createWritable", { hid: this._hid });
      return new FileSystemWritableFileStream(wid);
    }

    async createSyncAccessHandle() {
      throw new DOMException(
        "createSyncAccessHandle not implemented — only available in Workers on OPFS",
        "NotSupportedError",
      );
    }
  }

  // ── FileSystemDirectoryHandle ──────────────────────────────────────────────

  class FileSystemDirectoryHandle extends FileSystemHandle {
    constructor(init) {
      super({
        kind: "directory",
        name: init.name,
        hid: init.hid,
        persistentId: init.persistentId,
      });
    }

    async getFileHandle(name, options = {}) {
      const result = await call("getFileHandle", {
        hid: this._hid,
        name,
        create: options.create ?? false,
      });
      return new FileSystemFileHandle(result);
    }

    async getDirectoryHandle(name, options = {}) {
      const result = await call("getDirHandle", {
        hid: this._hid,
        name,
        create: options.create ?? false,
      });
      return new FileSystemDirectoryHandle(result);
    }

    async removeEntry(name, options = {}) {
      await call("removeEntry", {
        hid: this._hid,
        name,
        recursive: options.recursive ?? false,
      });
    }

    async resolve(possibleDescendant) {
      throw new DOMException("resolve not implemented", "NotSupportedError");
    }

    async *entries() {
      const list = await call("dirEntries", { hid: this._hid });
      for (const e of list) {
        yield [
          e.name,
          e.kind === "directory"
            ? new FileSystemDirectoryHandle(e)
            : new FileSystemFileHandle(e),
        ];
      }
    }

    async *keys() {
      for await (const [name] of this.entries()) yield name;
    }

    async *values() {
      for await (const [, handle] of this.entries()) yield handle;
    }

    [Symbol.asyncIterator]() {
      return this.entries();
    }
  }

  // ── IDB interception ───────────────────────────────────────────────────────

  function _replaceHandles(v) {
    if (v instanceof FileSystemHandle) {
      return {
        __fsh: 1,
        persistentId: v._persistentId,
        kind: v.kind,
        name: v.name,
      };
    }
    if (
      v &&
      typeof v === "object" &&
      !ArrayBuffer.isView(v) &&
      !(v instanceof Blob)
    ) {
      if (Array.isArray(v)) return v.map(_replaceHandles);
      const out = {};
      for (const k of Object.keys(v)) out[k] = _replaceHandles(v[k]);
      return out;
    }
    return v;
  }

  const _origPut = IDBObjectStore.prototype.put;
  const _origAdd = IDBObjectStore.prototype.add;

  IDBObjectStore.prototype.put = function (value, key) {
    return arguments.length > 1
      ? _origPut.call(this, _replaceHandles(value), key)
      : _origPut.call(this, _replaceHandles(value));
  };

  IDBObjectStore.prototype.add = function (value, key) {
    return arguments.length > 1
      ? _origAdd.call(this, _replaceHandles(value), key)
      : _origAdd.call(this, _replaceHandles(value));
  };

  const _origGet = IDBObjectStore.prototype.get;

  IDBObjectStore.prototype.get = function (query) {
    const real = _origGet.call(this, query);
    const _ls = {};
    const fake = {
      result: undefined,
      error: null,
      source: this,
      readyState: "pending",
      onsuccess: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      addEventListener(type, fn) {
        (_ls[type] ??= []).push(fn);
      },
      removeEventListener(type, fn) {
        if (_ls[type]) _ls[type] = _ls[type].filter((f) => f !== fn);
      },
      dispatchEvent() {
        return true;
      },
    };
    function _fire(type) {
      fake.readyState = "done";
      const evt = { target: fake, currentTarget: fake };
      if (type === "success") {
        if (fake.onsuccess) fake.onsuccess(evt);
        if (fake.oncomplete) fake.oncomplete(evt);
      } else {
        if (fake.onerror) fake.onerror(evt);
        if (fake.onabort) fake.onabort(evt);
      }
      for (const fn of _ls[type] ?? []) fn(evt);
    }
    real.onsuccess = async function () {
      const v = real.result;
      if (v && v.__fsh && v.persistentId) {
        try {
          const desc = await call("rehydrateHandle", {
            persistentId: v.persistentId,
          });
          fake.result =
            v.kind === "directory"
              ? new FileSystemDirectoryHandle(desc)
              : new FileSystemFileHandle(desc);
        } catch (_) {
          fake.result = undefined;
        }
      } else {
        fake.result = v;
      }
      _fire("success");
    };
    real.onerror = function () {
      fake.error = real.error;
      _fire("error");
    };
    return fake;
  };

  // ── FileSystemSyncAccessHandle ─────────────────────────────────────────────

  class FileSystemSyncAccessHandle {
    read(_buffer, _options) {
      throw new DOMException(
        "FileSystemSyncAccessHandle not implemented — only available in Workers on OPFS",
        "NotSupportedError",
      );
    }
    write(_buffer, _options) {
      throw new DOMException(
        "FileSystemSyncAccessHandle not implemented — only available in Workers on OPFS",
        "NotSupportedError",
      );
    }
    truncate(_newSize) {
      throw new DOMException(
        "FileSystemSyncAccessHandle not implemented — only available in Workers on OPFS",
        "NotSupportedError",
      );
    }
    getSize() {
      throw new DOMException(
        "FileSystemSyncAccessHandle not implemented — only available in Workers on OPFS",
        "NotSupportedError",
      );
    }
    flush() {
      throw new DOMException(
        "FileSystemSyncAccessHandle not implemented — only available in Workers on OPFS",
        "NotSupportedError",
      );
    }
    close() {
      throw new DOMException(
        "FileSystemSyncAccessHandle not implemented — only available in Workers on OPFS",
        "NotSupportedError",
      );
    }
  }

  // ── FileSystemObserver ─────────────────────────────────────────────────────

  class FileSystemObserver {
    constructor(callback) {
      this._callback = callback;
      this._mids = new Set();
    }

    async observe(handle, options = {}) {
      const { mid } = await call("observe", {
        hid: handle._hid,
        recursive: options.recursive ?? false,
      });
      this._mids.add(mid);
      _observers.set(mid, this._callback);
      _observerInstances.set(mid, this);
    }

    unobserve(handle) {
      for (const mid of this._mids) {
        call("unobserve", { mid });
        _observers.delete(mid);
        _observerInstances.delete(mid);
        this._mids.delete(mid);
      }
    }

    disconnect() {
      for (const mid of this._mids) {
        call("unobserve", { mid });
        _observers.delete(mid);
        _observerInstances.delete(mid);
      }
      this._mids.clear();
    }
  }

  // ── DataTransferItem extension ─────────────────────────────────────────────

  if (typeof DataTransferItem !== "undefined") {
    DataTransferItem.prototype.getAsFileSystemHandle = async function () {
      throw new DOMException(
        "getAsFileSystemHandle not implemented",
        "NotSupportedError",
      );
    };
  }

  // ── Window pickers ─────────────────────────────────────────────────────────

  window.showOpenFilePicker = async function (options = {}) {
    const handles = await call("showOpenFilePicker", options);
    return handles.map(function (h) {
      return new FileSystemFileHandle(h);
    });
  };

  window.showSaveFilePicker = async function (options = {}) {
    const h = await call("showSaveFilePicker", options);
    return new FileSystemFileHandle(h);
  };

  window.showDirectoryPicker = async function (options = {}) {
    const h = await call("showDirectoryPicker", options);
    return new FileSystemDirectoryHandle(h);
  };

  window.FileSystemHandle = FileSystemHandle;
  window.FileSystemFileHandle = FileSystemFileHandle;
  window.FileSystemDirectoryHandle = FileSystemDirectoryHandle;
  window.FileSystemWritableFileStream = FileSystemWritableFileStream;
  window.FileSystemSyncAccessHandle = FileSystemSyncAccessHandle;
  window.FileSystemObserver = FileSystemObserver;
})();
