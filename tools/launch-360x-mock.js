const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const net = require("net");

const projectRoot = path.resolve(__dirname, "..");
const officialGameUrl = "https://www.4399.com/flash/115225_2.htm";
const defaultDebugPort = 9223;
const isolatedUserDataDir = path.join(projectRoot, ".browser-data", "360x-mock");
const mockSaveStorePath = path.join(projectRoot, "data", "runtime-mock-saves.json");

function browserCandidates() {
  const env = process.env;
  return [
    env.BROWSER_360X_PATH,
    path.join(env.LOCALAPPDATA || "", "360ChromeX", "Chrome", "Application", "360ChromeX.exe"),
    path.join(env.LOCALAPPDATA || "", "360ChromeX", "Application", "360ChromeX.exe"),
    path.join(env.ProgramFiles || "", "360ChromeX", "Chrome", "Application", "360ChromeX.exe"),
    path.join(env["ProgramFiles(x86)"] || "", "360ChromeX", "Chrome", "Application", "360ChromeX.exe"),
    path.join(env.ProgramFiles || "", "360", "360ChromeX", "Chrome", "Application", "360ChromeX.exe"),
    path.join(env["ProgramFiles(x86)"] || "", "360", "360ChromeX", "Chrome", "Application", "360ChromeX.exe"),
  ].filter(Boolean);
}

function findBrowser() {
  const browserPath = browserCandidates().find((candidate) => fs.existsSync(candidate));
  if (!browserPath) {
    throw new Error("360 Extreme Browser X was not found. Set BROWSER_360X_PATH to 360ChromeX.exe.");
  }
  return browserPath;
}

function getRunning360XProcessIds() {
  if (process.platform !== "win32") {
    return [];
  }

  const ids = new Set();

  try {
    const output = execFileSync("tasklist", [
      "/FI",
      "IMAGENAME eq 360ChromeX.exe",
      "/FO",
      "CSV",
      "/NH",
    ], {
      encoding: "utf8",
      windowsHide: true,
    });

    for (const id of output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => line.match(/^"?360ChromeX\.exe"?,"?(\d+)"?/i)?.[1])
      .filter(Boolean)) {
      ids.add(id);
    }
  } catch {
    // Fall through to PowerShell, which is more reliable on localized Windows.
  }

  try {
    const output = execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      "Get-Process -Name 360ChromeX -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }",
    ], {
      encoding: "utf8",
      windowsHide: true,
    });

    for (const id of output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      ids.add(id);
    }
  } catch {
    // Ignore fallback failures.
  }

  return [...ids];
}

function running360XAdvice(pids) {
  const pidLine = pids.length > 0 ? `\nRunning 360X process ids: ${pids.join(", ")}` : "";
  return (
    "360X is already running without the required remote debugging port.\n" +
    "Close every 360X window, wait until 360ChromeX.exe disappears from Task Manager, then run `npm run start:360:mock` again.\n" +
    "Your normal 360X login state is stored in the browser profile and will not be deleted by closing the browser.\n" +
    "If you need to keep the current 360X session open, use `npm run start:360:mock:isolated` and log in once inside that isolated window." +
    pidLine
  );
}

function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      timeout: 3000,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Timed out connecting to CDP port ${port}`));
    });
    req.on("error", reject);
  });
}

async function waitForJson(port, pathname, timeoutMs = 12000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await getJson(port, pathname);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw lastError || new Error(`Timed out waiting for ${pathname}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.addEventListener("open", () => {
        resolve();
      }, { once: true });

      this.ws.addEventListener("message", (event) => {
        this.handleMessage(String(event.data));
      });

      this.ws.addEventListener("close", () => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error("CDP connection closed"));
        }
        this.pending.clear();
      });

      this.ws.addEventListener("error", () => {
        reject(new Error(`Failed to connect to ${this.wsUrl}`));
      }, { once: true });
    });
  }

  on(method, handler) {
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(payload);
    });
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const handlers = this.handlers.get(message.method) || [];
    for (const handler of handlers) {
      Promise.resolve(handler(message.params)).catch((error) => {
        console.error(`[cdp:${message.method}]`, error.message);
      });
    }
  }
}

function buildPanelSource() {
  const petListSource = fs.readFileSync(path.join(projectRoot, "public", "pet-list.js"), "utf8");
  const fashionItemListSource = buildFashionItemListSource();
  const panelSource = fs.readFileSync(path.join(projectRoot, "public", "dark-pet-panel.js"), "utf8");
  return `
(() => {
  try {
    const isOfficialPage = /\\/flash\\/115225_2\\.htm/i.test(location.href);
    if (isOfficialPage) {
      const restoreGameFrame = () => {
        window.showBlockFlash = function () {};
        window.showBlockFlashIE = function () {};
        const blockedFrame = document.querySelector("#swfdiv iframe[src*='blockflashtip'], #swfdiv iframe[src*='noInstallFlashIE']");
        if (!blockedFrame) {
          return;
        }
        const swfdiv = document.getElementById("swfdiv");
        if (swfdiv) {
          swfdiv.style.paddingTop = "";
          swfdiv.innerHTML = window.old_swfdiv_html || "<div id='pusher'></div><center id='game'><iframe id='flash22' align='center' width='960' height='600' src='//sbai.4399.com/4399swf/upload_swf/ftp10/honghao/20130530/27/jjxzfcms.htm' frameborder='no' border='0' marginwidth='0' marginheight='0' scrolling='no'></iframe></center>";
        }
        const addiv = document.getElementById("addiv");
        if (addiv) {
          addiv.innerHTML = window.old_addiv_html || "";
        }
        const loadingdiv = document.getElementById("loadingdiv");
        if (loadingdiv) {
          loadingdiv.style.display = "none";
        }
        const fullscreen = document.getElementById("ifull");
        if (fullscreen) {
          fullscreen.style.display = "";
        }
      };
      restoreGameFrame();
      window.setInterval(restoreGameFrame, 100);
    }
  } catch {}
  const isGameFrame = /\\/4399swf\\/upload_swf\\/ftp10\\/honghao\\/20130530\\/27\\/jjxzfcms\\.htm/i.test(location.href);
  if (!isGameFrame) {
    return;
  }
  ${petListSource}
  ${fashionItemListSource}
  ${panelSource}
})();
`;
}

function readXmlTag(block, tagName) {
  const open = `<${tagName}>`;
  const close = `</${tagName}>`;
  const start = block.indexOf(open);
  if (start < 0) {
    return "";
  }
  const end = block.indexOf(close, start + open.length);
  if (end < 0) {
    return "";
  }
  return block
    .slice(start + open.length, end)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .trim();
}

function buildFashionItemListSource() {
  const xmlPath = path.join(projectRoot, "assets", "exported", "dataxmlvav447", "binary", "15_DefineBinaryData.bin");
  let items = [];
  try {
    const xml = fs.readFileSync(xmlPath, "utf8");
    items = xml
      .split("<物品>")
      .slice(1)
      .map((chunk) => `<物品>${chunk.split("</物品>")[0]}</物品>`)
      .map((block) => ({
        id: Number.parseInt(readXmlTag(block, "id"), 10),
        name: readXmlTag(block, "名称"),
        type: Number.parseInt(readXmlTag(block, "类型"), 10),
        smallType: Number.parseInt(readXmlTag(block, "小类型"), 10),
        bag: Number.parseInt(readXmlTag(block, "背包"), 10),
        stack: Number.parseInt(readXmlTag(block, "叠加数"), 10),
        price: Number.parseInt(readXmlTag(block, "价格"), 10),
        canUse: readXmlTag(block, "是否使用") === "true",
      }))
      .filter((item) => Number.isFinite(item.id))
      .sort((a, b) => a.id - b.id);
  } catch (error) {
    console.warn(`Item list unavailable: ${error.message}`);
  }

  const fashionItems = items.filter((item) => item.bag === 3);
  return [
    `window.__codexItemList = ${JSON.stringify(items)};`,
    `window.__codexFashionItemList = ${JSON.stringify(fashionItems)};`,
    `window.__codexBagMockUiEnabled = ${process.env.LAUNCH_360X_DISABLE_BAG_UI === "1" ? "false" : "true"};`,
  ].join("\n");
}

function isSaveApiUrl(url) {
  try {
    return new URL(url).hostname === "save.api.4399.com";
  } catch {
    return false;
  }
}

function isFlashFallbackUrl(url) {
  return (
    /^https?:\/\/www\.4399\.com\/jss\/flashopen1\.js/i.test(url) ||
    /^https?:\/\/www\.4399\.com\/loadimg\/blockflashtip\.html/i.test(url) ||
    /^https?:\/\/www\.4399\.com\/loadimg\/noInstallFlashIE\.html/i.test(url) ||
    /^https?:\/\/www\.4399\.com\/httpsNot301\/flashdist\.js/i.test(url)
  );
}

function flashFallbackResponseFor(url) {
  const isScript = /\.js(?:[?#]|$)/i.test(url);
  const body = isScript
    ? "/* Flash fallback detection suppressed by local mock launcher. */\n"
    : "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>";
  return {
    contentType: isScript ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8",
    body,
  };
}

function compactBody(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function nowText() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(":");
}

function saveApiLabel(url) {
  try {
    const parsed = new URL(url);
    const ac = parsed.searchParams.get("ac");
    const method = parsed.searchParams.get("method");
    if (ac) {
      return ac;
    }
    if (method) {
      return method;
    }
    return parsed.pathname || "/";
  } catch {
    return "unknown";
  }
}

const saveIndexKeys = ["index", "idx", "i", "slot"];
const saveDataKeys = ["data", "content", "value", "saveData", "savedata", "save", "gameData", "gamedata"];
const saveMetaKeys = [
  ["title", "title"],
  ["name", "title"],
  ["save_name", "title"],
  ["savename", "title"],
  ["datetime", "datetime"],
  ["time", "datetime"],
  ["status", "status"],
];

function parseUrlParams(url) {
  try {
    return new URL(url).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function parseBodyParams(postData) {
  if (typeof postData !== "string" || postData.length === 0) {
    return new URLSearchParams();
  }
  return new URLSearchParams(postData);
}

function mergedRequestParams(url, postData) {
  const merged = new URLSearchParams(parseUrlParams(url));
  for (const [key, value] of parseBodyParams(postData)) {
    merged.append(key, value);
  }
  return merged;
}

function saveApiRequestLabel(url, postData) {
  const params = mergedRequestParams(url, postData);
  return params.get("ac") || params.get("method") || saveApiLabel(url);
}

function pickSaveIndexFromParams(params, fallback = null) {
  for (const key of saveIndexKeys) {
    const raw = params.get(key);
    if (raw == null || raw === "") {
      continue;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(parsed, 7);
    }
  }
  return fallback;
}

function pickSaveIndexFromRequest(url, postData, fallback = null) {
  return pickSaveIndexFromParams(mergedRequestParams(url, postData), fallback);
}

function paramsSummary(url, postData) {
  const params = mergedRequestParams(url, postData);
  const parts = [];
  for (const [key, value] of params.entries()) {
    parts.push(`${key}:${Buffer.byteLength(String(value), "utf8")}`);
  }
  return parts.length > 0 ? parts.join(", ") : "(none)";
}

function dataFieldValue(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  for (const key of saveDataKeys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function parseJsonLike(text) {
  const trimmed = String(text || "").trim().replace(/^\uFEFF/, "");
  if (!trimmed || trimmed === "0") {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.search(/[\[{]/);
    const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function saveRecordsFromParsed(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => saveRecordsFromParsed(item));
  }

  if (typeof value !== "object") {
    return [];
  }

  if (typeof dataFieldValue(value) === "string") {
    return [value];
  }

  const nestedKeys = ["ret", "data", "list", "dataList", "saveList", "items", "rows"];
  for (const key of nestedKeys) {
    const nested = value[key];
    if (nested && typeof nested === "object") {
      const records = saveRecordsFromParsed(nested);
      if (records.length > 0) {
        return records;
      }
    }
  }

  return [];
}

function saveRecordsFromResponse(text) {
  return saveRecordsFromParsed(parseJsonLike(text));
}

function readMockSaveStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(mockSaveStorePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { slots: {} };
  } catch {
    return { slots: {} };
  }
}

function writeMockSaveStore(store) {
  fs.mkdirSync(path.dirname(mockSaveStorePath), { recursive: true });
  fs.writeFileSync(mockSaveStorePath, JSON.stringify(store, null, 2));
}

function mockSlotRecord(index) {
  const store = readMockSaveStore();
  const record = store.slots?.[String(index)];
  if (!record || typeof record.data !== "string" || record.data.length === 0) {
    return null;
  }
  return {
    index,
    title: typeof record.title === "string" && record.title ? record.title : `Mock Save ${index + 1}`,
    datetime: typeof record.datetime === "string" && record.datetime ? record.datetime : nowText(),
    data: record.data,
    status: record.status == null ? "0" : String(record.status),
  };
}

function writeMockSlotFromRequest(url, postData) {
  const params = mergedRequestParams(url, postData);
  const index = pickSaveIndexFromParams(params, 0);
  const data = dataFieldValue(Object.fromEntries(params.entries()));
  if (typeof data !== "string" || data.length === 0) {
    return null;
  }

  const store = readMockSaveStore();
  store.slots = store.slots || {};
  const previous = store.slots[String(index)] || {};
  const title = params.get("title")
    || params.get("name")
    || params.get("save_name")
    || params.get("savename")
    || previous.title
    || `Mock Save ${index + 1}`;
  const datetime = nowText();

  store.slots[String(index)] = {
    index,
    title,
    datetime,
    data,
    status: params.get("status") || previous.status || "0",
  };
  writeMockSaveStore(store);

  return {
    index,
    title,
    datetime,
    dataBytes: Buffer.byteLength(data, "utf8"),
  };
}

function withMockRecord(record, fallbackIndex = null) {
  const index = pickSaveIndexFromRecord(record, fallbackIndex);
  if (index == null) {
    return record;
  }
  const mock = mockSlotRecord(index);
  if (!mock) {
    return record;
  }
  return {
    ...(record && typeof record === "object" ? record : {}),
    ...mock,
  };
}

function replaceSaveRecordsWithMock(value, fallbackIndex = null) {
  if (!value) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => replaceSaveRecordsWithMock(item, index));
  }

  if (typeof value !== "object") {
    return value;
  }

  if (typeof dataFieldValue(value) === "string") {
    return withMockRecord(value, fallbackIndex);
  }

  const clone = { ...value };
  const nestedKeys = ["ret", "data", "list", "dataList", "saveList", "items", "rows"];
  for (const key of nestedKeys) {
    if (clone[key] && typeof clone[key] === "object") {
      clone[key] = replaceSaveRecordsWithMock(clone[key], fallbackIndex);
    }
  }
  return clone;
}

function allMockSlotRecords() {
  const store = readMockSaveStore();
  const slots = [];
  for (const key of Object.keys(store.slots || {})) {
    const parsed = Number.parseInt(key, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      const record = mockSlotRecord(parsed);
      if (record) {
        slots.push(record);
      }
    }
  }
  return slots.sort((left, right) => left.index - right.index);
}

function mergeMockRecordsIntoArray(value) {
  const array = Array.isArray(value) ? [...value] : [];
  for (const record of allMockSlotRecords()) {
    const existingIndex = array.findIndex((item) => pickSaveIndexFromRecord(item, null) === record.index);
    if (existingIndex >= 0) {
      array[existingIndex] = { ...(array[existingIndex] || {}), ...record };
    } else {
      array.push(record);
    }
  }
  return array.sort((left, right) => {
    const leftIndex = pickSaveIndexFromRecord(left, 999);
    const rightIndex = pickSaveIndexFromRecord(right, 999);
    return leftIndex - rightIndex;
  });
}

function mockGetResponseBody(originalText, fallbackIndex = 0) {
  const parsed = parseJsonLike(originalText);
  if (!parsed) {
    const mock = mockSlotRecord(fallbackIndex);
    return mock ? JSON.stringify(mock) : originalText;
  }
  return JSON.stringify(replaceSaveRecordsWithMock(parsed, fallbackIndex));
}

function mockGetListResponseBody(originalText) {
  const parsed = parseJsonLike(originalText);
  if (!parsed) {
    const mockRecords = allMockSlotRecords();
    return mockRecords.length > 0 ? JSON.stringify(mockRecords) : originalText;
  }
  if (Array.isArray(parsed)) {
    return JSON.stringify(mergeMockRecordsIntoArray(parsed));
  }
  if (parsed && typeof parsed === "object") {
    const clone = replaceSaveRecordsWithMock(parsed);
    const nestedKeys = ["ret", "data", "list", "dataList", "saveList", "items", "rows"];
    for (const key of nestedKeys) {
      if (Array.isArray(clone[key])) {
        clone[key] = mergeMockRecordsIntoArray(clone[key]);
        return JSON.stringify(clone);
      }
    }
  }
  return JSON.stringify(replaceSaveRecordsWithMock(parsed));
}

function pickSaveIndexFromRecord(record, fallback = null) {
  if (!record || typeof record !== "object") {
    return fallback;
  }
  const params = new URLSearchParams();
  for (const key of saveIndexKeys) {
    if (record[key] != null) {
      params.set(key, String(record[key]));
    }
  }
  return pickSaveIndexFromParams(params, fallback);
}

function cacheOriginalSave(cache, record, fallbackIndex, source) {
  const data = dataFieldValue(record);
  const index = pickSaveIndexFromRecord(record, fallbackIndex);
  if (index == null || typeof data !== "string" || data.length === 0) {
    return null;
  }

  const item = {
    index,
    data,
    title: typeof record.title === "string" ? record.title : "",
    datetime: typeof record.datetime === "string" ? record.datetime : "",
    status: record.status == null ? "" : String(record.status),
    source,
    cachedAt: Date.now(),
  };
  cache.byIndex.set(index, item);
  cache.last = item;
  console.log(`[mock-save] cached original slot ${index} from ${source}: data=${Buffer.byteLength(data, "utf8")} bytes`);
  return item;
}

function requestHeadersArray(headers, postData) {
  const entries = [];
  const seen = new Set();
  for (const [name, value] of Object.entries(headers || {})) {
    if (/^content-length$/i.test(name)) {
      continue;
    }
    seen.add(name.toLowerCase());
    entries.push({ name, value: String(value) });
  }

  if (typeof postData === "string") {
    entries.push({ name: "Content-Length", value: String(Buffer.byteLength(postData, "utf8")) });
  }

  if (!seen.has("content-type") && typeof postData === "string") {
    entries.push({ name: "Content-Type", value: "application/x-www-form-urlencoded" });
  }

  return entries;
}

function responseHeadersArray(headers) {
  const entries = [];
  const seen = new Set();
  for (const header of headers || []) {
    const name = header.name || "";
    if (/^(content-length|content-encoding)$/i.test(name)) {
      continue;
    }
    seen.add(name.toLowerCase());
    entries.push({ name, value: String(header.value || "") });
  }

  if (!seen.has("content-type")) {
    entries.push({ name: "Content-Type", value: "text/html; charset=utf-8" });
  }
  if (!seen.has("cache-control")) {
    entries.push({ name: "Cache-Control", value: "no-store, no-cache, must-revalidate" });
  }
  if (!seen.has("access-control-allow-origin")) {
    entries.push({ name: "Access-Control-Allow-Origin", value: "*" });
  }
  return entries;
}

function rewriteSaveRequestWithCache(requestUrl, postData, cached) {
  let parsedUrl;
  
  return {
    url: requestUrl,
    postData,
    replacements: [],
  };
  try {
    parsedUrl = new URL(requestUrl);
  } catch {
    return null;
  }

  const bodyParams = parseBodyParams(postData);
  const hasBody = typeof postData === "string";
  const replacements = [];

  for (const key of saveDataKeys) {
    if (bodyParams.has(key)) {
      bodyParams.set(key, cached.data);
      replacements.push(`body.${key}`);
    }
    if (parsedUrl.searchParams.has(key)) {
      parsedUrl.searchParams.set(key, cached.data);
      replacements.push(`url.${key}`);
    }
  }

  for (const [requestKey, cacheKey] of saveMetaKeys) {
    const value = cached[cacheKey];
    if (!value) {
      continue;
    }
    if (bodyParams.has(requestKey)) {
      bodyParams.set(requestKey, value);
      replacements.push(`body.${requestKey}`);
    }
    if (parsedUrl.searchParams.has(requestKey)) {
      parsedUrl.searchParams.set(requestKey, value);
      replacements.push(`url.${requestKey}`);
    }
  }

  if (replacements.length === 0) {
    return null;
  }

  return {
    url: parsedUrl.toString(),
    postData: hasBody ? bodyParams.toString() : null,
    replacements,
  };
}

async function fulfillProtectedSave(client, requestId, reason) {
  console.log(`[mock-save] save request was not sent to official API; SDK success returned (${reason}).`);
  await client.send("Fetch.fulfillRequest", {
    requestId,
    responseCode: 200,
    responsePhrase: "OK",
    responseHeaders: [
      { name: "Content-Type", value: "text/html; charset=utf-8" },
      { name: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
      { name: "Access-Control-Allow-Origin", value: "*" },
    ],
    body: Buffer.from("1", "utf8").toString("base64"),
  });
}

function enableMockSaveProtection(client) {
  const saveMode = process.env.LAUNCH_360X_MOCK_SAVE_MODE || "official-original";
  const localSessionMode = saveMode === "local-session";
  const cache = {
    byIndex: new Map(),
    last: null,
  };
  const tracked = new Map();

  client.on("Network.requestWillBeSent", (params) => {
    const request = params.request || {};
    if (!isSaveApiUrl(request.url || "")) {
      return;
    }

    const label = saveApiRequestLabel(request.url || "", request.postData || "");
    if (!["get", "get_list", "save"].includes(label)) {
      return;
    }

    tracked.set(params.requestId, {
      label,
      url: request.url || "",
      index: pickSaveIndexFromRequest(request.url || "", request.postData || "", label === "get" ? 0 : null),
    });
  });

  client.on("Network.loadingFinished", async (params) => {
    const item = tracked.get(params.requestId);
    if (!item) {
      return;
    }

    try {
      const body = await client.send("Network.getResponseBody", { requestId: params.requestId });
      const text = body.base64Encoded
        ? Buffer.from(body.body, "base64").toString("utf8")
        : body.body;

      if (item.label === "get" || item.label === "get_list") {
        const records = saveRecordsFromResponse(text);
        let cachedCount = 0;
        for (const record of records) {
          if (cacheOriginalSave(cache, record, item.index, item.label)) {
            cachedCount += 1;
          }
        }
        if (cachedCount === 0) {
          console.log(`[mock-save] ${item.label} response had no non-empty save data to cache.`);
        }
      } else if (item.label === "save") {
        console.log(`[mock-save] save response ${compactBody(text)}`);
      }
    } catch (error) {
      console.log(`[mock-save] response body unavailable for ${item.label}: ${error.message}`);
    } finally {
      tracked.delete(params.requestId);
    }
  });

  client.on("Network.loadingFailed", (params) => {
    tracked.delete(params.requestId);
  });

  return {
    async handlePausedRequest(params) {
      const request = params.request || {};
      const requestUrl = request.url || "";
      const postData = typeof request.postData === "string" ? request.postData : "";
      const label = saveApiRequestLabel(requestUrl, postData);
      const isResponseStage = typeof params.responseStatusCode === "number";

      if (isResponseStage) {
        if (!localSessionMode || !isSaveApiUrl(requestUrl) || !["get", "get_list"].includes(label)) {
          await client.send("Fetch.continueRequest", {
            requestId: params.requestId,
          });
          return;
        }

        try {
          const body = await client.send("Fetch.getResponseBody", { requestId: params.requestId });
          const originalText = body.base64Encoded
            ? Buffer.from(body.body, "base64").toString("utf8")
            : body.body;
          try {
            const index = pickSaveIndexFromRequest(requestUrl, postData, 0);
            const nextText = label === "get"
              ? mockGetResponseBody(originalText, index)
              : mockGetListResponseBody(originalText);
            if (nextText !== originalText) {
              console.log(`[mock-save] ${label} response overlaid with local mock session data.`);
            }
            await client.send("Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: params.responseStatusCode,
              responsePhrase: params.responseStatusText || "OK",
              responseHeaders: responseHeadersArray(params.responseHeaders),
              body: Buffer.from(nextText, "utf8").toString("base64"),
            });
          } catch (error) {
            console.log(`[mock-save] ${label} response overlay failed: ${error.message}`);
            await client.send("Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: params.responseStatusCode,
              responsePhrase: params.responseStatusText || "OK",
              responseHeaders: responseHeadersArray(params.responseHeaders),
              body: Buffer.from(originalText, "utf8").toString("base64"),
            });
          }
        } catch (error) {
          console.log(`[mock-save] ${label} response body unavailable for overlay: ${error.message}`);
          await client.send("Fetch.continueRequest", {
            requestId: params.requestId,
          });
        }
        return;
      }

      if (!isSaveApiUrl(requestUrl) || label !== "save") {
        await client.send("Fetch.continueRequest", {
          requestId: params.requestId,
        });
        return;
      }

      console.log(`[mock-save] outgoing save params ${paramsSummary(requestUrl, postData)}`);
      if (localSessionMode) {
        const saved = writeMockSlotFromRequest(requestUrl, postData);
        if (saved) {
          console.log(`[mock-save] local mock slot ${saved.index} saved (${saved.dataBytes} bytes); cloud not written.`);
        } else {
          console.log("[mock-save] save matched but no save data field was found; cloud not written.");
        }
        await fulfillProtectedSave(client, params.requestId, "local ack mode");
        return;
      }

      const index = pickSaveIndexFromRequest(requestUrl, postData, null);
      const cached = (index != null ? cache.byIndex.get(index) : null)
        || cache.last
        || cache.byIndex.get(0)
        || null;
      if (!cached) {
        await fulfillProtectedSave(client, params.requestId, "no original save cache");
        return;
      }

      const rewritten = rewriteSaveRequestWithCache(requestUrl, postData, cached);
      if (!rewritten) {
        await fulfillProtectedSave(client, params.requestId, "save payload field not found");
        return;
      }

      try {
        await client.send("Fetch.continueRequest", {
          requestId: params.requestId,
          url: rewritten.url,
          postData: rewritten.postData == null
            ? undefined
            : Buffer.from(rewritten.postData, "utf8").toString("base64"),
          headers: requestHeadersArray(request.headers, rewritten.postData),
        });
        console.log(
          `[mock-save] save slot ${cached.index} sanitized with cached original data ` +
          `(${rewritten.replacements.join(", ")}).`
        );
      } catch (error) {
        await fulfillProtectedSave(client, params.requestId, `rewrite failed: ${error.message}`);
      }
    },
  };
}

function enableOfficialSaveLogging(client) {
  const tracked = new Map();

  client.on("Network.requestWillBeSent", (params) => {
    const request = params.request || {};
    if (!isSaveApiUrl(request.url || "")) {
      return;
    }

    const postDataLength = typeof request.postData === "string"
      ? Buffer.byteLength(request.postData, "utf8")
      : 0;
    tracked.set(params.requestId, {
      method: request.method || "GET",
      url: request.url || "",
      label: saveApiLabel(request.url || ""),
      postDataLength,
    });
    console.log(
      `[save-test] request ${saveApiLabel(request.url || "")} ` +
      `${request.method || "GET"} ${request.url || ""}` +
      (postDataLength ? ` postData=${postDataLength} bytes` : "")
    );
  });

  client.on("Network.responseReceived", (params) => {
    const item = tracked.get(params.requestId);
    if (!item) {
      return;
    }

    const response = params.response || {};
    item.status = response.status;
    item.statusText = response.statusText || "";
    console.log(`[save-test] response ${item.label} ${response.status} ${response.statusText || ""} ${response.url || item.url}`);
  });

  client.on("Network.loadingFinished", async (params) => {
    const item = tracked.get(params.requestId);
    if (!item) {
      return;
    }

    try {
      const body = await client.send("Network.getResponseBody", { requestId: params.requestId });
      const text = body.base64Encoded
        ? Buffer.from(body.body, "base64").toString("utf8")
        : body.body;
      console.log(`[save-test] body ${item.label} ${compactBody(text)}`);
    } catch (error) {
      console.log(`[save-test] body ${item.label} unavailable: ${error.message}`);
    } finally {
      tracked.delete(params.requestId);
    }
  });

  client.on("Network.loadingFailed", (params) => {
    const item = tracked.get(params.requestId);
    if (!item) {
      return;
    }
    console.log(`[save-test] failed ${item.label} ${item.method} ${item.url}: ${params.errorText || "unknown"}`);
    tracked.delete(params.requestId);
  });
}

function fetchPatternsForMockSession() {
  const patterns = [
    {
      urlPattern: "*xfbbv451.swf*",
      requestStage: "Request",
    },
    {
      urlPattern: "*://www.4399.com/jss/flashopen1.js*",
      requestStage: "Request",
    },
    {
      urlPattern: "*://www.4399.com/loadimg/blockflashtip.html*",
      requestStage: "Request",
    },
    {
      urlPattern: "*://www.4399.com/loadimg/noInstallFlashIE.html*",
      requestStage: "Request",
    },
    {
      urlPattern: "*://www.4399.com/httpsNot301/flashdist.js*",
      requestStage: "Request",
    },
    {
      urlPattern: "*://save.api.4399.com/*",
      requestStage: "Request",
    },
  ];

  if (process.env.LAUNCH_360X_MOCK_SAVE_MODE === "local-session") {
    patterns.push({
      urlPattern: "*://save.api.4399.com/*",
      requestStage: "Response",
    });
  }

  return patterns;
}

async function findPageTarget(port) {
  const targets = await waitForJson(port, "/json/list");
  const page = targets.find((item) =>
    item.type === "page" &&
    item.webSocketDebuggerUrl &&
    item.url.includes("4399.com/flash/115225_2.htm")
  ) || targets.find((item) =>
    item.type === "page" &&
    item.webSocketDebuggerUrl &&
    item.url === "about:blank"
  ) || targets.find((item) =>
    item.type === "page" &&
    item.webSocketDebuggerUrl
  );

  if (!page) {
    throw new Error(`No debuggable page target found on port ${port}`);
  }

  return page;
}

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("This script requires a Node.js runtime with global WebSocket support.");
  }

  const browserPath = findBrowser();
  const debugPort = Number.parseInt(process.env.LAUNCH_360X_DEBUG_PORT || String(defaultDebugPort), 10);
  const swfPath = process.env.LAUNCH_360X_SWF_PATH
    ? path.resolve(projectRoot, process.env.LAUNCH_360X_SWF_PATH)
    : path.join(projectRoot, "modified", "local", "xfbbv451.swf");
  const officialSaveTest = process.env.LAUNCH_360X_OFFICIAL_SAVE_TEST === "1";
  const swfBytes = officialSaveTest ? null : fs.readFileSync(swfPath);
  const targetUrl = process.env.LAUNCH_360X_URL || officialGameUrl;
  const useIsolatedProfile = process.env.LAUNCH_360X_PROFILE === "isolated";
  const running360XPids = useIsolatedProfile ? [] : getRunning360XProcessIds();
  const debugPortAlreadyOpen = await isPortOpen(debugPort);

  if (running360XPids.length > 0 && !debugPortAlreadyOpen) {
    throw new Error(running360XAdvice(running360XPids));
  }

  const args = [
    `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*",
    "--new-window",
    "about:blank",
  ];

  if (useIsolatedProfile) {
    fs.mkdirSync(isolatedUserDataDir, { recursive: true });
    args.unshift(`--user-data-dir=${isolatedUserDataDir}`);
  }

  let browserExit = null;
  const child = spawn(browserPath, args, {
    detached: false,
    stdio: "ignore",
    windowsHide: false,
  });

  child.on("exit", (code, signal) => {
    browserExit = { code, signal };
    console.log(`360X exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
  });

  let target;
  try {
    target = await findPageTarget(debugPort);
  } catch (error) {
    if (browserExit) {
      const freshRunning360XPids = useIsolatedProfile ? [] : getRunning360XProcessIds();
      const advice = freshRunning360XPids.length > 0 && !(await isPortOpen(debugPort))
        ? `\n\n${running360XAdvice(freshRunning360XPids)}`
        : "";
      throw new Error(
        `${error.message}\n` +
        `360X exited before opening the debug port (code=${browserExit.code ?? "null"}). ` +
        "Close all existing 360X windows first, or run with LAUNCH_360X_PROFILE=isolated and log in again." +
        advice
      );
    }
    throw error;
  }
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();

  const saveProtection = officialSaveTest ? null : enableMockSaveProtection(client);

  if (!officialSaveTest) {
    client.on("Fetch.requestPaused", async (params) => {
      const requestUrl = params.request?.url || "";
      if (/\/xfbbv451\.swf(?:[?#]|$)/i.test(requestUrl)) {
        console.log(`SWF replaced: ${requestUrl}`);
        await client.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responsePhrase: "OK",
          responseHeaders: [
            { name: "Content-Type", value: "application/x-shockwave-flash" },
            { name: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
          body: swfBytes.toString("base64"),
        });
        return;
      }

      if (isFlashFallbackUrl(requestUrl)) {
        const replacement = flashFallbackResponseFor(requestUrl);
        console.log(`Flash fallback suppressed: ${requestUrl}`);
        await client.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responsePhrase: "OK",
          responseHeaders: [
            { name: "Content-Type", value: replacement.contentType },
            { name: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
          body: Buffer.from(replacement.body, "utf8").toString("base64"),
        });
        return;
      }

      if (isSaveApiUrl(requestUrl)) {
        await saveProtection.handlePausedRequest(params);
        return;
      }

      await client.send("Fetch.continueRequest", {
        requestId: params.requestId,
      });
    });
  } else {
    enableOfficialSaveLogging(client);
  }

  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable");
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (!officialSaveTest) {
    await client.send("Fetch.enable", {
      patterns: fetchPatternsForMockSession(),
    });
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: buildPanelSource(),
    });
  }
  // The first navigation may have started before instrumentation was enabled.
  // Navigate again so the requested mode is applied from page load.
  await client.send("Page.navigate", { url: targetUrl });

  console.log(`Opened 360X mock session: ${targetUrl}`);
  console.log(`CDP: http://127.0.0.1:${debugPort}/json/list`);
  if (officialSaveTest) {
    console.log("Mode: official save test; SWF replacement and mock panel injection are disabled.");
    console.log("Save API logging: enabled for save.api.4399.com requests.");
  } else {
    console.log(`Local SWF: ${swfPath} (${swfBytes.length} bytes)`);
    if (process.env.LAUNCH_360X_MOCK_SAVE_MODE === "local-session") {
      console.log("Save protection: save requests are stored in a local mock session and are not sent to the official API.");
      console.log(`Local mock save store: ${mockSaveStorePath}`);
    } else {
      console.log("Save protection: official save requests are rewritten with cached original save data before upload.");
      console.log("Set LAUNCH_360X_MOCK_SAVE_MODE=local-session to keep saves fully local for debugging.");
    }
  }
  if (useIsolatedProfile) {
    console.log(`Isolated profile: ${isolatedUserDataDir}`);
  }
  console.log("Keep this terminal open while playing; press Ctrl+C to stop interception.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
