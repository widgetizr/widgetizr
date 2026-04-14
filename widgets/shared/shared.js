"use strict";

let __widgetDialogPromise = null;

function uid() {
  return crypto.randomUUID();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtHms(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function fmtShort(ms) {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h === 0) return `${rm}m`;
  return `${h}h ${pad(rm)}m`;
}

function fmtRelative(ts, opts) {
  const seconds = opts && opts.seconds;
  const days = opts && opts.days;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (seconds && s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return days
    ? new Date(ts).toLocaleDateString()
    : `${Math.floor(s / 86400)}d ago`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtBytes(bps) {
  if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(1) + " MB/s";
  if (bps >= 1_000) return (bps / 1_000).toFixed(1) + " KB/s";
  return bps + " B/s";
}

function makeIdb(dbName) {
  const STORE = "kv";
  let _db = null;
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE);
      r.onsuccess = (e) => {
        _db = e.target.result;
        res(_db);
      };
      r.onerror = () => rej(r.error);
    });
  }
  return {
    async get(key) {
      const db = await open();
      return new Promise((res, rej) => {
        const req = db.transaction(STORE).objectStore(STORE).get(key);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    },
    async set(key, val) {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },
    async del(key) {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },
  };
}

async function restoreHandle(idb, key, onGranted, onDenied) {
  let saved;
  try {
    saved = await idb.get(key);
  } catch {
    return;
  }
  if (!saved) return;
  try {
    const perm = await saved.queryPermission({ mode: "readwrite" });
    if (perm === "granted") {
      await onGranted(saved);
    } else if (perm === "prompt") {
      const result = await saved.requestPermission({ mode: "readwrite" });
      if (result === "granted") {
        await onGranted(saved);
      } else {
        await idb.del(key);
        await onDenied();
      }
    } else {
      await idb.del(key);
      await onDenied();
    }
  } catch (e) {
    console.error("restoreHandle:", e);
    await onDenied();
  }
}

function attachModalHandlers(overlayEl, closeFn) {
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) closeFn();
  });
}

function ensureWidgetDialogRoot() {
  let overlay = document.getElementById("widget-dialog-overlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "widget-dialog-overlay";
  overlay.innerHTML = `
    <div id="widget-dialog" role="dialog" aria-modal="true" aria-labelledby="widget-dialog-title">
      <h3 id="widget-dialog-title"></h3>
      <p id="widget-dialog-message"></p>
      <div class="widget-dialog-actions">
        <button id="widget-dialog-cancel" class="btn btn-secondary">Cancel</button>
        <button id="widget-dialog-ok" class="btn btn-primary">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && __widgetDialogPromise) {
      __widgetDialogPromise.resolve(false);
      __widgetDialogPromise = null;
      overlay.classList.remove("visible");
    }
  });

  const style = document.createElement("style");
  style.textContent = `
    #widget-dialog-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: var(--overlay);
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 16px;
    }
    #widget-dialog-overlay.visible {
      display: flex;
    }
    #widget-dialog {
      background: var(--surface);
      border: 1px solid var(--border-hi);
      border-radius: 10px;
      padding: 20px;
      width: min(320px, 100%);
      display: flex;
      flex-direction: column;
      gap: 14px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
    }
    #widget-dialog h3 {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      margin: 0;
    }
    #widget-dialog-message {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.5;
      margin: 0;
      white-space: pre-wrap;
    }
    .widget-dialog-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
  `;
  document.head.appendChild(style);

  return overlay;
}

function showWidgetDialog({
  title,
  message,
  confirmText,
  cancelText,
  showCancel,
}) {
  if (__widgetDialogPromise) return __widgetDialogPromise.promise;

  const overlay = ensureWidgetDialogRoot();
  const titleEl = document.getElementById("widget-dialog-title");
  const messageEl = document.getElementById("widget-dialog-message");
  const cancelBtn = document.getElementById("widget-dialog-cancel");
  const okBtn = document.getElementById("widget-dialog-ok");

  titleEl.textContent = title;
  messageEl.textContent = message;
  okBtn.textContent = confirmText || "OK";
  cancelBtn.textContent = cancelText || "Cancel";
  cancelBtn.style.display = showCancel ? "" : "none";

  __widgetDialogPromise = {};
  __widgetDialogPromise.promise = new Promise((resolve) => {
    __widgetDialogPromise.resolve = resolve;
  });

  const cleanup = () => {
    overlay.classList.remove("visible");
    okBtn.removeEventListener("click", onOk);
    cancelBtn.removeEventListener("click", onCancel);
    document.removeEventListener("keydown", onKeyDown);
    __widgetDialogPromise = null;
  };

  const onOk = () => {
    const pending = __widgetDialogPromise;
    cleanup();
    pending.resolve(true);
  };

  const onCancel = () => {
    const pending = __widgetDialogPromise;
    cleanup();
    pending.resolve(false);
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      onOk();
    }
  };

  okBtn.addEventListener("click", onOk);
  cancelBtn.addEventListener("click", onCancel);
  document.addEventListener("keydown", onKeyDown);
  overlay.classList.add("visible");
  okBtn.focus();

  return __widgetDialogPromise.promise;
}

async function showWidgetAlert(message, title = "Notice") {
  await showWidgetDialog({
    title,
    message,
    confirmText: "OK",
    showCancel: false,
  });
}

async function showWidgetConfirm(message, title = "Confirm") {
  return await showWidgetDialog({
    title,
    message,
    confirmText: "OK",
    cancelText: "Cancel",
    showCancel: true,
  });
}

async function observeFile(handle, handler) {
  if (typeof FileSystemObserver === "undefined") return null;
  const obs = new FileSystemObserver(handler);
  await obs.observe(handle);
  return obs;
}

function makeFileChangeHandler({
  onModified,
  onReconnect,
  onDisconnect,
  reconnectDelay = 600,
}) {
  let timer = null;
  return function (records) {
    for (const record of records) {
      if (
        record.type === "modified" ||
        record.type === "appeared" ||
        record.type === "moved"
      ) {
        onModified();
      } else if (record.type === "disappeared") {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            await onReconnect();
          } catch (_) {
            await onDisconnect();
          }
        }, reconnectDelay);
      }
    }
  };
}
