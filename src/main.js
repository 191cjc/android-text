const { app, BrowserWindow, ipcMain, session, webFrameMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { startLocalServer, findExternalPolicy } = require("./local-server");
const { state } = require("./app-state");
const { classifyOffline4399Api } = require("./offline-4399-api");
const { createRuffleConfig } = require("./ruffle-config");

let mainWindow;
let serverInfo;
const logDir = path.join(state.projectRoot, "logs");
const logFile = path.join(logDir, "runtime.log");

function writeLog(...parts) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    logFile,
    `${new Date().toISOString()} ${parts.map(String).join(" ")}\n`
  );
}

async function createWindow() {
  if (state.mode === "remote" && state.activeMod === "vanilla") {
    state.activeMod = process.env.APP_MOD || "local";
  }
  serverInfo = await startLocalServer();
  writeLog("server", serverInfo.url);
  await session.defaultSession.clearCache();
  writeLog("cache-cleared");
  configureNetworkInterception(serverInfo.url);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#101214",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
    writeLog("did-fail-load", code, desc, url);
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    writeLog("console", level, message, `${sourceId}:${line}`);
  });

  mainWindow.webContents.on("did-frame-finish-load", async (_event, isMainFrame, processId, routingId) => {
    if (state.mode !== "remote") {
      return;
    }

    const frame = webFrameMain.fromId(processId, routingId);
    if (!frame || frame.isDestroyed()) {
      return;
    }

    await injectRuffleIntoFrame(frame).catch((error) => {
      writeLog("inject-failed", frame.url, error.message);
    });
  });

  const startUrl = state.mode === "remote" ? state.remotePageUrl : serverInfo.url;
  await mainWindow.loadURL(startUrl);
  writeLog("loaded", startUrl);

  scheduleAutoScreenshot();
  scheduleAutoActions();
}

function scheduleAutoScreenshot() {
  const screenshotPath = process.env.AUTO_SCREENSHOT_PATH;
  if (!screenshotPath || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const delayMs = Number.parseInt(process.env.AUTO_SCREENSHOT_DELAY_MS || "15000", 10);
  const resolvedPath = path.resolve(state.projectRoot, screenshotPath);
  writeLog("auto-screenshot-scheduled", resolvedPath, `delay=${delayMs}`);

  setTimeout(async () => {
    try {
      const image = await mainWindow.webContents.capturePage();
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, image.toPNG());
      writeLog("auto-screenshot-saved", resolvedPath);
    } catch (error) {
      writeLog("auto-screenshot-failed", error.message);
    }

    if (process.env.AUTO_QUIT_AFTER_SCREENSHOT !== "0") {
      app.quit();
    }
  }, Number.isFinite(delayMs) ? delayMs : 15000);
}

function scheduleAutoActions() {
  const rawActions = process.env.AUTO_ACTIONS_JSON;
  if (!rawActions || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  let actions;
  try {
    actions = JSON.parse(rawActions);
  } catch (error) {
    writeLog("auto-actions-invalid", error.message);
    return;
  }

  if (!Array.isArray(actions)) {
    writeLog("auto-actions-invalid", "AUTO_ACTIONS_JSON must be an array");
    return;
  }

  for (const action of actions) {
    const atMs = Number.parseInt(String(action.atMs || action.at || 0), 10);
    setTimeout(() => {
      runAutoAction(action).catch((error) => {
        writeLog("auto-action-failed", action.type, error.message);
      });
    }, Number.isFinite(atMs) ? atMs : 0);
  }
}

async function runAutoAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (action.type === "click") {
    const x = Number(action.x);
    const y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("click requires numeric x/y");
    }
    mainWindow.webContents.sendInputEvent({ type: "mouseMove", x, y });
    mainWindow.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    mainWindow.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    writeLog("auto-click", x, y, action.label || "");
    return;
  }

  if (action.type === "screenshot") {
    if (!action.path) {
      throw new Error("screenshot requires path");
    }
    const resolvedPath = path.resolve(state.projectRoot, action.path);
    const image = await mainWindow.webContents.capturePage();
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, image.toPNG());
    writeLog("auto-screenshot-saved", resolvedPath, action.label || "");
    return;
  }

  if (action.type === "quit") {
    writeLog("auto-quit", action.label || "");
    app.quit();
    return;
  }

  throw new Error(`unknown action type ${action.type}`);
}

async function injectRuffleIntoFrame(frame) {
  const isGameFrame = /^https:\/\/sbai\.4399\.com\/4399swf\/upload_swf\/ftp10\/honghao\/20130530\/27\/jjxzfcms\.htm/i.test(frame.url);
  if (!isGameFrame) {
    return;
  }

  const ruffleConfig = createRuffleConfig(serverInfo.url);
  const code = `
    (() => {
      if (window.__localRuffleInjected) return "already";
      window.__localRuffleInjected = true;
      window.RufflePlayer = window.RufflePlayer || {};
      window.RufflePlayer.config = ${JSON.stringify(ruffleConfig)};
      const script = document.createElement("script");
      script.src = ${JSON.stringify(`${serverInfo.url}ruffle/ruffle.js`)};
      script.dataset.localRuffle = "true";
      (document.head || document.documentElement).appendChild(script);
      const loadPanel = () => {
        const panelScript = document.createElement("script");
        panelScript.src = ${JSON.stringify(`${serverInfo.url}public/dark-pet-panel.js`)};
        panelScript.charset = "utf-8";
        panelScript.dataset.localDarkPetPanel = "true";
        (document.head || document.documentElement).appendChild(panelScript);
      };
      const petListScript = document.createElement("script");
      petListScript.src = ${JSON.stringify(`${serverInfo.url}public/pet-list.js`)};
      petListScript.charset = "utf-8";
      petListScript.dataset.localPetList = "true";
      petListScript.onload = loadPanel;
      petListScript.onerror = loadPanel;
      (document.head || document.documentElement).appendChild(petListScript);
      return "injected";
    })();
  `;

  const result = await frame.executeJavaScript(code);
  writeLog("inject", result, frame.url, `fonts=${ruffleConfig.fontSources.length}`, `deviceFontRenderer=${ruffleConfig.deviceFontRenderer}`);
}

async function logLoginSnapshot(reason) {
  try {
    const cookies = await session.defaultSession.cookies.get({});
    const relatedCookies = cookies
      .filter((cookie) => cookie.domain.includes("4399"))
      .map((cookie) => `${cookie.name}@${cookie.domain}`)
      .sort();

    writeLog(
      "login-cookie-summary",
      reason,
      `count=${relatedCookies.length}`,
      `names=${relatedCookies.join(",") || "none"}`
    );
  } catch (error) {
    writeLog("login-cookie-summary-failed", reason, error.message);
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    const pageState = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const uid = window.UniLogin && typeof window.UniLogin.getUid === "function"
          ? String(window.UniLogin.getUid())
          : "unavailable";
        const cookieNames = document.cookie
          .split(";")
          .map((item) => item.trim().split("=")[0])
          .filter(Boolean)
          .sort();
        return {
          href: location.href,
          uid,
          cookieNames
        };
      })();
    `);
    writeLog(
      "login-page-summary",
      reason,
      `uid=${pageState.uid}`,
      `cookies=${pageState.cookieNames.join(",") || "none"}`,
      pageState.href
    );
  } catch (error) {
    writeLog("login-page-summary-failed", reason, error.message);
  }
}

function configureNetworkInterception(localBaseUrl) {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      writeLog("request", details.method, details.url);

      const offline4399Target = classifyOffline4399Api(details.url);
      if (offline4399Target) {
        if (state.mode === "remote" && !shouldUseOffline4399InRemote(offline4399Target)) {
          writeLog("remote-official-4399", offline4399Target.kind, details.method, details.url);
          callback({});
          return;
        }

        const noWrite = state.mode === "remote" && offline4399Target.kind === "offline-save-set"
          ? "&noWrite=1"
          : "";
        const redirectURL = `${localBaseUrl}offline-4399?url=${encodeURIComponent(details.url)}${noWrite}`;
        writeLog("redirect-offline-4399", offline4399Target.kind, details.method, details.url, redirectURL);
        callback({ redirectURL });
        return;
      }

      const officialCorsTarget = classifyOfficialCorsTarget(details.url);
      if (state.mode === "remote" && officialCorsTarget) {
        writeLog("official-cors-request", officialCorsTarget.kind, details.method, details.url);
        logLoginSnapshot(`official-cors:${officialCorsTarget.kind}`).catch((error) => {
          writeLog("login-snapshot-failed", error.message);
        });
      }

      if (state.mode === "remote" && isFlashFallbackUrl(details.url)) {
        const redirectURL = details.url.endsWith(".js")
          ? `${localBaseUrl}public/noop.js`
          : `${localBaseUrl}public/blank.html`;
        writeLog("redirect-flash-fallback", details.url, redirectURL);
        callback({ redirectURL });
        return;
      }

      if (
        state.mode === "remote" &&
        details.url.startsWith(`${state.sourceBaseUrl}${state.remoteSwfFileName}`)
      ) {
        const redirectURL = `${localBaseUrl}game/${state.remoteSwfFileName}?v=${localAssetVersion(state.remoteSwfFileName)}`;
        writeLog("redirect-game", details.url, redirectURL);
        callback({ redirectURL });
        return;
      }

      let policy = null;
      try {
        policy = findExternalPolicy(details.url);
      } catch {
        policy = null;
      }

      if (!policy) {
        callback({});
        return;
      }

      const redirectURL = `${localBaseUrl}external?url=${encodeURIComponent(details.url)}&v=${externalAssetVersion(details.url)}`;
      writeLog("redirect", details.url, redirectURL);
      callback({ redirectURL });
    }
  );

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["https://save.api.4399.com/*", "https://my.4399.com/*"] },
    (details, callback) => {
      const officialCorsTarget = classifyOfficialCorsTarget(details.url);
      if (state.mode === "remote" && officialCorsTarget) {
        addSessionCookiesToRequest(details, officialCorsTarget)
          .then((requestHeaders) => {
            callback({ requestHeaders });
          })
          .catch((error) => {
            writeLog("official-cors-headers-failed", officialCorsTarget.kind, details.url, error.message);
            callback({ requestHeaders: details.requestHeaders });
          });
        return;
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders || {};
    if (state.mode === "remote" && /^https?:\/\/(www\.)?4399\.com\//.test(details.url)) {
      delete responseHeaders["content-security-policy"];
      delete responseHeaders["Content-Security-Policy"];
      delete responseHeaders["x-frame-options"];
      delete responseHeaders["X-Frame-Options"];
    }
    if (state.mode === "remote" && isLegacy4399PageUrl(details.url)) {
      responseHeaders["Origin-Agent-Cluster"] = ["?0"];
    }
    const officialCorsTarget = classifyOfficialCorsTarget(details.url);
    if (state.mode === "remote" && officialCorsTarget) {
      exposeToGameFrame(responseHeaders);
      writeLog("official-cors-exposed", officialCorsTarget.kind, details.statusCode, details.url);
    }
    callback({ responseHeaders });
  });
}

function isFlashFallbackUrl(url) {
  return (
    /^https:\/\/www\.4399\.com\/jss\/flashopen1\.js/i.test(url) ||
    /^https:\/\/www\.4399\.com\/loadimg\/blockflashtip\.html/i.test(url) ||
    /^https:\/\/www\.4399\.com\/loadimg\/noInstallFlashIE\.html/i.test(url) ||
    /^https:\/\/www\.4399\.com\/httpsNot301\/flashdist\.js/i.test(url)
  );
}

function localAssetVersion(relativePath) {
  const candidates = [
    path.join(state.projectRoot, "modified", state.activeMod, relativePath),
    path.join(state.projectRoot, "modified", relativePath),
    path.join(state.projectRoot, "original", relativePath),
  ];

  for (const candidate of candidates) {
    try {
      return String(Math.trunc(fs.statSync(candidate).mtimeMs));
    } catch {
      // Try the next local source candidate.
    }
  }

  return String(Date.now());
}

function externalAssetVersion(remoteUrl) {
  try {
    const parsed = new URL(remoteUrl);
    const relativePath = path.join("external", parsed.hostname, decodeURIComponent(parsed.pathname)).replace(/^[/\\]+/, "");
    return localAssetVersion(relativePath);
  } catch {
    return String(Date.now());
  }
}

function classifyOfficialCorsTarget(url) {
  try {
    const parsed = new URL(url);
    const ac = parsed.searchParams.get("ac");

    if (parsed.hostname === "my.4399.com" && parsed.pathname === "/services/game-play") {
      return { kind: "platform-game-play" };
    }

    if (parsed.hostname !== "save.api.4399.com") {
      return null;
    }

    if (
      parsed.pathname === "/auth/openapi.php" &&
      parsed.searchParams.get("method") === "User.Authenticate"
    ) {
      return { kind: "save-authenticate" };
    }

    if (parsed.pathname === "/" && ac === "get_session") {
      return { kind: "save-get-session" };
    }

    if (parsed.pathname === "/" && ac === "check_session") {
      return { kind: "save-check-session" };
    }

    if (parsed.pathname === "/index.php" && ac === "get_token") {
      return { kind: "save-get-token" };
    }

    if (parsed.pathname === "/" && ac === "get_list") {
      return { kind: "save-get-list" };
    }

    if (parsed.pathname === "/" && ac === "get") {
      return { kind: "save-get" };
    }

    if (
      parsed.pathname === "/exchange/v2/flash/GetMoney" ||
      parsed.pathname === "/exchange/v2/flash/GetTotalPay" ||
      parsed.pathname === "/exchange/v2/flash/GetTotalRecharge"
    ) {
      return { kind: "payment-query-official-readonly" };
    }

    return null;
  } catch {
    return null;
  }
}

function shouldUseOffline4399InRemote(target) {
  return [
    "offline-save-set",
    "offline-payment-disabled",
  ].includes(target.kind);
}

function isLegacy4399PageUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith("4399.com") ||
      parsed.hostname.endsWith("3304399.net") ||
      parsed.hostname === "sbai.4399.com"
    );
  } catch {
    return false;
  }
}

function exposeToGameFrame(responseHeaders) {
  for (const key of Object.keys(responseHeaders)) {
    if (/^access-control-/i.test(key)) {
      delete responseHeaders[key];
    }
  }

  responseHeaders["Access-Control-Allow-Origin"] = ["https://sbai.4399.com"];
  responseHeaders["Access-Control-Allow-Credentials"] = ["true"];
  responseHeaders["Access-Control-Allow-Methods"] = ["GET,POST,OPTIONS"];
  responseHeaders["Access-Control-Allow-Headers"] = [
    "Content-Type, X-Requested-With, Origin, Accept, Authorization",
  ];
  responseHeaders["Access-Control-Expose-Headers"] = ["Content-Type, Content-Length, Date"];
  responseHeaders["Vary"] = ["Origin"];
}

async function addSessionCookiesToRequest(details, officialCorsTarget) {
  const requestHeaders = { ...details.requestHeaders };
  const existingCookie = requestHeaders.Cookie || requestHeaders.cookie;
  if (existingCookie) {
    writeLog(
      "official-cors-headers",
      officialCorsTarget.kind,
      `origin=${requestHeaders.Origin || requestHeaders.origin || "none"}`,
      `referer=${requestHeaders.Referer || requestHeaders.referer || "none"}`,
      "cookie=present"
    );
    return requestHeaders;
  }

  const cookies = await session.defaultSession.cookies.get({
    url: cookieLookupUrl(details.url),
  });
  const validCookies = cookies.filter((cookie) => !cookie.expirationDate || cookie.expirationDate > Date.now() / 1000);
  if (validCookies.length > 0) {
    requestHeaders.Cookie = validCookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  writeLog(
    "official-cors-headers",
    officialCorsTarget.kind,
    `origin=${requestHeaders.Origin || requestHeaders.origin || "none"}`,
    `referer=${requestHeaders.Referer || requestHeaders.referer || "none"}`,
    `cookie=${requestHeaders.Cookie ? "attached" : "missing"}`,
    `cookieNames=${validCookies.map((cookie) => cookie.name).sort().join(",") || "none"}`
  );

  return requestHeaders;
}

function cookieLookupUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}${parsed.pathname || "/"}`;
}

ipcMain.handle("get-app-state", () => ({
  ...state,
  requestLog: state.requestLog.slice(0, 100),
}));

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
