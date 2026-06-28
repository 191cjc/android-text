const http = require("http");

const port = Number.parseInt(process.env.LAUNCH_360X_DEBUG_PORT || process.env.CDP_PORT || "9222", 10);
const targetPattern = process.env.CDP_TARGET || "4399.com/flash/115225_2.htm";
const expression = process.env.CDP_EXPRESSION || `
(() => {
  window.__codexInjected = {
    at: new Date().toISOString(),
    href: location.href,
    title: document.title,
    uid: window.UniLogin && typeof window.UniLogin.getUid === "function"
      ? String(window.UniLogin.getUid())
      : "unavailable"
  };
  console.log("[codex-inject]", window.__codexInjected);
  return window.__codexInjected;
})()
`;

function getJson(pathname) {
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

function websocketKey() {
  return Buffer.from(`${Date.now()}-${Math.random()}`).toString("base64").slice(0, 24);
}

function encodeFrame(payload) {
  const data = Buffer.from(payload);
  const header = [];
  header.push(0x81);

  if (data.length < 126) {
    header.push(0x80 | data.length);
  } else if (data.length < 65536) {
    header.push(0x80 | 126, (data.length >> 8) & 0xff, data.length & 0xff);
  } else {
    throw new Error("Payload too large");
  }

  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    masked[index] = data[index] ^ mask[index % 4];
  }

  return Buffer.concat([Buffer.from(header), mask, masked]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      throw new Error("Large websocket frames are not supported");
    }

    const masked = Boolean(second & 0x80);
    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) {
      break;
    }

    let payload = buffer.subarray(offset + headerLength + maskLength, frameEnd);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]));
    }

    if ((first & 0x0f) === 1) {
      messages.push(payload.toString("utf8"));
    }

    offset = frameEnd;
  }

  return { messages, remaining: buffer.subarray(offset) };
}

function websocketRequest(wsUrl, command) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(wsUrl);
    const key = websocketKey();
    const socket = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });

    let chunks = Buffer.alloc(0);
    socket.on("upgrade", (_res, netSocket) => {
      netSocket.setTimeout(5000);
      netSocket.write(encodeFrame(JSON.stringify(command)));

      netSocket.on("data", (chunk) => {
        chunks = Buffer.concat([chunks, chunk]);
        const decoded = decodeFrames(chunks);
        chunks = decoded.remaining;
        for (const message of decoded.messages) {
          const parsedMessage = JSON.parse(message);
          if (parsedMessage.id === command.id) {
            netSocket.end();
            resolve(parsedMessage);
            return;
          }
        }
      });

      netSocket.on("timeout", () => {
        netSocket.destroy(new Error("Timed out waiting for CDP response"));
      });
      netSocket.on("error", reject);
    });

    socket.on("error", reject);
    socket.end();
  });
}

async function main() {
  const targets = await getJson("/json/list");
  const target = targets.find((item) =>
    item.type === "page" &&
    item.webSocketDebuggerUrl &&
    item.url.includes(targetPattern)
  ) || targets.find((item) =>
    item.type === "page" &&
    item.webSocketDebuggerUrl &&
    /4399\.com/.test(item.url)
  );

  if (!target) {
    throw new Error(`No matching CDP page target found for ${targetPattern}`);
  }

  const response = await websocketRequest(target.webSocketDebuggerUrl, {
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
  });

  console.log(JSON.stringify({
    target: {
      id: target.id,
      title: target.title,
      url: target.url,
    },
    response,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
