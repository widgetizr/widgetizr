import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";

const WIDGETS_DIR = process.env.WIDGETS_DIR;
const WEBSITE_DIR = process.env.WEBSITE_DIR;
const OUT_DIR = process.env.OUT_DIR;
const PORT = 3000;

if (!WIDGETS_DIR) throw new Error("WIDGETS_DIR env var required");
if (!WEBSITE_DIR) throw new Error("WEBSITE_DIR env var required");
if (!OUT_DIR) throw new Error("OUT_DIR env var required");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
};

const MEETING_NOTES = `# Meeting Notes

Discussed Q3 roadmap and widget release.

- Ship v1.0 this month
- Update landing page
- Review pricing model
- Write release notes`;

const IDEAS = `# Ideas

- Dark mode toggle
- Export notes to PDF
- Sync with Obsidian vault
- Keyboard shortcuts`;

const TODO_CONTENT = `x Review PR #142
x Update docs
Ship v1.2.0
Write blog post
Fix dark mode bug
Prepare launch assets`;

function buildTrackerContent() {
  return [
    "// WIDGETIZR TIME TRACKER STORAGE FILE V1",
    "// This file follows the Widgetizr Time Tracker Storage Spec V1, documented at https://widgetizr.app/w/time-tracker/spec/time-tracker-v1.md. Manual edits that violate the spec will cause this file to be rejected by the widget.",
    "",
    "[projects]",
    "Deep Work    #89b4fa",
    "Meetings     #f38ba8",
    "",
    "[log]",
    "2026-04-11 09:00 - 10:30  Deep Work",
    "2026-04-11 13:00 - 14:45  Meetings",
    "2026-04-11 15:00 - 16:12  Deep Work",
  ].join("\n");
}

const SERVER_MONITOR_STORAGE_KEY = "widgetizr-server-monitor-v1";

const SERVER_MONITOR_SERVERS = [
  {
    id: "srv-prod",
    name: "Production",
    url: `http://localhost:${PORT}/mock-api/prod`,
    token: "demo-prod-token",
  },
  {
    id: "srv-staging",
    name: "Staging",
    url: `http://localhost:${PORT}/mock-api/staging`,
    token: "demo-staging-token",
  },
];

const SERVER_MONITOR_METRICS = {
  prod: {
    hostname: "prod-eu-1",
    uptime: 86400 * 12 + 3600 * 7 + 60 * 18,
    loadAvg: [1.42, 1.18, 0.96],
    cpu: { percent: 37 },
    memory: {
      usedMb: 11840,
      totalMb: 16384,
      percent: 72,
      swapTotalMb: 2048,
      swapUsedMb: 256,
      swapPercent: 13,
    },
    disks: [
      { mount: "/", usedGb: 118, totalGb: 160, percent: 74 },
      { mount: "/data", usedGb: 412, totalGb: 512, percent: 80 },
    ],
    network: [
      { iface: "eth0", rxBytesPerSec: 2_450_000, txBytesPerSec: 1_180_000 },
      { iface: "tailscale0", rxBytesPerSec: 42_000, txBytesPerSec: 18_000 },
    ],
  },
  staging: {
    hostname: "staging-eu-1",
    uptime: 86400 * 3 + 3600 * 4 + 60 * 9,
    loadAvg: [0.38, 0.44, 0.41],
    cpu: { percent: 18 },
    memory: {
      usedMb: 2840,
      totalMb: 8192,
      percent: 35,
      swapTotalMb: 0,
      swapUsedMb: 0,
      swapPercent: 0,
    },
    disks: [
      { mount: "/", usedGb: 41, totalGb: 120, percent: 34 },
      { mount: "/var/lib/docker", usedGb: 58, totalGb: 160, percent: 36 },
    ],
    network: [
      { iface: "eth0", rxBytesPerSec: 420_000, txBytesPerSec: 210_000 },
    ],
  },
};

function serveFile(res, filePath, rootDir) {
  if (!filePath.startsWith(path.resolve(rootDir))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

      if (reqUrl.pathname === "/mock-api/prod/metrics") {
        return sendJson(res, 200, SERVER_MONITOR_METRICS.prod);
      }

      if (reqUrl.pathname === "/mock-api/staging/metrics") {
        return sendJson(res, 200, SERVER_MONITOR_METRICS.staging);
      }

      const urlPath = decodeURIComponent(reqUrl.pathname);

      if (urlPath.startsWith("/website/")) {
        const safePath = urlPath.slice("/website".length) || "/index.html";
        const filePath = path.resolve(path.join(WEBSITE_DIR, safePath));
        return serveFile(res, filePath, WEBSITE_DIR);
      }

      const safePath = urlPath === "/" ? "/index.html" : urlPath;
      const filePath = path.resolve(path.join(WIDGETS_DIR, safePath));
      return serveFile(res, filePath, WIDGETS_DIR);
    });

    server.listen(PORT, () => resolve(server));
    server.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function waitForStableFrame(page, delay = 300) {
  await page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(resolve, ms);
        });
      }),
    delay,
  );
}

async function prepareWidgetFrame(page, widget) {
  await page.addStyleTag({
    content: `
      html, body {
        margin: 0 !important;
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
        background: #1e1e2e !important;
        color-scheme: dark !important;
      }
      body {
        display: block !important;
      }
    `,
  });

  if (widget.name === "notes" || widget.name === "time-tracker") {
    await page.addStyleTag({
      content: `
        html, body {
          background: #1e1e2e !important;
        }
        body {
          display: flex !important;
          flex-direction: column !important;
          min-height: 100% !important;
        }
        #statusbar {
          margin: 0 !important;
          flex-shrink: 0 !important;
        }
      `,
    });
  }

  if (widget.name === "clock") {
    await page.addStyleTag({
      content: `
        body {
          padding-top: 12px !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 16px !important;
          background: #1e1e2e !important;
        }
        .clock-wrap {
          width: 172px !important;
          height: 172px !important;
          flex: 0 0 auto !important;
        }
        canvas#analog {
          width: 172px !important;
          height: 172px !important;
        }
        .digital {
          gap: 3px !important;
        }
      `,
    });
  }

  if (widget.name === "todo") {
    await page.addStyleTag({
      content: `
        html, body {
          background: #1e1e2e !important;
        }
        .app {
          width: 100% !important;
          max-width: none !important;
        }
        #toolbar,
        .list-wrap,
        #statusbar,
        ul,
        li {
          width: 100% !important;
        }
        .todo-text {
          min-width: 0 !important;
        }
      `,
    });
  }

  if (widget.name === "server-monitor") {
    await page.addStyleTag({
      content: `
        html, body {
          background: #1e1e2e !important;
        }
        #main {
          padding: 10px !important;
        }
      `,
    });
  }

  await waitForStableFrame(page);
}

const WIDGETS = [
  {
    name: "clock",
    viewport: { width: 192, height: 244 },
    async setup(page) {
      await page.waitForTimeout(500);
    },
  },
  {
    name: "notes",
    viewport: { width: 232, height: 340 },
    async setup(page) {
      await page.evaluate(
        async (files) => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle("notes-demo", {
            create: true,
          });
          for (const [name, text] of files) {
            const fh = await dir.getFileHandle(name, {
              create: true,
            });
            const w = await fh.createWritable();
            await w.write(text);
            await w.close();
          }
          window.showDirectoryPicker = async () => dir;
        },
        [
          ["Meeting Notes.md", MEETING_NOTES],
          ["Ideas.md", IDEAS],
        ],
      );
      await page.click("#btn-folder");
      await page.waitForTimeout(500);
    },
  },
  {
    name: "todo",
    viewport: { width: 292, height: 300 },
    async setup(page) {
      await page.evaluate(async (text) => {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle("todo-demo.txt", {
          create: true,
        });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
        window.showOpenFilePicker = async () => [fh];
      }, TODO_CONTENT);
      await page.click("#fileBtn");
      await page.waitForTimeout(500);
    },
  },
  {
    name: "time-tracker",
    viewport: { width: 230, height: 380 },
    async setup(page) {
      const content = buildTrackerContent();
      await page.evaluate(async (text) => {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle("tracker-demo.txt", {
          create: true,
        });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
        window.showOpenFilePicker = async () => [fh];
      }, content);
      await page.click("#btn-file");
      await page.waitForTimeout(500);
    },
  },
  {
    name: "server-monitor",
    viewport: { width: 292, height: 340 },
    async setup(page) {
      await page.evaluate(
        ({ servers, storageKey }) => {
          localStorage.setItem(storageKey, JSON.stringify(servers));
        },
        {
          servers: SERVER_MONITOR_SERVERS,
          storageKey: SERVER_MONITOR_STORAGE_KEY,
        },
      );

      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(500);

      await page.waitForFunction(() => {
        const cards = document.querySelectorAll(".server-card");
        return cards.length >= 2;
      });

      await page.click('.server-card[data-id="srv-prod"]');
      await page.waitForTimeout(500);
    },
  },
];

async function screenshotDesktopMockup(browser, outFile) {
  console.log("Screenshotting desktop mockup...");
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/website/index.html`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".wgt")].every(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  );
  await waitForStableFrame(page, 300);
  const mockup = page.locator(".mockup-outer").first();
  await mockup.screenshot({ path: outFile });
  console.log(`  -> ${outFile}`);
  await context.close();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const server = await startServer();
  console.log(`Server started on http://localhost:${PORT}`);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    for (const widget of WIDGETS) {
      console.log(`Screenshotting ${widget.name}...`);

      const context = await browser.newContext({
        viewport: widget.viewport,
        deviceScaleFactor: 2,
        colorScheme: "dark",
      });

      const page = await context.newPage();
      await page.goto(`http://localhost:${PORT}/${widget.name}/index.html`, {
        waitUntil: "networkidle",
      });

      await widget.setup(page);
      await prepareWidgetFrame(page, widget);

      const outFile = path.join(OUT_DIR, `${widget.name}.png`);
      await page.screenshot({ path: outFile });
      console.log(`  -> ${outFile}`);

      await context.close();
    }

    await screenshotDesktopMockup(
      browser,
      path.join(OUT_DIR, "desktop-mockup.png"),
    );
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
