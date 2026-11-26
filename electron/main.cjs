const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const HOST = "127.0.0.1";
let serverProcess = null;
let mainWindow = null;
let serverPort = null;
let quitting = false;

function log(message) {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "desktop.log"), "[" + new Date().toISOString() + "] " + message + "\n");
  } catch (_) {}
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: HOST, port });
    socket.setTimeout(800);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

async function waitForServer(port, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (quitting || (serverProcess && serverProcess.exitCode !== null)) {
      throw new Error("The local Next.js server stopped before becoming ready.");
    }
    if (await canConnect(port)) return;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error("Timed out while starting the local application server.");
}

function startLocalServer(port) {
  const appPath = app.getAppPath();
  const nextCli = path.join(appPath, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(nextCli)) {
    throw new Error("Next.js was not found in the installed application: " + nextCli);
  }

  const command = app.isPackaged ? "start" : "dev";
  const args = [nextCli, command, "-H", HOST, "-p", String(port)];
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: app.isPackaged ? "production" : "development"
  };

  serverProcess = spawn(process.execPath, args, {
    cwd: appPath,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverProcess.stdout.on("data", chunk => log("NEXT: " + chunk.toString().trim()));
  serverProcess.stderr.on("data", chunk => log("NEXT ERROR: " + chunk.toString().trim()));
  serverProcess.on("error", error => log("SERVER PROCESS ERROR: " + error.message));
  serverProcess.on("exit", (code, signal) => {
    log("Next.js server exited. code=" + code + " signal=" + signal);
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        "Local application server stopped",
        "The application server stopped unexpectedly. Please close and reopen Long Beach Hotel Assistant."
      );
    }
  });
}

function registerSafeDesktopApi() {
  ipcMain.handle("desktop:get-app-info", () => ({
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform
  }));

  ipcMain.handle("desktop:select-files", async (_event, options = {}) => {
    const allowed = ["xml", "xlsx", "xls", "pdf", "msg", "docx", "doc", "txt", "csv"];
    const requested = Array.isArray(options.extensions)
      ? options.extensions.filter(ext => allowed.includes(String(ext).replace(/^\./, "").toLowerCase()))
      : allowed;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select hotel files",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Supported hotel files", extensions: requested.length ? requested : allowed }]
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("desktop:select-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select a folder",
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("desktop:list-folder-files", async (_event, rootPath) => {
    if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) throw new Error("Invalid folder path.");
    const root = path.resolve(rootPath);
    const rootStat = await fs.promises.stat(root);
    if (!rootStat.isDirectory()) throw new Error("The selected path is not a folder.");
    const allowed = new Set(["pdf", "docx", "msg", "txt", "csv", "xml", "html", "htm", "eml", "log"]);
    const results = [];
    const queue = [root];
    const maxFiles = 20000;
    while (queue.length) {
      const current = queue.pop();
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith("~$") || entry.name.startsWith(".")) continue;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).slice(1).toLowerCase();
        if (!allowed.has(extension)) continue;
        const stat = await fs.promises.stat(absolute);
        results.push({
          path: absolute,
          relativePath: path.relative(root, absolute).split(path.sep).join("/"),
          name: entry.name,
          size: stat.size,
          mtimeMs: stat.mtimeMs
        });
        if (results.length >= maxFiles) return results;
      }
    }
    return results;
  });

  ipcMain.handle("desktop:read-file", async (_event, rootPath, filePath) => {
    if (typeof rootPath !== "string" || typeof filePath !== "string"
      || !path.isAbsolute(rootPath) || !path.isAbsolute(filePath)) {
      throw new Error("Invalid file path.");
    }
    const root = path.resolve(rootPath);
    const target = path.resolve(filePath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("The requested file is outside the selected folder.");
    }
    const stat = await fs.promises.stat(target);
    if (!stat.isFile() || stat.size > 80 * 1024 * 1024) {
      throw new Error("The file is not supported or exceeds the 80 MB reading limit.");
    }
    return new Uint8Array(await fs.promises.readFile(target));
  });

  ipcMain.handle("desktop:open-path", async (_event, selectedPath) => {
    if (typeof selectedPath !== "string" || !path.isAbsolute(selectedPath) || !fs.existsSync(selectedPath)) {
      return false;
    }
    const result = await shell.openPath(selectedPath);
    return result === "";
  });

  ipcMain.handle("desktop:show-in-folder", async (_event, selectedPath) => {
    if (typeof selectedPath !== "string" || !path.isAbsolute(selectedPath) || !fs.existsSync(selectedPath)) {
      return false;
    }
    shell.showItemInFolder(selectedPath);
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    title: "Long Beach Hotel Assistant",
    backgroundColor: "#f5f7fa",
    webPreferences: {
      preload: path.join(app.getAppPath(), "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL("http://" + HOST + ":" + serverPort);
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  app.setAppUserModelId("com.longbeach.hotelassistant");
  registerSafeDesktopApi();
  try {
    serverPort = await getFreePort();
    startLocalServer(serverPort);
    await waitForServer(serverPort);
    createWindow();
  } catch (error) {
    log("Startup failed: " + (error && error.stack ? error.stack : String(error)));
    dialog.showErrorBox(
      "Long Beach Hotel Assistant could not start",
      String(error && error.message ? error.message : error) + "\n\nSee the desktop.log file in the application data folder for details."
    );
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow();
});

app.on("before-quit", () => {
  quitting = true;
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
