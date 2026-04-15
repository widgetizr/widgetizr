#!/usr/bin/env -S gjs -m

import GObject from "@girs/gobject-2.0";
import GLib from "@girs/glib-2.0";
import Gtk from "@girs/gtk-3.0";
import Gdk from "@girs/gdk-3.0";
import Gio from "@girs/gio-2.0";
import WebKit2 from "@girs/webkit2-4.1";

// @ts-expect-error
import POLYFILL_SOURCE from "./file-api-polyfill.js" with { type: "text" };

declare const POLYFILL_SOURCE: string;

const APP_VERSION = "1.0.1";
const WIDGETS_DIR = GLib.build_filenamev([
  GLib.get_user_data_dir(),
  "widgetizr",
  "widgets",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

interface WidgetConfig {
  id: string;
  title: string;
  headerBgColor: string;
  webviewUrl: string;
  width: number;
  height: number;
  posX: number;
  posY: number;
}

interface ConfigFile {
  widgets: WidgetConfig[];
  welcomeShown?: boolean;
  desktopConflictHandled?: boolean;
}

type PermissionDecision = "allow" | "deny";

interface PermissionRecord {
  decision: PermissionDecision;
  grantedAt: string;
}

type PermissionsFile = Record<string, PermissionRecord>;

interface WindowMemStats {
  id: string;
  url: string;
  fsHandles: number;
  fsWritables: number;
  fsMonitors: number;
  totalHandlesCreated: number;
  totalWritablesCreated: number;
}

const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  id: "",
  title: "Widgetizr Widget",
  headerBgColor: "#2c3e50",
  webviewUrl: "",
  width: 400,
  height: 300,
  posX: 100,
  posY: 100,
};

// ─── URL / origin helpers ─────────────────────────────────────────────────────

/**
 * Derives a stable, canonical origin key from a URL string.
 *
 *  - http / https  → scheme + host + port  (e.g. "https://widgetizr.app")
 *  - file://       → URL stripped of query / fragment
 *                    (each distinct file path is its own isolated origin)
 *  - blank / other → "__blank__"
 */
function deriveOrigin(url: string): string {
  const u = url.trim();
  if (!u) return "__blank__";

  if (u.startsWith("file://")) {
    const q = u.indexOf("?");
    const h = u.indexOf("#");
    let end = u.length;
    if (q !== -1) end = Math.min(end, q);
    if (h !== -1) end = Math.min(end, h);
    return u.slice(0, end);
  }

  const m = u.match(/^(https?:\/\/[^/?#]+)/);
  if (m) return m[1];

  return u;
}

function isSecureUri(uri: string): boolean {
  const u = uri.trim();
  if (u.startsWith("https://")) return true;
  if (u.startsWith("file://")) return true;
  if (u.startsWith("http://localhost/") || u === "http://localhost")
    return true;
  if (u.startsWith("http://localhost:")) return true;
  const localPattern =
    /^http:\/\/(127\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?(\/|$)/;
  return localPattern.test(u);
}

function normalizeUrl(raw: string): string {
  const u = raw.trim();
  if (!u) return u;
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(u)) return u;
  if (/^(file:|data:|about:)/i.test(u)) return u;
  const localPattern =
    /^(localhost|127\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?(\/|$)/i;
  return (localPattern.test(u) ? "http://" : "https://") + u;
}

/**
 * Returns a filesystem-safe, fixed-length token for an origin string.
 * Uses SHA-256 so collisions are not a practical concern.
 */
function originToStorageToken(origin: string): string {
  return (
    GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, origin, -1) ??
    origin.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 64)
  );
}

// ─── ConfigManager ────────────────────────────────────────────────────────────

class ConfigManager {
  readonly configDir: string;
  private readonly configPath: string;
  readonly storageBaseDir: string;

  constructor() {
    const userConfigDir = GLib.get_user_config_dir();
    this.configDir = GLib.build_filenamev([userConfigDir, "widgetizr"]);
    this.configPath = GLib.build_filenamev([this.configDir, "config-v1.json"]);
    this.storageBaseDir = GLib.build_filenamev([this.configDir, "storage"]);
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    GLib.mkdir_with_parents(this.configDir, 0o755);
    GLib.mkdir_with_parents(this.storageBaseDir, 0o755);
  }

  getStorageDirForOrigin(origin: string): string {
    const token = originToStorageToken(origin);
    const dir = GLib.build_filenamev([this.storageBaseDir, token]);
    GLib.mkdir_with_parents(dir, 0o755);
    return dir;
  }

  load(): ConfigFile {
    try {
      const file = Gio.File.new_for_path(this.configPath);
      if (!file.query_exists(null)) return { widgets: [] };
      const [ok, contents] = file.load_contents(null);
      if (!ok) return { widgets: [] };
      return JSON.parse(new TextDecoder().decode(contents)) as ConfigFile;
    } catch (e) {
      print(`Warning: Could not load config: ${e}`);
      return { widgets: [] };
    }
  }

  save(config: ConfigFile): void {
    try {
      const file = Gio.File.new_for_path(this.configPath);
      file.replace_contents(
        JSON.stringify(config, null, 2),
        null,
        false,
        Gio.FileCreateFlags.NONE,
        null,
      );
    } catch (e) {
      print(`Warning: Could not save config: ${e}`);
    }
  }
}

// ─── Foreign desktop-window detection ────────────────────────────────────────

interface ForeignDesktopWindow {
  xid: string;
  pid: number;
  processName: string;
  wmClass: string;
}

function runAndCapture(argv: string[]): string {
  try {
    const proc = Gio.Subprocess.new(
      argv,
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    );
    const [, stdout] = proc.communicate_utf8(null, null);
    return stdout ?? "";
  } catch (_e) {
    return "";
  }
}

function getProcessName(pid: number): string {
  try {
    const file = Gio.File.new_for_path(`/proc/${pid}/comm`);
    const [ok, bytes] = file.load_contents(null);
    if (ok) return new TextDecoder().decode(bytes).trim();
  } catch (_e) {}
  return `pid ${pid}`;
}

function findForeignDesktopWindows(): ForeignDesktopWindow[] {
  let ownPid = -1;
  try {
    const selfStatus = Gio.File.new_for_path("/proc/self/status");
    const [ok, bytes] = selfStatus.load_contents(null);
    if (ok) {
      const pidMatch = new TextDecoder().decode(bytes).match(/^Pid:\s+(\d+)/m);
      if (pidMatch) ownPid = parseInt(pidMatch[1]);
    }
  } catch (_e) {}
  const clientList = runAndCapture(["xprop", "-root", "_NET_CLIENT_LIST"]);
  const ids = clientList.match(/0x[0-9a-f]+/gi) ?? [];
  const results: ForeignDesktopWindow[] = [];
  const seenPids = new Set<number>();

  for (const id of ids) {
    const props = runAndCapture([
      "xprop",
      "-id",
      id,
      "_NET_WM_WINDOW_TYPE",
      "_NET_WM_PID",
      "WM_CLASS",
    ]);
    if (!props.includes("_NET_WM_WINDOW_TYPE_DESKTOP")) continue;

    const pidMatch = props.match(/_NET_WM_PID\(CARDINAL\) = (\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1]) : -1;
    if (pid === ownPid) continue;
    if (pid !== -1 && seenPids.has(pid)) continue;
    if (pid !== -1) seenPids.add(pid);

    const classMatch = props.match(/WM_CLASS\(STRING\) = "([^"]+)"/);
    const wmClass = classMatch ? classMatch[1] : "unknown";
    const processName = pid !== -1 ? getProcessName(pid) : wmClass;

    results.push({ xid: id, pid, processName, wmClass });
  }

  return results;
}

function isPidAlive(pid: number): boolean {
  try {
    const f = Gio.File.new_for_path(`/proc/${pid}/status`);
    const [ok] = f.load_contents(null);
    return ok;
  } catch (_) {
    return false;
  }
}

function scheduleReappearanceCheck(
  onReappeared: (reappeared: ForeignDesktopWindow[]) => void,
): void {
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
    const reappeared = findForeignDesktopWindows();
    if (reappeared.length > 0) {
      onReappeared(reappeared);
    }
    return GLib.SOURCE_REMOVE;
  });
}

function killForeignDesktopWindows(
  windows: ForeignDesktopWindow[],
  onReappeared: (reappeared: ForeignDesktopWindow[]) => void,
): void {
  const byPid = new Map<number, string>();
  for (const w of windows) {
    if (w.pid !== -1 && !byPid.has(w.pid)) {
      byPid.set(w.pid, w.processName ?? "");
    }
  }

  for (const [pid] of byPid) {
    try {
      Gio.Subprocess.new(
        ["kill", "-TERM", pid.toString()],
        Gio.SubprocessFlags.NONE,
      );
    } catch (e) {
      print(`Warning: could not SIGTERM pid ${pid}: ${e}`);
    }
  }

  const POLL_MS = 100;
  const DEADLINE_MS = 5000;
  let elapsed = 0;

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
    elapsed += POLL_MS;
    const stillAlive = [...byPid.keys()].filter(isPidAlive);

    if (stillAlive.length === 0) {
      scheduleReappearanceCheck(onReappeared);
      return GLib.SOURCE_REMOVE;
    }

    if (elapsed >= DEADLINE_MS) {
      for (const pid of stillAlive) {
        try {
          Gio.Subprocess.new(
            ["kill", "-KILL", pid.toString()],
            Gio.SubprocessFlags.NONE,
          );
        } catch (e) {
          print(`Warning: could not SIGKILL pid ${pid}: ${e}`);
        }
      }
      scheduleReappearanceCheck(onReappeared);
      return GLib.SOURCE_REMOVE;
    }

    return GLib.SOURCE_CONTINUE;
  });
}

// ─── DesktopConflictDialog ────────────────────────────────────────────────────

const CONFLICT_RESPONSE_KILL = 1;
const CONFLICT_RESPONSE_NEVER = 2;

function scheduleKillWithWatch(windows: ForeignDesktopWindow[]): void {
  killForeignDesktopWindows(windows, (reappeared) => {
    const dialog = new ProcessReappearedDialog(reappeared);
    const response = dialog.run();
    dialog.destroy();
    if (response === REAPPEAR_RESPONSE_KILL_AGAIN) {
      scheduleKillWithWatch(reappeared);
    }
  });
}

const DesktopConflictDialog = GObject.registerClass(
  { GTypeName: "DesktopConflictDialog" },
  class DesktopConflictDialog extends Gtk.Dialog {
    constructor(windows: ForeignDesktopWindow[]) {
      super({
        title: "Desktop Manager Conflict Detected",
        modal: true,
        destroy_with_parent: true,
      });

      this.set_default_size(500, -1);

      this.add_button("Never show again", CONFLICT_RESPONSE_NEVER);
      const killBtn = this.add_button(
        "Kill conflicting processes",
        CONFLICT_RESPONSE_KILL,
      ) as Gtk.Button;
      killBtn.get_style_context().add_class("suggested-action");
      this.set_default_response(CONFLICT_RESPONSE_KILL);

      const content = this.get_content_area();
      content.set_spacing(0);

      const bannerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
      });
      bannerBox.set_name("conflictBanner");
      const bannerCss = new Gtk.CssProvider();
      bannerCss.load_from_data(
        "#conflictBanner { background-color: #7d2c2c; padding: 20px 24px; }",
      );
      bannerBox
        .get_style_context()
        .add_provider(bannerCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      const bannerTitle = new Gtk.Label({
        label: "⚠️  Widget interaction may be blocked",
      });
      const bannerTitleCss = new Gtk.CssProvider();
      bannerTitleCss.load_from_data(
        "label { color: #f5c6c6; font-size: 16px; font-weight: bold; }",
      );
      bannerTitle
        .get_style_context()
        .add_provider(bannerTitleCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      const bannerSub = new Gtk.Label({
        label: "One or more other processes are managing the desktop layer.",
        xalign: 0,
        wrap: true,
      });
      const bannerSubCss = new Gtk.CssProvider();
      bannerSubCss.load_from_data("label { color: #e8a0a0; font-size: 12px; }");
      bannerSub
        .get_style_context()
        .add_provider(bannerSubCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      bannerBox.pack_start(bannerTitle, false, false, 0);
      bannerBox.pack_start(bannerSub, false, false, 2);
      content.pack_start(bannerBox, false, false, 0);

      const body = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 14,
        margin_start: 24,
        margin_end: 24,
        margin_top: 20,
        margin_bottom: 12,
      });

      const addPara = (text: string): void => {
        const lbl = new Gtk.Label({
          label: text,
          xalign: 0,
          wrap: true,
          max_width_chars: 60,
        });
        lbl.set_line_wrap(true);
        body.pack_start(lbl, false, false, 0);
      };

      addPara(
        "Widgetizr detected the following processes claiming the X11 desktop " +
          "layer (_NET_WM_WINDOW_TYPE_DESKTOP). They can intercept pointer events " +
          'and make your widgets unresponsive, especially after using "Show Desktop".',
      );

      const listBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
      });
      listBox.set_name("procList");
      const listCss = new Gtk.CssProvider();
      listCss.load_from_data(
        "#procList { background-color: #1a1a2e; border-radius: 6px; padding: 10px 14px; }",
      );
      listBox
        .get_style_context()
        .add_provider(listCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      for (const w of windows) {
        const lineLabel = new Gtk.Label({
          label:
            w.pid !== -1
              ? `${w.processName}  (pid ${w.pid})`
              : `${w.wmClass}  (window ${w.xid})`,
          xalign: 0,
          selectable: true,
        });
        const lineCss = new Gtk.CssProvider();
        lineCss.load_from_data(
          "label { color: #a8d8a0; font-family: monospace; font-size: 11px; }",
        );
        lineLabel
          .get_style_context()
          .add_provider(lineCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        listBox.pack_start(lineLabel, false, false, 0);
      }
      body.pack_start(listBox, false, false, 0);

      addPara(
        'Clicking "Kill conflicting processes" will resolve each conflict. ' +
          "Close this dialog to skip for now — it will appear again on the next launch.",
      );

      content.pack_start(body, true, true, 0);
      this.show_all();
    }
  },
);

// ─── ProcessReappearedDialog ──────────────────────────────────────────────────

const REAPPEAR_RESPONSE_KILL_AGAIN = 1;
const REAPPEAR_RESPONSE_DISMISS = 2;

const ProcessReappearedDialog = GObject.registerClass(
  { GTypeName: "ProcessReappearedDialog" },
  class ProcessReappearedDialog extends Gtk.Dialog {
    constructor(windows: ForeignDesktopWindow[]) {
      super({
        title: "Desktop Processes Came Back",
        modal: true,
        destroy_with_parent: true,
      });

      this.set_default_size(520, -1);

      this.add_button("Dismiss", REAPPEAR_RESPONSE_DISMISS);
      const killBtn = this.add_button(
        "Kill again",
        REAPPEAR_RESPONSE_KILL_AGAIN,
      ) as Gtk.Button;
      killBtn.get_style_context().add_class("suggested-action");
      this.set_default_response(REAPPEAR_RESPONSE_KILL_AGAIN);

      const content = this.get_content_area();
      content.set_spacing(0);

      const bannerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
      });
      bannerBox.set_name("reappearedBanner");
      const bannerCss = new Gtk.CssProvider();
      bannerCss.load_from_data(
        "#reappearedBanner { background-color: #7d5a1a; padding: 20px 24px; }",
      );
      bannerBox
        .get_style_context()
        .add_provider(bannerCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      const bannerTitle = new Gtk.Label({
        label: "⚠️  Killed processes reappeared",
      });
      const bannerTitleCss = new Gtk.CssProvider();
      bannerTitleCss.load_from_data(
        "label { color: #f5e0b0; font-size: 16px; font-weight: bold; }",
      );
      bannerTitle
        .get_style_context()
        .add_provider(bannerTitleCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      const bannerSub = new Gtk.Label({
        label: "A process supervisor may be restarting them automatically.",
        xalign: 0,
        wrap: true,
      });
      const bannerSubCss = new Gtk.CssProvider();
      bannerSubCss.load_from_data("label { color: #e8c870; font-size: 12px; }");
      bannerSub
        .get_style_context()
        .add_provider(bannerSubCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      bannerBox.pack_start(bannerTitle, false, false, 0);
      bannerBox.pack_start(bannerSub, false, false, 2);
      content.pack_start(bannerBox, false, false, 0);

      const body = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 14,
        margin_start: 24,
        margin_end: 24,
        margin_top: 20,
        margin_bottom: 12,
      });

      const addPara = (text: string): void => {
        const lbl = new Gtk.Label({
          label: text,
          xalign: 0,
          wrap: true,
          max_width_chars: 62,
        });
        lbl.set_line_wrap(true);
        body.pack_start(lbl, false, false, 0);
      };

      addPara("The following processes were killed but came back:");

      const listBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
      });
      listBox.set_name("reappearedList");
      const listCss = new Gtk.CssProvider();
      listCss.load_from_data(
        "#reappearedList { background-color: #1a1a2e; border-radius: 6px; padding: 10px 14px; }",
      );
      listBox
        .get_style_context()
        .add_provider(listCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      for (const w of windows) {
        const lineLabel = new Gtk.Label({
          label:
            w.pid !== -1
              ? `${w.processName}  (pid ${w.pid})`
              : `${w.wmClass}  (window ${w.xid})`,
          xalign: 0,
          selectable: true,
        });
        const lineCss = new Gtk.CssProvider();
        lineCss.load_from_data(
          "label { color: #a8d8a0; font-family: monospace; font-size: 11px; }",
        );
        lineLabel
          .get_style_context()
          .add_provider(lineCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        listBox.pack_start(lineLabel, false, false, 0);
      }
      body.pack_start(listBox, false, false, 0);

      addPara(
        "Killing again sometimes helps — occasionally a second kill succeeds " +
          "where the first did not.",
      );

      addPara(
        "If they keep coming back no matter what, please open an issue and " +
          "include your desktop environment (e.g. KDE, XFCE), OS and distro, " +
          "and the process names listed above. If you already know the cause " +
          "or fix, please share that too!",
      );

      const ghLink = new Gtk.LinkButton({
        uri: "https://github.com/widgetizr/widgetizr/issues",
        label: "Open an issue at github.com/widgetizr/widgetizr →",
      });
      body.pack_start(ghLink, false, false, 0);

      content.pack_start(body, true, true, 0);
      this.show_all();
    }
  },
);

// ─── PermissionStore ──────────────────────────────────────────────────────────

/**
 * Persists per-origin permission decisions to
 * ~/.config/widgetizr/permissions.json.
 *
 * Keys are "origin::permission-type" strings so that different permissions for
 * the same origin are stored independently and can be individually revoked.
 */
class PermissionStore {
  private readonly path: string;
  private data: PermissionsFile = {};

  constructor(configDir: string) {
    this.path = GLib.build_filenamev([configDir, "permissions.json"]);
    this.load();
  }

  private load(): void {
    try {
      const file = Gio.File.new_for_path(this.path);
      if (!file.query_exists(null)) return;
      const [ok, contents] = file.load_contents(null);
      if (!ok) return;
      this.data = JSON.parse(
        new TextDecoder().decode(contents),
      ) as PermissionsFile;
    } catch (e) {
      print(`Warning: Could not load permissions store: ${e}`);
    }
  }

  private persist(): void {
    try {
      const file = Gio.File.new_for_path(this.path);
      file.replace_contents(
        JSON.stringify(this.data, null, 2),
        null,
        false,
        Gio.FileCreateFlags.NONE,
        null,
      );
    } catch (e) {
      print(`Warning: Could not save permissions store: ${e}`);
    }
  }

  private key(origin: string, permType: string): string {
    return `${origin}::${permType}`;
  }

  get(origin: string, permType: string): PermissionDecision | null {
    return this.data[this.key(origin, permType)]?.decision ?? null;
  }

  set(origin: string, permType: string, decision: PermissionDecision): void {
    this.data[this.key(origin, permType)] = {
      decision,
      grantedAt: new Date().toISOString(),
    };
    this.persist();
  }

  revoke(origin: string, permType: string): void {
    delete this.data[this.key(origin, permType)];
    this.persist();
  }
}

interface FsGrant {
  kind: "file" | "dir";
  path: string;
  grantedAt: string;
}

class FsPersistentHandleStore {
  private readonly path: string;
  private data: { [origin: string]: { [persistentId: string]: FsGrant } } = {};

  constructor(configDir: string) {
    this.path = GLib.build_filenamev([configDir, "fs-handles.json"]);
    this.load();
  }

  private load(): void {
    try {
      const file = Gio.File.new_for_path(this.path);
      if (!file.query_exists(null)) return;
      const [ok, contents] = file.load_contents(null);
      if (!ok) return;
      this.data = JSON.parse(new TextDecoder().decode(contents));
    } catch (e) {
      print(`Warning: Could not load fs handle store: ${e}`);
    }
  }

  private persist(): void {
    try {
      const file = Gio.File.new_for_path(this.path);
      file.replace_contents(
        JSON.stringify(this.data, null, 2),
        null,
        false,
        Gio.FileCreateFlags.NONE,
        null,
      );
    } catch (e) {
      print(`Warning: Could not save fs handle store: ${e}`);
    }
  }

  grant(
    origin: string,
    persistentId: string,
    kind: "file" | "dir",
    path: string,
  ): void {
    if (!this.data[origin]) this.data[origin] = {};
    this.data[origin][persistentId] = {
      kind,
      path,
      grantedAt: new Date().toISOString(),
    };
    this.persist();
  }

  redeem(origin: string, persistentId: string): FsGrant | null {
    return this.data[origin]?.[persistentId] ?? null;
  }
}

// ─── OriginContextRegistry ────────────────────────────────────────────────────

/**
 * Maintains a 1-to-1 mapping of origin → { WebsiteDataManager, WebContext }.
 *
 * Widgets that share the same origin therefore share the same WebKit storage
 * (localStorage, IndexedDB, cookies, service-worker registrations).  This is
 * intentional: signing in to widgetizr.app once makes the session available in
 * every widgetizr.app widget simultaneously.
 *
 * Storage is located at:
 *   ~/.config/widgetizr/storage/<sha256(origin)>/
 *   ~/.config/widgetizr/storage/<sha256(origin)>/cache/
 */
class OriginContextRegistry {
  private readonly entries = new Map<
    string,
    { dataManager: WebKit2.WebsiteDataManager; context: WebKit2.WebContext }
  >();

  constructor(private readonly configManager: ConfigManager) {}

  getContextForOrigin(origin: string): WebKit2.WebContext {
    const existing = this.entries.get(origin);
    if (existing) return existing.context;

    const storageDir = this.configManager.getStorageDirForOrigin(origin);
    const cacheDir = GLib.build_filenamev([storageDir, "cache"]);
    GLib.mkdir_with_parents(cacheDir, 0o755);

    const dataManager = new WebKit2.WebsiteDataManager({
      base_data_directory: storageDir,
      base_cache_directory: cacheDir,
    });

    const context = new WebKit2.WebContext({
      website_data_manager: dataManager,
    });

    context.set_cache_model(WebKit2.CacheModel.DOCUMENT_BROWSER);

    const cookieManager = context.get_cookie_manager();
    const cookiePath = GLib.build_filenamev([storageDir, "cookies.sqlite"]);
    cookieManager.set_persistent_storage(
      cookiePath,
      WebKit2.CookiePersistentStorage.SQLITE,
    );
    cookieManager.set_accept_policy(WebKit2.CookieAcceptPolicy.ALWAYS);

    this.entries.set(origin, { dataManager, context });
    return context;
  }

  entryCount(): number {
    return this.entries.size;
  }
}

// ─── Wayland / session-type guard ─────────────────────────────────────────────

function checkSessionType(): boolean {
  const sessionType = GLib.getenv("XDG_SESSION_TYPE");
  if (sessionType === "x11") return true;

  const dialog = new Gtk.MessageDialog({
    message_type: Gtk.MessageType.WARNING,
    buttons: Gtk.ButtonsType.OK,
    text: "Wayland is not supported",
    secondary_text:
      "Widgetizr currently supports X11 sessions only.\n\n" +
      `Detected XDG_SESSION_TYPE = "${sessionType ?? "unset"}".\n\n` +
      "Please log into an X11 session to use Widgetizr.",
  });
  dialog.set_title("Unsupported Display Server");
  dialog.run();
  dialog.destroy();
  return false;
}

// ─── WelcomeDialog ────────────────────────────────────────────────────────────

const WelcomeDialog = GObject.registerClass(
  { GTypeName: "WelcomeDialog" },
  class WelcomeDialog extends Gtk.Dialog {
    constructor() {
      super({
        title: "Welcome to Widgetizr",
        modal: true,
        destroy_with_parent: true,
      });

      this.set_default_size(540, 460);

      const getStartedBtn = this.add_button(
        "Get Started",
        Gtk.ResponseType.OK,
      ) as Gtk.Button;
      getStartedBtn.get_style_context().add_class("suggested-action");

      const content = this.get_content_area();
      content.set_spacing(0);

      const bannerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
      });
      bannerBox.set_name("welcomeBanner");

      const bannerCss = new Gtk.CssProvider();
      bannerCss.load_from_data(
        "#welcomeBanner { background-color: #2c3e50; padding: 28px 24px; }",
      );
      bannerBox
        .get_style_context()
        .add_provider(bannerCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      const appTitle = new Gtk.Label({ label: "🖥️  Widgetizr" });
      const appTitleCss = new Gtk.CssProvider();
      appTitleCss.load_from_data(
        "label { color: #ecf0f1; font-size: 26px; font-weight: bold; }",
      );
      appTitle
        .get_style_context()
        .add_provider(appTitleCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      const appSubtitle = new Gtk.Label({
        label: "Beautiful web widgets, pinned to your desktop",
      });
      const appSubtitleCss = new Gtk.CssProvider();
      appSubtitleCss.load_from_data(
        "label { color: #95a5a6; font-size: 13px; }",
      );
      appSubtitle
        .get_style_context()
        .add_provider(appSubtitleCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      bannerBox.pack_start(appTitle, false, false, 0);
      bannerBox.pack_start(appSubtitle, false, false, 4);
      content.pack_start(bannerBox, false, false, 0);

      const bodyBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 18,
        margin_start: 24,
        margin_end: 24,
        margin_top: 22,
        margin_bottom: 10,
      });

      const addSection = (
        icon: string,
        heading: string,
        body: string,
      ): void => {
        const row = new Gtk.Box({
          orientation: Gtk.Orientation.HORIZONTAL,
          spacing: 14,
        });

        const iconLabel = new Gtk.Label({ label: icon });
        const iconCss = new Gtk.CssProvider();
        iconCss.load_from_data("label { font-size: 28px; }");
        iconLabel
          .get_style_context()
          .add_provider(iconCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        iconLabel.set_valign(Gtk.Align.START);

        const textBox = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 3,
        });

        const headLabel = new Gtk.Label({ label: heading, xalign: 0 });
        const headCss = new Gtk.CssProvider();
        headCss.load_from_data("label { font-weight: bold; font-size: 13px; }");
        headLabel
          .get_style_context()
          .add_provider(headCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        const bodyLabel = new Gtk.Label({
          label: body,
          xalign: 0,
          wrap: true,
          max_width_chars: 58,
        });
        bodyLabel.set_line_wrap(true);

        textBox.pack_start(headLabel, false, false, 0);
        textBox.pack_start(bodyLabel, false, false, 0);
        row.pack_start(iconLabel, false, false, 0);
        row.pack_start(textBox, true, true, 0);
        bodyBox.pack_start(row, false, false, 0);
      };

      addSection(
        "📂",
        "Clear your desktop first",
        "For the best experience, move any files off your desktop or disable " +
          '"Show Files on Desktop" in your file manager. Files shown on the ' +
          "desktop can appear on top of your widgets and block interaction.",
      );

      addSection(
        "🪄",
        "Widgets live behind all other windows",
        "Each widget is pinned to the desktop background via X11 hints — no " +
          "taskbar entry, no window decoration. Drag the coloured header bar " +
          "to reposition a widget anywhere on screen.",
      );

      addSection(
        "⚙️",
        "Use any URL or choose an included widget",
        "Open the settings gear (⚙) on a widget and either paste any " +
          "http/https/file URL or choose one of the included widgets from " +
          "the Built-in widget dropdown. Widgetizr remembers every widget's " +
          "position, size and settings between restarts.",
      );

      addSection(
        "➕",
        "Add as many widgets as you like",
        "Click the + button on any widget header to create another one. " +
          "You can mix included widgets with your own URLs and arrange them " +
          "freely across the desktop.",
      );

      content.pack_start(bodyBox, true, true, 0);
      this.show_all();
    }
  },
);

// ─── SettingsDialog ───────────────────────────────────────────────────────────

const SettingsDialog = GObject.registerClass(
  { GTypeName: "SettingsDialog" },
  class SettingsDialog extends Gtk.Dialog {
    private titleEntry!: Gtk.Entry;
    private colorButton!: Gtk.ColorButton;
    private urlEntry!: Gtk.Entry;
    private builtInCombo!: Gtk.ComboBoxText;

    constructor(parent: Gtk.Window, current: WidgetConfig) {
      super({
        title: "Widget Settings",
        transient_for: parent,
        modal: true,
        destroy_with_parent: true,
      });

      this.set_default_size(420, -1);

      const saveBtn = this.add_button(
        "Save",
        Gtk.ResponseType.OK,
      ) as Gtk.Button;
      saveBtn.get_style_context().add_class("suggested-action");
      this.add_button("Cancel", Gtk.ResponseType.CANCEL);

      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        margin_start: 18,
        margin_end: 18,
        margin_top: 16,
        margin_bottom: 8,
      });

      const titleLabel = new Gtk.Label({ label: "Widget title", xalign: 0 });
      this.titleEntry = new Gtk.Entry();
      this.titleEntry.set_text(current.title);

      const colorLabel = new Gtk.Label({
        label: "Header colour",
        xalign: 0,
      });
      colorLabel.set_margin_top(6);
      const rgba = new Gdk.RGBA();
      rgba.parse(current.headerBgColor);
      this.colorButton = new Gtk.ColorButton({ rgba });

      const builtInLabel = new Gtk.Label({
        label: "Built-in widget",
        xalign: 0,
      });
      builtInLabel.set_margin_top(6);

      this.builtInCombo = new Gtk.ComboBoxText();
      this.builtInCombo.append("custom", "Custom URL");
      this.builtInCombo.append("clock", "Clock");
      this.builtInCombo.append("todo", "Todo");
      this.builtInCombo.append("notes", "Notes");
      this.builtInCombo.append("time-tracker", "Time Tracker");
      this.builtInCombo.append("server-monitor", "Server Monitor");
      this.builtInCombo.set_active_id("custom");

      const toFileUrl = (name: string): string =>
        GLib.filename_to_uri(
          GLib.build_filenamev([WIDGETS_DIR, name, "index.html"]),
          null,
        );

      const builtInMap: Record<string, string> = {
        clock: toFileUrl("clock"),
        todo: toFileUrl("todo"),
        notes: toFileUrl("notes"),
        "time-tracker": toFileUrl("time-tracker"),
        "server-monitor": toFileUrl("server-monitor"),
      };

      const currentUrl = normalizeUrl(current.webviewUrl);
      const matched = Object.entries(builtInMap).find(
        ([, v]) => v === currentUrl,
      );
      if (matched) this.builtInCombo.set_active_id(matched[0]);

      const urlLabel = new Gtk.Label({ label: "Widget URL", xalign: 0 });
      urlLabel.set_margin_top(6);
      this.urlEntry = new Gtk.Entry();
      this.urlEntry.set_text(current.webviewUrl);
      this.urlEntry.set_placeholder_text("https://…");

      this.builtInCombo.connect("changed", () => {
        const id = this.builtInCombo.get_active_id() ?? "custom";
        if (id === "custom") return;
        const selectedUrl = builtInMap[id];
        if (selectedUrl) {
          this.urlEntry.set_text(selectedUrl);
        }
      });

      box.pack_start(titleLabel, false, false, 0);
      box.pack_start(this.titleEntry, false, false, 0);
      box.pack_start(colorLabel, false, false, 0);
      box.pack_start(this.colorButton, false, false, 0);
      box.pack_start(builtInLabel, false, false, 0);
      box.pack_start(this.builtInCombo, false, false, 0);
      box.pack_start(urlLabel, false, false, 0);
      box.pack_start(this.urlEntry, false, false, 0);

      const contentArea = this.get_content_area();
      contentArea.pack_start(box, true, true, 0);
      this.show_all();
    }

    get_config(): Partial<WidgetConfig> {
      const rgba = this.colorButton.get_rgba();
      const url = this.urlEntry.get_text().trim();
      return {
        title: this.titleEntry.get_text().trim() || "Widgetizr Widget",
        headerBgColor: `rgb(${Math.round(rgba.red * 255)},${Math.round(rgba.green * 255)},${Math.round(rgba.blue * 255)})`,
        webviewUrl: url.startsWith("file://") ? url : normalizeUrl(url),
      };
    }
  },
);

// ─── WidgetManager ────────────────────────────────────────────────────────────

interface IWidgetWindow {
  openSettings(): void;
  getConfig(): WidgetConfig;
  getMemStats(): WindowMemStats;
  show_all(): void;
  connect(signal: string, callback: (...args: unknown[]) => unknown): number;
  destroy(): void;
}

class WidgetManager {
  private readonly windows: Map<string, IWidgetWindow> = new Map();
  readonly configManager: ConfigManager;
  readonly permissionStore: PermissionStore;
  readonly fsHandleStore: FsPersistentHandleStore;
  readonly originRegistry: OriginContextRegistry;
  private liveConfig: ConfigFile;

  constructor() {
    this.configManager = new ConfigManager();
    this.permissionStore = new PermissionStore(this.configManager.configDir);
    this.fsHandleStore = new FsPersistentHandleStore(
      this.configManager.configDir,
    );
    this.originRegistry = new OriginContextRegistry(this.configManager);
    this.liveConfig = this.configManager.load();
  }

  getConfig(): ConfigFile {
    return this.liveConfig;
  }

  markWelcomeShown(): void {
    this.liveConfig.welcomeShown = true;
    this.configManager.save(this.liveConfig);
  }

  markDesktopConflictHandled(): void {
    this.liveConfig.desktopConflictHandled = true;
    this.configManager.save(this.liveConfig);
  }

  loadAndCreateWidgets(): void {
    if (this.liveConfig.widgets.length === 0) {
      this.createNewWidget(true);
    } else {
      for (const wc of this.liveConfig.widgets) {
        this.createWidgetWindow(wc);
      }
    }
  }

  createNewWidget(openSettings = false): void {
    const id = generateId();
    const newConfig: WidgetConfig = { ...DEFAULT_WIDGET_CONFIG, id };
    const win = this.createWidgetWindow(newConfig);
    if (openSettings) {
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        win.openSettings();
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  createWidgetWindow(config: WidgetConfig): IWidgetWindow {
    const win = new WidgetWindow(config, this);
    this.windows.set(config.id, win);
    win.connect("destroy", () => {
      this.windows.delete(config.id);
      this.saveAll();
      if (this.windows.size === 0) Gtk.main_quit();
    });
    win.show_all();
    return win;
  }

  saveAll(): void {
    this.liveConfig.widgets = Array.from(this.windows.values()).map((w) =>
      w.getConfig(),
    );
    this.configManager.save(this.liveConfig);
  }

  getMemStats(): WindowMemStats[] {
    return Array.from(this.windows.values()).map((w) => w.getMemStats());
  }
}

// ─── Permission helpers ───────────────────────────────────────────────────────

type PermissionType =
  | "geolocation"
  | "notifications"
  | "media-capture-video"
  | "media-capture-audio"
  | "media-capture-av"
  | "pointer-lock"
  | "clipboard"
  | "device-info"
  | "media-plugins"
  | "drm-media-keys"
  | "website-data-access"
  | "xr"
  | "unknown";

interface PermissionMeta {
  type: PermissionType;
  label: string;
  description: string;
  icon: string;
}

function classifyPermissionRequest(
  request: WebKit2.PermissionRequest,
): PermissionMeta {
  if (request instanceof WebKit2.GeolocationPermissionRequest) {
    return {
      type: "geolocation",
      label: "Location access",
      description: "wants to know your current location.",
      icon: "📍",
    };
  }

  if (request instanceof WebKit2.NotificationPermissionRequest) {
    return {
      type: "notifications",
      label: "Notifications",
      description: "wants to show desktop notifications.",
      icon: "🔔",
    };
  }

  if (request instanceof WebKit2.UserMediaPermissionRequest) {
    const video = request.is_for_video_device;
    const audio = request.is_for_audio_device;
    if (video && audio) {
      return {
        type: "media-capture-av",
        label: "Camera & Microphone",
        description: "wants to access your camera and microphone.",
        icon: "📷",
      };
    }
    if (video) {
      return {
        type: "media-capture-video",
        label: "Camera",
        description: "wants to access your camera.",
        icon: "📷",
      };
    }
    return {
      type: "media-capture-audio",
      label: "Microphone",
      description: "wants to access your microphone.",
      icon: "🎙️",
    };
  }

  if (request instanceof WebKit2.PointerLockPermissionRequest) {
    return {
      type: "pointer-lock",
      label: "Pointer capture",
      description: "wants to capture and lock your mouse pointer.",
      icon: "🖱️",
    };
  }

  if (request instanceof WebKit2.ClipboardPermissionRequest) {
    return {
      type: "clipboard",
      label: "Clipboard access",
      description: "wants to read your clipboard.",
      icon: "📋",
    };
  }

  if (request instanceof WebKit2.DeviceInfoPermissionRequest) {
    return {
      type: "device-info",
      label: "Device info",
      description:
        "wants to enumerate your media devices (cameras, microphones).",
      icon: "ℹ️",
    };
  }

  if (request instanceof WebKit2.InstallMissingMediaPluginsPermissionRequest) {
    return {
      type: "media-plugins",
      label: "Install media plugins",
      description: "wants to install missing media plugins.",
      icon: "🔌",
    };
  }

  if (request instanceof WebKit2.MediaKeySystemPermissionRequest) {
    return {
      type: "drm-media-keys",
      label: "DRM media playback",
      description: "wants to play DRM-protected media.",
      icon: "🔒",
    };
  }

  if (request instanceof WebKit2.WebsiteDataAccessPermissionRequest) {
    return {
      type: "website-data-access",
      label: "Cross-site data access",
      description: `(${request.get_requesting_domain()}) wants to access its stored data while you visit ${request.get_current_domain()}.`,
      icon: "🌐",
    };
  }

  if (request instanceof WebKit2.XRPermissionRequest) {
    return {
      type: "xr",
      label: "VR / AR access",
      description: "wants to access virtual or augmented reality features.",
      icon: "🥽",
    };
  }

  return {
    type: "unknown",
    label: "Browser permission",
    description: "is requesting a browser permission.",
    icon: "❓",
  };
}

/**
 * Shows a blocking GTK permission dialog.  Returns the user's decision.
 * The dialog is parented to `parent` so it floats correctly above the widget.
 */
function promptPermission(
  parent: Gtk.Window,
  widgetTitle: string,
  origin: string,
  meta: PermissionMeta,
): PermissionDecision {
  const dialog = new Gtk.MessageDialog({
    transient_for: parent,
    modal: true,
    destroy_with_parent: true,
    message_type: Gtk.MessageType.QUESTION,
    buttons: Gtk.ButtonsType.NONE,
    text: `${meta.icon}  Allow ${meta.label}?`,
    secondary_text: `"${widgetTitle}" (${origin}) ${meta.description}`,
  });

  dialog.add_button("Deny", Gtk.ResponseType.NO);
  const allowBtn = dialog.add_button("Allow", Gtk.ResponseType.YES);
  allowBtn.get_style_context().add_class("suggested-action");
  dialog.set_default_response(Gtk.ResponseType.NO);

  const response = dialog.run();
  dialog.destroy();

  return response === Gtk.ResponseType.YES ? "allow" : "deny";
}

// ─── WidgetWindow ─────────────────────────────────────────────────────────────

const WidgetWindow = GObject.registerClass(
  { GTypeName: "WidgetWindow" },
  class WidgetWindow extends Gtk.Window {
    private webView!: WebKit2.WebView;
    private headerBar!: Gtk.HeaderBar;
    private mainBox!: Gtk.Box;
    private config: WidgetConfig;
    private manager: WidgetManager;
    private isDragging = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private windowStartX = 0;
    private windowStartY = 0;
    private isResizing = false;
    private resizeStartX = 0;
    private resizeStartY = 0;
    private resizeStartW = 0;
    private resizeStartH = 0;
    private static readonly RESIZE_GRIP = 16;
    private static readonly MIN_WIDTH = 120;
    private static readonly MIN_HEIGHT = 80;

    private fsHandles = new Map<
      string,
      { kind: "file" | "dir"; path: string; root: string | null }
    >();
    private fsHandleCounter = 0;
    private fsWritables = new Map<
      string,
      { destPath: string; chunks: Uint8Array[] }
    >();
    private fsWritableCounter = 0;
    private fsMonitors = new Map<string, Gio.FileMonitor>();
    private fsMonitorCounter = 0;

    constructor(config: WidgetConfig, manager: WidgetManager) {
      super();
      this.config = config;
      this.manager = manager;

      this.set_default_size(this.config.width, this.config.height);
      this.move(this.config.posX, this.config.posY);

      this.setupX11Hints();
      this.buildUI();
      this.applyConfig();
      this.connect("destroy", () => this.cleanupFSMonitors());
    }

    // ── X11 desktop hints ─────────────────────────────────────────────────

    setupX11Hints(): void {
      this.set_type_hint(Gdk.WindowTypeHint.DESKTOP);
      this.stick();
      this.set_skip_taskbar_hint(true);
      this.set_skip_pager_hint(true);
      this.set_decorated(false);

      const screen = this.get_screen();
      const visual = screen.get_rgba_visual();
      if (visual) this.set_visual(visual);
      this.set_app_paintable(true);
    }

    // ── UI construction ───────────────────────────────────────────────────

    buildUI(): void {
      this.mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
      });

      const overlay = new Gtk.Overlay();
      overlay.add(this.mainBox);

      this.headerBar = new Gtk.HeaderBar();
      this.headerBar.set_show_close_button(false);

      const closeBtn = new Gtk.Button({
        image: new Gtk.Image({ icon_name: "window-close-symbolic" }),
        relief: Gtk.ReliefStyle.NONE,
        tooltip_text: "Remove this widget",
      });
      closeBtn.connect("clicked", () => this.destroy());
      this.headerBar.pack_start(closeBtn);

      const reloadBtn = new Gtk.Button({
        image: new Gtk.Image({ icon_name: "view-refresh-symbolic" }),
        relief: Gtk.ReliefStyle.NONE,
        tooltip_text: "Reload widget",
      });
      reloadBtn.connect("clicked", () => this.webView.reload());
      this.headerBar.pack_start(reloadBtn);

      const newWidgetBtn = new Gtk.Button({
        image: new Gtk.Image({ icon_name: "list-add-symbolic" }),
        relief: Gtk.ReliefStyle.NONE,
        tooltip_text: "Add a new widget",
      });
      newWidgetBtn.connect("clicked", () => this.manager.createNewWidget(true));
      this.headerBar.pack_end(newWidgetBtn);

      const settingsBtn = new Gtk.Button({
        image: new Gtk.Image({ icon_name: "preferences-system-symbolic" }),
        relief: Gtk.ReliefStyle.NONE,
        tooltip_text: "Widget settings",
      });
      settingsBtn.connect("clicked", () => this.openSettings());
      this.headerBar.pack_end(settingsBtn);

      const headerEventBox = new Gtk.EventBox();
      headerEventBox.add(this.headerBar);
      headerEventBox.set_above_child(false);
      headerEventBox.set_events(
        Gdk.EventMask.BUTTON_PRESS_MASK |
          Gdk.EventMask.BUTTON_RELEASE_MASK |
          Gdk.EventMask.POINTER_MOTION_MASK,
      );

      headerEventBox.connect("button-press-event", (_w, event) => {
        const gdkWin = this.get_window();
        if (gdkWin) gdkWin.raise();
        const evt = event as any;
        const [ok, button] = evt.get_button();
        if (ok && button === 1) {
          const [coordOk, x, y] = evt.get_root_coords();
          if (coordOk) {
            this.isDragging = true;
            this.dragStartX = x;
            this.dragStartY = y;
            const [wx, wy] = this.get_position();
            this.windowStartX = wx;
            this.windowStartY = wy;
            return true;
          }
        }
        return false;
      });

      headerEventBox.connect("motion-notify-event", (_w, event) => {
        if (this.isDragging) {
          const evt = event as any;
          const [ok, x, y] = evt.get_root_coords();
          if (ok) {
            this.move(
              this.windowStartX + (x - this.dragStartX),
              this.windowStartY + (y - this.dragStartY),
            );
          }
        }
        return false;
      });

      headerEventBox.connect("button-release-event", () => {
        if (this.isDragging) {
          this.isDragging = false;
          this.manager.saveAll();
        }
        return false;
      });

      this.mainBox.pack_start(headerEventBox, false, false, 0);

      const origin = deriveOrigin(this.config.webviewUrl);
      this.webView = this.createWebView(origin);
      this.mainBox.pack_start(this.webView, true, true, 0);

      const grip = new Gtk.EventBox();
      grip.set_size_request(WidgetWindow.RESIZE_GRIP, WidgetWindow.RESIZE_GRIP);
      grip.set_halign(Gtk.Align.END);
      grip.set_valign(Gtk.Align.END);
      grip.set_events(
        Gdk.EventMask.BUTTON_PRESS_MASK |
          Gdk.EventMask.BUTTON_RELEASE_MASK |
          Gdk.EventMask.POINTER_MOTION_MASK |
          Gdk.EventMask.ENTER_NOTIFY_MASK |
          Gdk.EventMask.LEAVE_NOTIFY_MASK,
      );

      grip.connect("realize", () => {
        const gdkWin = grip.get_window();
        if (gdkWin) {
          gdkWin.set_cursor(
            Gdk.Cursor.new_from_name(gdkWin.get_display(), "se-resize"),
          );
        }
      });

      grip.connect("draw", (_w, cr) => {
        const c = cr as any;
        const s = WidgetWindow.RESIZE_GRIP;
        c.setSourceRGBA(1, 1, 1, 0.35);
        const r = 1.0;
        const dots: [number, number][] = [
          [s - 3, s - 3],
          [s - 7, s - 3],
          [s - 3, s - 7],
          [s - 11, s - 3],
          [s - 7, s - 7],
          [s - 3, s - 11],
        ];
        for (const [x, y] of dots) {
          c.arc(x, y, r, 0, 2 * Math.PI);
          c.fill();
        }
        return false;
      });

      grip.connect("button-press-event", (_w, event) => {
        const evt = event as any;
        const [ok, button] = evt.get_button();
        if (ok && button === 1) {
          const [coordOk, x, y] = evt.get_root_coords();
          if (coordOk) {
            this.isResizing = true;
            this.resizeStartX = x;
            this.resizeStartY = y;
            const [w, h] = this.get_size();
            this.resizeStartW = w;
            this.resizeStartH = h;
            return true;
          }
        }
        return false;
      });

      grip.connect("motion-notify-event", (_w, event) => {
        if (this.isResizing) {
          const evt = event as any;
          const [ok, x, y] = evt.get_root_coords();
          if (ok) {
            const newW = Math.max(
              WidgetWindow.MIN_WIDTH,
              Math.round(this.resizeStartW + (x - this.resizeStartX)),
            );
            const newH = Math.max(
              WidgetWindow.MIN_HEIGHT,
              Math.round(this.resizeStartH + (y - this.resizeStartY)),
            );
            this.resize(newW, newH);
          }
        }
        return false;
      });

      grip.connect("button-release-event", () => {
        if (this.isResizing) {
          this.isResizing = false;
          this.manager.saveAll();
        }
        return false;
      });

      overlay.add_overlay(grip);
      this.add(overlay);

      const winCss = new Gtk.CssProvider();
      winCss.load_from_data("window { background-color: transparent; }");
      this.get_style_context().add_provider(
        winCss,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
      );

      this.connect("draw", (_w, cr) => {
        cr.setSourceRGBA(0, 0, 0, 0);
        cr.paint();
        return false;
      });

      this.connect("configure-event", () => {
        const [w, h] = this.get_size();
        const [x, y] = this.get_position();
        this.config.width = w;
        this.config.height = h;
        this.config.posX = x;
        this.config.posY = y;
        return false;
      });
    }

    // ── WebView factory ───────────────────────────────────────────────────

    private createWebView(origin: string): WebKit2.WebView {
      const context = this.manager.originRegistry.getContextForOrigin(origin);

      const ucm = new WebKit2.UserContentManager();
      ucm.register_script_message_handler("widgetizrFS");
      ucm.connect(
        "script-message-received::widgetizrFS",
        (
          _ucm: WebKit2.UserContentManager,
          result: WebKit2.JavascriptResult,
        ) => {
          try {
            const raw = result.get_js_value().to_string();
            this.handleFSMessage(JSON.parse(raw));
          } catch (_) {}
        },
      );
      if (POLYFILL_SOURCE) {
        ucm.add_script(
          new WebKit2.UserScript(
            POLYFILL_SOURCE,
            WebKit2.UserContentInjectedFrames.TOP_FRAME,
            WebKit2.UserScriptInjectionTime.START,
            null,
            null,
          ),
        );
      }

      const view = new WebKit2.WebView({
        web_context: context,
        user_content_manager: ucm,
      });

      view.get_settings().set_enable_page_cache(false);

      view.connect("create", (_wv, navigationAction) => {
        const uri = navigationAction.get_request().get_uri();
        console.log(`[create] window.open intercepted, uri=${uri}`);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          console.log(`[create] launching externally: ${uri}`);
          try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
          } catch (e) {
            console.log(`[create] launch_default_for_uri failed: ${e}`);
          }
          return GLib.SOURCE_REMOVE;
        });
        return null;
      });
      view.connect("context-menu", () => true);
      view.connect("permission-request", (_wv, request) =>
        this.handlePermissionRequest(request),
      );
      view.connect("decide-policy", (_wv, decision, decisionType) => {
        const decisionTypeNames: Record<number, string> = {
          [WebKit2.PolicyDecisionType.NAVIGATION_ACTION]: "NAVIGATION_ACTION",
          [WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION]: "NEW_WINDOW_ACTION",
          [WebKit2.PolicyDecisionType.RESPONSE]: "RESPONSE",
        };
        const typeName =
          decisionTypeNames[decisionType] ?? `UNKNOWN(${decisionType})`;
        console.log(`[decide-policy] fired, decisionType=${typeName}`);

        if (decisionType !== WebKit2.PolicyDecisionType.NAVIGATION_ACTION) {
          console.log(`[decide-policy] unhandled type, returning false`);
          return false;
        }

        const navDecision = decision as WebKit2.NavigationPolicyDecision;
        const newUri = navDecision
          .get_navigation_action()
          .get_request()
          .get_uri();
        const navType = navDecision
          .get_navigation_action()
          .get_navigation_type();
        console.log(
          `[decide-policy] NAVIGATION_ACTION uri=${newUri} navType=${navType}`,
        );

        const isWebUri =
          newUri.startsWith("http://") ||
          newUri.startsWith("https://") ||
          newUri.startsWith("file://");
        console.log(`[decide-policy] isWebUri=${isWebUri}`);

        if (!isWebUri) {
          console.log(`[decide-policy] non-web URI, launching externally`);
          navDecision.ignore();
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            console.log(
              `[decide-policy] launching externally (non-web): ${newUri}`,
            );
            try {
              Gio.AppInfo.launch_default_for_uri(newUri, null);
            } catch (e) {
              console.log(
                `[decide-policy] launch_default_for_uri failed: ${e}`,
              );
            }
            return GLib.SOURCE_REMOVE;
          });
          return true;
        }

        const currentUri = _wv.get_uri() ?? this.config.webviewUrl;
        if (newUri.startsWith("file://") && !currentUri.startsWith("file://")) {
          console.log(
            `[decide-policy] blocking protocol escalation to file://`,
          );
          navDecision.ignore();
          return true;
        }

        const newOrigin = deriveOrigin(newUri);
        const currentOrigin = deriveOrigin(currentUri);
        console.log(
          `[decide-policy] newOrigin=${newOrigin} currentOrigin=${currentOrigin}`,
        );

        if (newOrigin === "__blank__" || newOrigin === currentOrigin) {
          console.log(`[decide-policy] same origin or blank, allowing`);
          return false;
        }

        console.log(`[decide-policy] cross-origin web nav, replacing WebView`);
        navDecision.ignore();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          this.replaceWebViewForOrigin(newOrigin);
          this.webView.load_uri(newUri);
          this.config.webviewUrl = newUri;
          this.manager.saveAll();
          return GLib.SOURCE_REMOVE;
        });
        return true;
      });
      return view;
    }

    private replaceWebViewForOrigin(origin: string): void {
      this.cleanupFSMonitors();
      this.mainBox.remove(this.webView);
      this.webView.destroy();
      this.webView = this.createWebView(origin);
      this.mainBox.pack_start(this.webView, true, true, 0);
      this.webView.show();
    }

    // ── File system bridge ────────────────────────────────────────────────────

    private handleFSMessage(msg: {
      id: number;
      method: string;
      args: any;
    }): void {
      const id = msg.id;
      if (typeof id !== "number" || !Number.isFinite(id)) return;
      const currentUri = this.webView.get_uri() ?? "";
      if (!isSecureUri(currentUri)) {
        const json = JSON.stringify({
          name: "SecurityError",
          message: "File system access is only available in secure contexts",
        });
        this.webView.run_javascript(
          `window.__wFS_reject(${id},${json})`,
          null,
          null,
        );
        return;
      }
      const reply = (result: any) => {
        const json = JSON.stringify(result);
        this.webView.run_javascript(
          `window.__wFS_resolve(${id},${json})`,
          null,
          null,
        );
      };
      const reject = (name: string, message: string) => {
        const json = JSON.stringify({ name, message });
        this.webView.run_javascript(
          `window.__wFS_reject(${id},${json})`,
          null,
          null,
        );
      };
      switch (msg.method) {
        case "showOpenFilePicker":
          return this.fs_showPicker("open", msg.args, reply, reject);
        case "showSaveFilePicker":
          return this.fs_showPicker("save", msg.args, reply, reject);
        case "showDirectoryPicker":
          return this.fs_showPicker("dir", msg.args, reply, reject);
        case "readFile":
          return this.fs_readFile(msg.args, reply, reject);
        case "createWritable":
          return this.fs_createWritable(msg.args, reply, reject);
        case "writableWrite":
          return this.fs_writableWrite(msg.args, reply, reject);
        case "writableClose":
          return this.fs_writableClose(msg.args, reply, reject);
        case "dirEntries":
          return this.fs_dirEntries(msg.args, reply, reject);
        case "getFileHandle":
          return this.fs_getChildHandle("file", msg.args, reply, reject);
        case "getDirHandle":
          return this.fs_getChildHandle("dir", msg.args, reply, reject);
        case "removeEntry":
          return this.fs_removeEntry(msg.args, reply, reject);
        case "observe":
          return this.fs_observe(msg.args, reply, reject);
        case "unobserve":
          return this.fs_unobserve(msg.args, reply, reject);
        case "closeHandle":
          return this.fs_closeHandle(msg.args, reply);
        case "rehydrateHandle":
          return this.fs_rehydrateHandle(msg.args, reply, reject);
        default:
          reject("NotSupportedError", `Unknown FS method: ${msg.method}`);
      }
    }

    private fs_newHandle(
      kind: "file" | "dir",
      path: string,
      root: string | null = null,
    ): { kind: string; name: string; hid: string; persistentId: string } {
      const hid = `${kind === "dir" ? "d" : "f"}h_${++this.fsHandleCounter}`;
      this.fsHandles.set(hid, { kind, path, root });
      const persistentId = GLib.uuid_string_random();
      const origin = deriveOrigin(this.webView.get_uri() ?? "");
      this.manager.fsHandleStore.grant(origin, persistentId, kind, path);
      return {
        kind: kind === "dir" ? "directory" : "file",
        name: GLib.path_get_basename(path),
        hid,
        persistentId,
      };
    }

    private fs_rehydrateHandle(
      args: { persistentId: string },
      reply: Function,
      reject: Function,
    ): void {
      const origin = deriveOrigin(this.webView.get_uri() ?? "");
      const grant = this.manager.fsHandleStore.redeem(
        origin,
        args.persistentId,
      );
      if (!grant)
        return reject(
          "NotFoundError",
          "Handle not found or permission revoked",
        );
      const f = Gio.File.new_for_path(grant.path);
      if (!f.query_exists(null))
        return reject(
          "NotFoundError",
          "File or directory no longer exists on disk",
        );
      reply(
        this.fs_newHandle(
          grant.kind,
          grant.path,
          grant.kind === "dir" ? grant.path : null,
        ),
      );
    }

    private fs_showPicker(
      type: "open" | "save" | "dir",
      args: any,
      reply: Function,
      reject: Function,
    ): void {
      const action =
        type === "dir"
          ? Gtk.FileChooserAction.SELECT_FOLDER
          : type === "save"
            ? Gtk.FileChooserAction.SAVE
            : Gtk.FileChooserAction.OPEN;
      const origin = deriveOrigin(this.webView.get_uri() ?? "");
      const chooser = new Gtk.FileChooserNative({
        title:
          type === "dir"
            ? `"${this.config.title}" wants access to a folder`
            : type === "save"
              ? `"${this.config.title}" wants to save a file`
              : `"${this.config.title}" wants to open a file`,
        transient_for: this,
        action,
        accept_label:
          type === "dir" ? "Select folder" : type === "save" ? "Save" : "Open",
        cancel_label: "Cancel",
      });
      if (type === "save" && args?.suggestedName) {
        chooser.set_current_name(args.suggestedName as string);
      }
      if ((type === "open" || type === "save") && Array.isArray(args?.types)) {
        for (const t of args.types) {
          const filter = new Gtk.FileFilter();
          if (t.description) filter.set_name(t.description as string);
          for (const [mime, exts] of Object.entries(t.accept ?? {})) {
            filter.add_mime_type(mime);
            for (const ext of (Array.isArray(exts)
              ? exts
              : [exts]) as string[]) {
              filter.add_pattern(`*${ext}`);
            }
          }
          chooser.add_filter(filter);
        }
      }
      const res = chooser.run();
      if (res !== Gtk.ResponseType.ACCEPT) {
        chooser.destroy();
        return reject("AbortError", "User dismissed the picker");
      }
      const path = chooser.get_filename()!;
      chooser.destroy();
      if (type === "open") {
        reply([this.fs_newHandle("file", path)]);
      } else if (type === "save") {
        const f = Gio.File.new_for_path(path);
        if (!f.query_exists(null)) {
          try {
            f.create(Gio.FileCreateFlags.NONE, null);
          } catch (_) {}
        }
        reply(this.fs_newHandle("file", path));
      } else {
        const folderName = GLib.path_get_basename(path);
        const confirm = new Gtk.MessageDialog({
          transient_for: this,
          modal: true,
          destroy_with_parent: true,
          message_type: Gtk.MessageType.QUESTION,
          buttons: Gtk.ButtonsType.NONE,
          text: `Allow access to "${folderName}"?`,
          secondary_text:
            `"${this.config.title}" (${origin}) wants to view and edit all files in "${folderName}".\n\n` +
            `The widget will be able to read, create, modify, and delete files in this folder.`,
        });
        confirm.add_button("Cancel", Gtk.ResponseType.CANCEL);
        const allowBtn = confirm.add_button("Allow", Gtk.ResponseType.OK);
        allowBtn.get_style_context().add_class("suggested-action");
        confirm.set_default_response(Gtk.ResponseType.CANCEL);
        const confirmRes = confirm.run();
        confirm.destroy();
        if (confirmRes !== Gtk.ResponseType.OK) {
          return reject("AbortError", "User denied folder access");
        }
        reply(this.fs_newHandle("dir", path, path));
      }
    }

    private fs_readFile(
      args: { hid: string },
      reply: Function,
      reject: Function,
    ): void {
      const h = this.fsHandles.get(args.hid);
      if (!h) return reject("NotFoundError", "Handle not found");
      try {
        const [ok, bytes] = Gio.File.new_for_path(h.path).load_contents(null);
        if (!ok) return reject("NotReadableError", "Could not read file");
        reply({ base64: GLib.base64_encode(bytes) });
      } catch (e: any) {
        reject("NotReadableError", e?.message ?? "Read failed");
      }
    }

    private fs_createWritable(
      args: { hid: string },
      reply: Function,
      reject: Function,
    ): void {
      const h = this.fsHandles.get(args.hid);
      if (!h) return reject("NotFoundError", "Handle not found");
      const wid = `wr_${++this.fsWritableCounter}`;
      this.fsWritables.set(wid, { destPath: h.path, chunks: [] });
      reply({ wid });
    }

    private fs_writableWrite(
      args: { wid: string; base64: string },
      reply: Function,
      reject: Function,
    ): void {
      const w = this.fsWritables.get(args.wid);
      if (!w) return reject("InvalidStateError", "Writable not found");
      try {
        w.chunks.push(GLib.base64_decode(args.base64));
        reply(null);
      } catch (e: any) {
        reject("InvalidStateError", e?.message ?? "Decode failed");
      }
    }

    private fs_writableClose(
      args: { wid: string },
      reply: Function,
      reject: Function,
    ): void {
      const w = this.fsWritables.get(args.wid);
      if (!w) return reject("InvalidStateError", "Writable not found");
      this.fsWritables.delete(args.wid);
      try {
        const total = w.chunks.reduce((acc, c) => acc + c.byteLength, 0);
        const combined = new Uint8Array(total);
        let off = 0;
        for (const c of w.chunks) {
          combined.set(c, off);
          off += c.byteLength;
        }
        const file = Gio.File.new_for_path(w.destPath);
        if (total === 0) {
          const os = file.replace(
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
          );
          os.close(null);
          reply(null);
          return;
        }
        file.replace_contents_async(
          combined as unknown as any,
          null,
          false,
          Gio.FileCreateFlags.REPLACE_DESTINATION,
          null,
          (source, result) => {
            try {
              (source as Gio.File).replace_contents_finish(result);
              reply(null);
            } catch (e: any) {
              reject("NotWritableError", e?.message ?? "Write failed");
            }
          },
        );
      } catch (e: any) {
        reject("NotWritableError", e?.message ?? "Write failed");
      }
    }

    private fs_dirEntries(
      args: { hid: string },
      reply: Function,
      reject: Function,
    ): void {
      const h = this.fsHandles.get(args.hid);
      if (!h) return reject("NotFoundError", "Handle not found");
      try {
        const dir = Gio.File.new_for_path(h.path);
        const enumerator = dir.enumerate_children(
          "standard::name,standard::type",
          Gio.FileQueryInfoFlags.NONE,
          null,
        );
        const entries: any[] = [];
        let info: Gio.FileInfo | null;
        while ((info = enumerator.next_file(null)) !== null) {
          const name = info.get_name();
          const isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
          const childPath = GLib.build_filenamev([h.path, name]);
          entries.push(
            this.fs_newHandle(isDir ? "dir" : "file", childPath, h.root),
          );
        }
        enumerator.close(null);
        reply(entries);
      } catch (e: any) {
        reject(
          "NotReadableError",
          e?.message ?? "Could not enumerate directory",
        );
      }
    }

    private checkSymlinkEscape(childPath: string, root: string): string | null {
      try {
        const f = Gio.File.new_for_path(childPath);
        const info = f.query_info(
          "standard::is-symlink,standard::symlink-target",
          Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
          null,
        );
        if (!info.get_is_symlink()) return null;
        const target = info.get_symlink_target()!;
        const absTarget = GLib.path_is_absolute(target)
          ? target
          : GLib.build_filenamev([GLib.path_get_dirname(childPath), target]);
        const resolved = GLib.canonicalize_filename(absTarget, null);
        const normRoot = GLib.canonicalize_filename(root, null);
        if (resolved !== normRoot && !resolved.startsWith(normRoot + "/")) {
          return `Symlink "${GLib.path_get_basename(childPath)}" points outside the granted directory`;
        }
      } catch (_) {}
      return null;
    }

    private fs_getChildHandle(
      kind: "file" | "dir",
      args: { hid: string; name: string; create: boolean },
      reply: Function,
      reject: Function,
    ): void {
      const h = this.fsHandles.get(args.hid);
      if (!h) return reject("NotFoundError", "Handle not found");
      if (
        !args.name ||
        args.name === "." ||
        args.name === ".." ||
        args.name.includes("/") ||
        args.name.includes("\0")
      )
        return reject("TypeError", "Name is not allowed.");
      const childPath = GLib.build_filenamev([h.path, args.name]);
      if (h.root) {
        const escErr = this.checkSymlinkEscape(childPath, h.root);
        if (escErr) return reject("NotAllowedError", escErr);
      }
      const f = Gio.File.new_for_path(childPath);
      if (!f.query_exists(null)) {
        if (!args.create)
          return reject("NotFoundError", `${args.name} does not exist`);
        try {
          if (kind === "dir") f.make_directory(null);
          else f.create(Gio.FileCreateFlags.NONE, null);
        } catch (e: any) {
          return reject(
            "NotAllowedError",
            e?.message ?? "Could not create entry",
          );
        }
      }
      reply(this.fs_newHandle(kind, childPath, h.root));
    }

    private fs_removeEntry(
      args: { hid: string; name: string; recursive: boolean },
      reply: Function,
      reject: Function,
    ): void {
      const h = this.fsHandles.get(args.hid);
      if (!h) return reject("NotFoundError", "Handle not found");
      if (
        !args.name ||
        args.name === "." ||
        args.name === ".." ||
        args.name.includes("/") ||
        args.name.includes("\0")
      )
        return reject("TypeError", "Name is not allowed.");
      const childPath = GLib.build_filenamev([h.path, args.name]);
      try {
        this.fs_deleteRecursive(
          Gio.File.new_for_path(childPath),
          args.recursive,
        );
        reply(null);
      } catch (e: any) {
        reject("NotAllowedError", e?.message ?? "Could not remove entry");
      }
    }

    private fs_deleteRecursive(f: Gio.File, recursive: boolean): void {
      if (
        recursive &&
        f.query_file_type(Gio.FileQueryInfoFlags.NONE, null) ===
          Gio.FileType.DIRECTORY
      ) {
        const enumerator = f.enumerate_children(
          "standard::name",
          Gio.FileQueryInfoFlags.NONE,
          null,
        );
        let info: Gio.FileInfo | null;
        while ((info = enumerator.next_file(null)) !== null) {
          this.fs_deleteRecursive(f.get_child(info.get_name()), true);
        }
        enumerator.close(null);
      }
      f.delete(null);
    }

    private fs_observe(
      args: { hid: string; recursive: boolean },
      reply: Function,
      reject: Function,
    ): void {
      const h = this.fsHandles.get(args.hid);
      if (!h) return reject("NotFoundError", "Handle not found");
      try {
        const f = Gio.File.new_for_path(h.path);
        const monitor =
          h.kind === "dir"
            ? f.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
            : f.monitor_file(Gio.FileMonitorFlags.NONE, null);
        const mid = `mon_${++this.fsMonitorCounter}`;
        monitor.connect(
          "changed",
          (
            _mon: Gio.FileMonitor,
            changedFile: Gio.File,
            otherFile: Gio.File | null,
            eventType: number,
          ) => {
            this.fs_onMonitorEvent(
              mid,
              h.path,
              changedFile,
              otherFile,
              eventType as Gio.FileMonitorEvent,
            );
          },
        );
        this.fsMonitors.set(mid, monitor);
        reply({ mid });
      } catch (e: any) {
        reject("NotSupportedError", e?.message ?? "Could not create monitor");
      }
    }

    private fs_onMonitorEvent(
      mid: string,
      basePath: string,
      changedFile: Gio.File,
      otherFile: Gio.File | null,
      eventType: Gio.FileMonitorEvent,
    ): void {
      if (eventType === Gio.FileMonitorEvent.CHANGED) return;

      let type: string;
      switch (eventType) {
        case Gio.FileMonitorEvent.CREATED:
        case Gio.FileMonitorEvent.MOVED_IN:
          type = "appeared";
          break;
        case Gio.FileMonitorEvent.DELETED:
        case Gio.FileMonitorEvent.MOVED_OUT:
          type = "disappeared";
          break;
        case Gio.FileMonitorEvent.CHANGES_DONE_HINT:
        case Gio.FileMonitorEvent.ATTRIBUTE_CHANGED:
          type = "modified";
          break;
        case Gio.FileMonitorEvent.RENAMED:
        case Gio.FileMonitorEvent.MOVED:
          type = "moved";
          break;
        default:
          type = "unknown";
      }

      const prefix = basePath + "/";
      const isRenameEvent =
        eventType === Gio.FileMonitorEvent.RENAMED ||
        eventType === Gio.FileMonitorEvent.MOVED;
      const currentFile = isRenameEvent && otherFile ? otherFile : changedFile;
      const previousFile = isRenameEvent && otherFile ? changedFile : null;

      const currentPath = currentFile.get_path() ?? "";
      const isDir =
        currentFile.query_file_type(Gio.FileQueryInfoFlags.NONE, null) ===
        Gio.FileType.DIRECTORY;
      const changedHandle = this.fs_newHandle(
        isDir ? "dir" : "file",
        currentPath,
      );

      const relPath = currentPath.startsWith(prefix)
        ? currentPath.slice(prefix.length).split("/")
        : [changedHandle.name];

      let relMovedFrom: string[] | null = null;
      if (previousFile) {
        const previousPath = previousFile.get_path() ?? "";
        relMovedFrom = previousPath.startsWith(prefix)
          ? previousPath.slice(prefix.length).split("/")
          : [GLib.path_get_basename(previousPath)];
      }

      const payload = JSON.stringify({
        mid,
        record: {
          type,
          changedHandle,
          relativePathComponents: relPath,
          relativePathMovedFrom: relMovedFrom,
        },
      });
      this.webView.run_javascript(
        `window.__wFS_notify(${payload})`,
        null,
        null,
      );
    }

    private fs_unobserve(
      args: { mid: string },
      reply: Function,
      _reject: Function,
    ): void {
      const monitor = this.fsMonitors.get(args.mid);
      if (monitor) {
        monitor.cancel();
        this.fsMonitors.delete(args.mid);
      }
      reply(null);
    }

    private fs_closeHandle(args: { hid: string }, reply: Function): void {
      this.fsHandles.delete(args.hid);
      reply(null);
    }

    private cleanupFSMonitors(): void {
      for (const monitor of this.fsMonitors.values()) monitor.cancel();
      this.fsMonitors.clear();
      this.fsHandles.clear();
      this.fsWritables.clear();
    }

    // ── Permission handling ───────────────────────────────────────────────

    private handlePermissionRequest(
      request: WebKit2.PermissionRequest,
    ): boolean {
      const meta = classifyPermissionRequest(request);
      const currentUri = this.webView.get_uri() ?? this.config.webviewUrl;
      const origin = deriveOrigin(currentUri);
      const store = this.manager.permissionStore;

      if (meta.type === "unknown") {
        console.log(
          `[permission] Unknown permission request from ${origin} (${request.constructor.name}), denying.`,
        );
        request.deny();
        return true;
      }

      const existing = store.get(origin, meta.type);
      if (existing === "allow") {
        request.allow();
        return true;
      }
      if (existing === "deny") {
        request.deny();
        return true;
      }

      const decision = promptPermission(this, this.config.title, origin, meta);
      store.set(origin, meta.type, decision);

      if (decision === "allow") {
        request.allow();
      } else {
        request.deny();
      }
      return true;
    }

    // ── Config application ────────────────────────────────────────────────

    applyConfig(): void {
      this.headerBar.set_title(this.config.title);

      const headerCss = new Gtk.CssProvider();
      headerCss.load_from_data(`
        headerbar {
          background-color: ${this.config.headerBgColor};
          background-image: none;
          border-bottom: none;
          border-top: none;
          box-shadow: none;
          border-radius: 0;
          padding: 0 6px;
          min-height: 30px;
        }
        headerbar label {
          color: rgba(255,255,255,0.9);
          font-size: 12px;
          font-weight: 500;
        }
        headerbar button {
          color: rgba(255,255,255,0.85);
          background: transparent;
          background-image: none;
          border: none;
          box-shadow: none;
          padding: 2px 4px;
          min-height: 0;
          min-width: 0;
        }
        headerbar button:hover {
          background-color: rgba(255,255,255,0.18);
          border-radius: 4px;
        }
        headerbar button:active {
          background-color: rgba(255,255,255,0.30);
          border-radius: 4px;
        }
      `);
      this.headerBar
        .get_style_context()
        .add_provider(headerCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

      if (this.config.webviewUrl.trim()) {
        this.webView.load_uri(this.config.webviewUrl);
      } else {
        this.webView.load_html(this.buildPlaceholderHtml(), null);
      }
    }

    private buildPlaceholderHtml(): string {
      return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { width: 100%; height: 100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #1a1a2e;
        color: #8892a0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        text-align: center;
        padding: 32px;
      }
      .icon { font-size: 52px; line-height: 1; }
      h2   { color: #dde1e7; font-size: 15px; font-weight: 600; }
      p    { font-size: 12px; line-height: 1.6; max-width: 260px; }
      kbd  {
        display: inline-block;
        background: #2c3e50;
        color: #ecf0f1;
        border-radius: 4px;
        padding: 1px 6px;
        font-size: 11px;
        font-family: inherit;
      }
    </style>
  </head>
  <body>
    <div class="icon">🌐</div>
    <h2>No content yet</h2>
    <p>Click the <kbd>⚙</kbd> settings icon above and paste a URL to load content into this widget.</p>
  </body>
</html>`;
    }

    // ── Public API ────────────────────────────────────────────────────────

    openSettings(): void {
      const dialog = new SettingsDialog(this, this.config);
      dialog.connect("response", (_d, responseId) => {
        if (responseId === Gtk.ResponseType.OK) {
          const updates = dialog.get_config();
          const newUrl = updates.webviewUrl ?? this.config.webviewUrl;
          const oldOrigin = deriveOrigin(this.config.webviewUrl);
          const newOrigin = deriveOrigin(newUrl);
          const originChanged = newOrigin !== oldOrigin;

          this.config.title = updates.title ?? this.config.title;
          this.config.headerBgColor =
            updates.headerBgColor ?? this.config.headerBgColor;
          this.config.webviewUrl = newUrl;

          if (originChanged && newUrl.trim()) {
            this.replaceWebViewForOrigin(newOrigin);
          }

          this.applyConfig();
          this.manager.saveAll();
        }
        dialog.destroy();
      });
    }

    getConfig(): WidgetConfig {
      return { ...this.config };
    }

    getMemStats(): WindowMemStats {
      return {
        id: this.config.id,
        url: this.config.webviewUrl,
        fsHandles: this.fsHandles.size,
        fsWritables: this.fsWritables.size,
        fsMonitors: this.fsMonitors.size,
        totalHandlesCreated: this.fsHandleCounter,
        totalWritablesCreated: this.fsWritableCounter,
      };
    }
  },
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return "widget-" + Date.now() + "-" + Math.random().toString(36).slice(2, 11);
}

function readSelfRssKb(): number {
  try {
    const f = Gio.File.new_for_path("/proc/self/status");
    const [ok, bytes] = f.load_contents(null);
    if (!ok) return 0;
    const text = new TextDecoder().decode(bytes as unknown as Uint8Array);
    const m = text.match(/VmRSS:\s+(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function getChildProcessInfo(): {
  pid: number;
  rss_kb: number;
  name: string;
}[] {
  try {
    const cmd = `ps --ppid ${(GLib as unknown as { getpid(): number }).getpid()} -o pid=,rss=,comm= --no-headers`;
    const [ok, stdout] = GLib.spawn_command_line_sync(cmd);
    if (!ok || !stdout) return [];
    const text = new TextDecoder().decode(stdout as unknown as Uint8Array);
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: parseInt(parts[0], 10),
          rss_kb: parseInt(parts[1], 10),
          name: parts[2] ?? "",
        };
      });
  } catch {
    return [];
  }
}

function startMemoryMonitor(manager: WidgetManager): void {
  GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => {
    const ts = new Date().toISOString();
    const gjsRss = readSelfRssKb();
    const children = getChildProcessInfo();
    const windowStats = manager.getMemStats();
    const originCount = manager.originRegistry.entryCount();

    const childTotal = children.reduce((s, c) => s + c.rss_kb, 0);
    const totalRss = gjsRss + childTotal;

    const webkitProcs = children.filter(
      (c) => c.name.includes("WebKit") || c.name.includes("webkit"),
    );
    const webkitRss = webkitProcs.reduce((s, c) => s + c.rss_kb, 0);

    const entry = {
      ts,
      gjs_rss_kb: gjsRss,
      webkit_rss_kb: webkitRss,
      total_rss_kb: totalRss,
      origins_cached: originCount,
      windows: windowStats,
      all_children: children,
    };

    const gjsMb = Math.round(gjsRss / 1024);
    const wkMb = Math.round(webkitRss / 1024);
    const totMb = Math.round(totalRss / 1024);
    print(
      `[MEM ${ts}] gjs=${gjsMb}MB  webkit=${wkMb}MB (${webkitProcs.length} procs)  total=${totMb}MB  origins=${originCount}  windows=${windowStats.length}`,
    );
    for (const w of windowStats) {
      print(
        `  window ${w.id.slice(-8)}: handles=${w.fsHandles}(+${w.totalHandlesCreated} ever)  writables=${w.fsWritables}  monitors=${w.fsMonitors}  url=${w.url.slice(0, 60)}`,
      );
    }
    print(`[MEM_JSON] ${JSON.stringify(entry)}`);

    return GLib.SOURCE_CONTINUE;
  });
}

function runBackgroundUpdate(): void {
  try {
    const versionPath = GLib.build_filenamev([
      GLib.get_home_dir(),
      ".local",
      "share",
      "widgetizr",
      "version.txt",
    ]);
    const [, versionBytes] = GLib.file_get_contents(versionPath);
    const storedVersion = versionBytes
      ? new TextDecoder().decode(versionBytes as unknown as Uint8Array).trim()
      : "";

    if (!storedVersion) return;

    const proc = Gio.Subprocess.new(
      ["curl", "-fsSL", "https://widgetizr.app/version.txt"],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    );

    proc.communicate_utf8_async(null, null, (p, res) => {
      try {
        const [, stdout] = p!.communicate_utf8_finish(res);
        const latestVersion = (stdout ?? "").trim();
        if (!latestVersion || latestVersion === storedVersion) return;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
          const dlg = new Gtk.MessageDialog({
            modal: false,
            message_type: Gtk.MessageType.INFO,
            buttons: Gtk.ButtonsType.OK,
            text: `Update available: Widgetizr v${latestVersion}`,
            secondary_text:
              `You are currently running v${storedVersion}.\n\n` +
              "To update manually, run:\n" +
              "curl -fsSL https://widgetizr.app/install | sh",
          });
          dlg.connect("response", () => dlg.destroy());
          dlg.show_all();
          return GLib.SOURCE_REMOVE;
        });
      } catch (_) {}
    });
  } catch (_) {}
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function main(): void {
  Gtk.init(null);

  if (!checkSessionType()) {
    return;
  }

  const manager = new WidgetManager();
  const config = manager.getConfig();

  if (!config.welcomeShown) {
    const welcome = new WelcomeDialog();
    welcome.run();
    welcome.destroy();
    manager.markWelcomeShown();
  }

  if (!config.desktopConflictHandled) {
    const foreign = findForeignDesktopWindows();
    if (foreign.length > 0) {
      const dialog = new DesktopConflictDialog(foreign);
      const response = dialog.run();
      dialog.destroy();

      if (response === CONFLICT_RESPONSE_KILL) {
        scheduleKillWithWatch(foreign);
      } else if (response === CONFLICT_RESPONSE_NEVER) {
        manager.markDesktopConflictHandled();
      }
    }
  }

  manager.loadAndCreateWidgets();
  runBackgroundUpdate();
  startMemoryMonitor(manager);

  Gtk.main();
}

main();
