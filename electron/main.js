// OpenMuse desktop shell: embeds the Node bridge server, shows the web UI.
"use strict";
const { app, BrowserWindow, shell } = require("electron");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.OPENMUSE_PORT || 3101);
const DEV = !!process.env.OPENMUSE_DEV;
const SMOKE = process.argv.includes("--smoke");

function health() {
  return new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port: PORT, path: "/api/health", timeout: 2000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(b));
        } catch {
          resolve(null);
        }
      });
    });
    r.on("error", () => resolve(null));
    r.on("timeout", () => {
      r.destroy();
      resolve(null);
    });
  });
}

// Reuse an already-running server (e.g. `npm start` in a terminal),
// otherwise boot the bundled one in-process.
async function ensureServer() {
  if (await health()) return;
  const root = app.isPackaged ? path.join(process.resourcesPath, "app.asar") : path.join(__dirname, "..");
  process.env.PORT = String(PORT);
  process.env.OPENMUSE_WEB_DIR = path.join(root, "web", "dist");
  require(path.join(root, "server", "src", "index.js"));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await health()) return;
  }
  throw new Error("bundled server did not start");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    title: "OpenMuse",
    backgroundColor: "#0a0e14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  win.loadURL(DEV ? "http://localhost:5174/" : `http://127.0.0.1:${PORT}/`);
  return win;
}

async function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  await ensureServer();
  if (SMOKE) {
    console.log("SMOKE:", JSON.stringify(await health()));
    app.exit(0);
    return;
  }
  let win = createWindow();
  app.on("second-instance", () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
}

main().catch((e) => {
  console.error("OpenMuse failed to start:", e.message);
  app.exit(1);
});
