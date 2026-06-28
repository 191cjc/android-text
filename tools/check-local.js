const { startLocalServer } = require("../src/local-server");
const CryptoJS = require("crypto-js");
const fs = require("fs");
const path = require("path");

const saveStorePath = path.resolve(__dirname, "..", "data", "offline-saves.json");

async function read(url) {
  const response = await fetch(url);
  const size = Buffer.from(await response.arrayBuffer()).length;
  return {
    url,
    status: response.status,
    contentType: response.headers.get("content-type"),
    size,
  };
}

async function post(url) {
  const response = await fetch(url, { method: "POST" });
  const body = await response.text();
  return {
    url,
    status: response.status,
    contentType: response.headers.get("content-type"),
    size: Buffer.byteLength(body),
    preview: body.slice(0, 80),
  };
}

async function postForm(url, data) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(data).toString(),
  });
  const body = await response.text();
  return {
    url,
    status: response.status,
    contentType: response.headers.get("content-type"),
    size: Buffer.byteLength(body),
    preview: body.slice(0, 160),
    body,
  };
}

function decryptPaymentPayload(body) {
  const key = CryptoJS.enc.Utf8.parse("4399api_");
  return CryptoJS.DES.decrypt(
    { ciphertext: CryptoJS.enc.Base64.parse(body) },
    key,
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
  ).toString(CryptoJS.enc.Utf8);
}

async function main() {
  const originalSaveStore = fs.existsSync(saveStorePath)
    ? fs.readFileSync(saveStorePath)
    : null;
  const server = await startLocalServer({ port: 17400 });
  try {
    const checks = await Promise.all([
      read(server.url),
      read(`${server.url}play-local.html`),
      read(`${server.url}api/state`),
      read(`${server.url}game/L4399Main_gamefile.swf`),
      read(`${server.url}game/xfbbv451.swf`),
      read(`${server.url}ruffle/ruffle.js`),
      post(`${server.url}offline-4399?url=${encodeURIComponent("https://save.api.4399.com/auth/openapi.php?method=User.Authenticate")}`),
      post(`${server.url}external?url=${encodeURIComponent("https://save.api.4399.com/?ac=get_time&ran=1")}`),
      post(`${server.url}offline-4399?url=${encodeURIComponent("https://save.api.4399.com/exchange/v2/flash/GetTotalRecharge?time=123")}`),
      post(`${server.url}offline-4399?url=${encodeURIComponent("https://save.api.4399.com/?ac=get_session&ran=1")}`),
      post(`${server.url}offline-4399?url=${encodeURIComponent("https://save.api.4399.com/?ac=check_session")}`),
      post(`${server.url}offline-4399?url=${encodeURIComponent("https://save.api.4399.com/index.php?ac=get_token&ran=1")}`),
      post(`${server.url}offline-4399?url=${encodeURIComponent("https://save.api.4399.com/?ac=get_list")}`),
      postForm(`${server.url}offline-4399?url=${encodeURIComponent("https://save.api.4399.com/?ac=save")}`, {
        index: "0",
        title: "check-local",
        data: "hello",
      }),
      postForm(`${server.url}offline-4399?url=${encodeURIComponent("https://save.api.4399.com/?ac=get")}`, {
        index: "0",
      }),
    ]);

    for (const check of checks) {
      if (check.url.includes("GetTotalRecharge")) {
        check.decrypted = decryptPaymentPayload(check.preview);
      }
      if (check.url.includes("ac=get_list") || check.url.includes("ac=get")) {
        try {
          check.parsed = JSON.parse(check.body || check.preview);
        } catch {
          // Some legacy endpoints intentionally return plain text.
        }
      }
      console.log(check);
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.listener.close((error) => (error ? reject(error) : resolve()));
    });
    if (originalSaveStore) {
      fs.mkdirSync(path.dirname(saveStorePath), { recursive: true });
      fs.writeFileSync(saveStorePath, originalSaveStore);
    } else {
      fs.rmSync(saveStorePath, { force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
