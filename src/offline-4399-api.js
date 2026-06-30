const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const CryptoJS = require("crypto-js");
const { state, logRequest } = require("./app-state");
const { sanitizeSaveData } = require("./cheat-check-mock");

const PAYMENT_QUERY_PATHS = new Set([
  "/exchange/v2/flash/GetMoney",
  "/exchange/v2/flash/GetTotalPay",
  "/exchange/v2/flash/GetTotalRecharge",
]);

const PAYMENT_DISABLED_PATHS = new Set([
  "/exchange/v2/flash/Dec",
  "/exchange/v2/flash/Pay",
]);

function classifyOffline4399Api(remoteUrl) {
  let parsed;
  try {
    parsed = remoteUrl instanceof URL ? remoteUrl : new URL(remoteUrl);
  } catch {
    return null;
  }

  if (parsed.hostname === "my.4399.com" && parsed.pathname === "/services/game-play") {
    return { kind: "offline-platform-game-play" };
  }

  if (parsed.hostname !== "save.api.4399.com") {
    return null;
  }

  const ac = parsed.searchParams.get("ac");
  const method = parsed.searchParams.get("method");

  if (parsed.pathname === "/auth/openapi.php" && method === "User.Authenticate") {
    return { kind: "offline-authenticate" };
  }

  if (parsed.pathname === "/" && ac === "get_time") {
    return { kind: "offline-get-time" };
  }

  if (parsed.pathname === "/" && ac === "get_session") {
    return { kind: "offline-save-session" };
  }

  if (parsed.pathname === "/" && ac === "check_session") {
    return { kind: "offline-save-check-session" };
  }

  if (parsed.pathname === "/index.php" && ac === "get_token") {
    return { kind: "offline-save-token" };
  }

  if (parsed.pathname === "/" && ac === "get_list") {
    return { kind: "offline-save-list" };
  }

  if (parsed.pathname === "/" && ac === "get") {
    return { kind: "offline-save-get" };
  }

  if (parsed.pathname === "/" && ac === "save") {
    return { kind: "offline-save-set" };
  }

  if (PAYMENT_QUERY_PATHS.has(parsed.pathname)) {
    return { kind: "offline-payment-query-zero" };
  }

  if (parsed.pathname === "/exchange/v2/flash/GetToken") {
    return { kind: "offline-payment-token" };
  }

  if (PAYMENT_DISABLED_PATHS.has(parsed.pathname)) {
    return { kind: "offline-payment-disabled" };
  }

  return null;
}

function setOfflineCors(req, res) {
  const origin = req.headers.origin || "https://sbai.4399.com";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With, Origin, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Content-Length, Date");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function parseRequestParams(remoteUrl, body) {
  const parsed = new URL(remoteUrl);
  const params = new URLSearchParams(parsed.search);
  const bodyText = Buffer.isBuffer(body) ? body.toString("utf8") : "";

  if (bodyText) {
    const bodyParams = new URLSearchParams(bodyText);
    for (const [key, value] of bodyParams.entries()) {
      params.append(key, value);
    }
  }

  return { params, bodyText };
}

function nowText(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

function readBodyParam(params, names, fallback = "") {
  for (const name of names) {
    const value = params.get(name);
    if (value != null && value !== "") {
      return value;
    }
  }
  return fallback;
}

function pickSaveIndex(params) {
  const raw = readBodyParam(params, ["index", "idx", "i"], "0");
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(value, 7);
}

function saveStorePath() {
  return path.join(state.projectRoot, "data", "offline-saves.json");
}

function readSaveStore() {
  try {
    return JSON.parse(fs.readFileSync(saveStorePath(), "utf8"));
  } catch {
    return { slots: {} };
  }
}

function writeSaveStore(store) {
  const filePath = saveStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
}

function emptySaveSlot(index) {
  return {
    index,
    title: "\u65e0\u5b58\u6863\u8bb0\u5f55",
    datetime: "2000-01-01",
    data: "",
    status: "0",
  };
}

function localSaveTitle(index) {
  return `\u672c\u5730\u5b58\u6863 ${index + 1}`;
}

function normalizeSaveSlot(index, value, { includeEmpty = false } = {}) {
  if (!value) {
    return includeEmpty ? emptySaveSlot(index) : null;
  }
  const data = value.data == null ? "" : String(value.data);
  const sanitized = process.env.OFFLINE_4399_CHEAT_CHECK_MOCK === "1"
    ? sanitizeSaveData(data)
    : { data };

  return {
    index,
    title: String(value.title || localSaveTitle(index)),
    datetime: String(value.datetime || nowText()),
    data: sanitized.data,
    status: String(value.status || "0"),
  };
}

function readSaveSlot(index) {
  const store = readSaveStore();
  return normalizeSaveSlot(index, store.slots?.[String(index)]);
}

function saveSlotsArray() {
  const store = readSaveStore();
  const slots = [];
  for (let index = 0; index < 8; index += 1) {
    slots[index] = normalizeSaveSlot(index, store.slots?.[String(index)], { includeEmpty: true });
  }
  return slots;
}

function writeSaveSlot(index, params) {
  const store = readSaveStore();
  const current = normalizeSaveSlot(index, store.slots?.[String(index)]);
  const rawData = readBodyParam(params, ["data", "content", "value"], current?.data || "");
  const sanitized = process.env.OFFLINE_4399_CHEAT_CHECK_MOCK === "1"
    ? sanitizeSaveData(rawData)
    : { data: rawData };
  store.slots = store.slots || {};
  store.slots[String(index)] = {
    index,
    title: readBodyParam(params, ["title", "name"], current?.title || localSaveTitle(index)),
    datetime: nowText(),
    data: sanitized.data,
    status: "0",
  };
  writeSaveStore(store);
}

function pickPaymentTime(params) {
  const preferredKeys = ["time", "Time", "timestamp", "Timestamp", "ts", "t"];
  for (const key of preferredKeys) {
    const value = params.get(key);
    if (value) {
      return value;
    }
  }

  for (const [key, value] of params.entries()) {
    if (/time/i.test(key) && value) {
      return value;
    }
  }

  for (const [, value] of params.entries()) {
    if (/^\d{10,13}$/.test(value)) {
      return value;
    }
  }

  return String(Math.floor(Date.now() / 1000));
}

function encryptPaymentPayload(text) {
  const key = CryptoJS.enc.Utf8.parse("4399api_");
  const encrypted = CryptoJS.DES.encrypt(text, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  return encrypted.ciphertext.toString(CryptoJS.enc.Base64);
}

function offlineToken() {
  return crypto
    .createHash("md5")
    .update(`offline-4399:${Date.now()}:${Math.random()}`)
    .digest("hex");
}

function offlineUser(params) {
  const uid = readBodyParam(params, ["uid", "userId", "userid"], "1324339755");
  const name = readBodyParam(params, ["name", "username", "userName"], "offline_user");
  const nickName = readBodyParam(params, ["nickName", "nickname", "nick"], name);
  return { uid, name, nickName };
}

function authField(value, fallback) {
  const text = String(value || fallback || "");
  return text.replace(/\|/g, "").trim() || fallback;
}

function authenticatePayload(params) {
  const user = offlineUser(params);
  const uid = authField(user.uid, "1324339755");
  const name = authField(user.name, "offline_user");
  const nickName = authField(user.nickName, name);
  return `offline|1000|${uid}|${name}|${nickName}|`;
}

function writeRuntimeLog(...parts) {
  try {
    const logDir = path.join(state.projectRoot, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "runtime.log"),
      `${new Date().toISOString()} ${parts.map(String).join(" ")}\n`
    );
  } catch {
    // Runtime logging must not break offline compatibility responses.
  }
}

function sendText(res, body, status = 200) {
  res.status(status);
  res.type("text/html; charset=utf-8");
  writeRuntimeLog("offline-response", status, String(body).slice(0, 120));
  res.send(body);
}

function handleOffline4399Api(req, res) {
  setOfflineCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const remote = req.query.url;
  if (typeof remote !== "string") {
    sendText(res, "Missing url", 400);
    return;
  }

  let remoteUrl;
  try {
    remoteUrl = new URL(remote);
  } catch {
    sendText(res, "Invalid url", 400);
    return;
  }

  const target = classifyOffline4399Api(remoteUrl);
  if (!target) {
    sendText(res, "Unsupported offline API", 404);
    return;
  }

  const { params, bodyText } = parseRequestParams(remoteUrl, req.body);
  logRequest({
    method: req.method,
    url: req.originalUrl,
    kind: target.kind,
    target: remoteUrl.toString(),
    bodyPreview: bodyText.slice(0, 300),
  });

  if (target.kind === "offline-authenticate") {
    sendText(res, authenticatePayload(params));
    return;
  }

  if (target.kind === "offline-platform-game-play") {
    sendText(res, JSON.stringify({ code: 0, message: "offline-ok" }));
    return;
  }

  if (target.kind === "offline-get-time") {
    sendText(res, JSON.stringify({ time: nowText() }));
    return;
  }

  if (target.kind === "offline-save-session") {
    sendText(res, offlineToken());
    return;
  }

  if (target.kind === "offline-save-check-session") {
    sendText(res, "1");
    return;
  }

  if (target.kind === "offline-save-token") {
    sendText(res, offlineToken());
    return;
  }

  if (target.kind === "offline-save-list") {
    sendText(res, JSON.stringify(saveSlotsArray()));
    return;
  }

  if (target.kind === "offline-save-get") {
    const slot = readSaveSlot(pickSaveIndex(params));
    sendText(res, slot ? JSON.stringify(slot) : "0");
    return;
  }

  if (target.kind === "offline-save-set") {
    // if (req.query.noWrite === "1") {
    //   sendText(res, "1");
    //   return;
    // }
    writeSaveSlot(pickSaveIndex(params), params);
    sendText(res, "1");
    return;
  }

  if (target.kind === "offline-payment-query-zero") {
    const time = pickPaymentTime(params);
    const payload = `${time}####0`;
    sendText(res, encryptPaymentPayload(payload));
    return;
  }

  if (target.kind === "offline-payment-token") {
    sendText(res, offlineToken());
    return;
  }

  if (target.kind === "offline-payment-disabled") {
    sendText(res, "offline_payment_unavailable");
    return;
  }

  sendText(res, "Unsupported offline API", 404);
}

module.exports = {
  classifyOffline4399Api,
  handleOffline4399Api,
};
