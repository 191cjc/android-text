const fs = require("fs");
const path = require("path");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { state, logRequest } = require("./app-state");
const { handleOffline4399Api } = require("./offline-4399-api");
const { createRuffleConfig, getRuffleFontFile } = require("./ruffle-config");

const projectRoot = state.projectRoot;
const originalDir = path.join(projectRoot, "original");
const modifiedDir = path.join(projectRoot, "modified");
const publicDir = path.join(projectRoot, "public");
const ruffleDir = path.join(projectRoot, "node_modules", "@ruffle-rs", "ruffle");

function sanitizeRemotePath(remoteUrl) {
  const url = new URL(remoteUrl);
  return path.join("external", url.hostname, decodeURIComponent(url.pathname));
}

function findExternalPolicy(remoteUrl) {
  const url = remoteUrl instanceof URL ? remoteUrl : new URL(remoteUrl);
  const policy = state.externalProxyPolicies.find((item) => item.host === url.hostname);
  if (!policy) {
    return null;
  }

  if (policy.query) {
    for (const [key, value] of Object.entries(policy.query)) {
      if (url.searchParams.get(key) !== value) {
        return null;
      }
    }
  }

  return policy;
}

function pickStaticFile(relativePath) {
  const clean = relativePath.replace(/^[/\\]+/, "");
  const modPath = path.join(modifiedDir, state.activeMod, clean);
  if (state.activeMod !== "vanilla" && fs.existsSync(modPath)) {
    return { filePath: modPath, source: `mod:${state.activeMod}` };
  }

  const originalPath = path.join(originalDir, clean);
  if (state.activeMod === "vanilla" && fs.existsSync(originalPath)) {
    return { filePath: originalPath, source: "original" };
  }

  const modifiedPath = path.join(modifiedDir, clean);
  if (fs.existsSync(modifiedPath)) {
    return { filePath: modifiedPath, source: "modified" };
  }

  if (fs.existsSync(originalPath)) {
    return { filePath: originalPath, source: "original" };
  }

  return null;
}

function pickExternalOverride(remoteUrl, policy) {
  if (!policy.allowOverride) {
    return null;
  }

  const relativePath = sanitizeRemotePath(remoteUrl);
  const clean = relativePath.replace(/^[/\\]+/, "");
  const modPath = path.join(modifiedDir, state.activeMod, clean);
  if (state.activeMod !== "vanilla" && fs.existsSync(modPath)) {
    return { filePath: modPath, source: `mod:${state.activeMod}` };
  }

  const modifiedPath = path.join(modifiedDir, clean);
  if (fs.existsSync(modifiedPath)) {
    return { filePath: modifiedPath, source: "modified" };
  }

  return null;
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
    // Runtime logging must not break asset serving.
  }
}

async function startLocalServer({ port = 17399 } = {}) {
  const app = express();

  function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }

  function setNoStore(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }

  app.use((req, _res, next) => {
    logRequest({ method: req.method, url: req.originalUrl, kind: "local" });
    next();
  });

  app.use("/ruffle", express.static(ruffleDir, {
    setHeaders(res, filePath) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      setNoStore(res);
      if (filePath.endsWith(".wasm")) {
        res.type("application/wasm");
      }
    },
  }));

  app.get("/ruffle-config.js", (req, res) => {
    setCors(res);
    setNoStore(res);
    const baseUrl = `${req.protocol}://${req.get("host")}/`;
    res
      .type("text/javascript")
      .send(`window.RufflePlayer = window.RufflePlayer || {};
window.RufflePlayer.config = ${JSON.stringify(createRuffleConfig(baseUrl), null, 2)};`);
  });

  app.get("/fonts/:name", (req, res) => {
    setCors(res);
    setNoStore(res);

    const font = getRuffleFontFile(req.params.name);
    if (!font) {
      res.status(404).send("Font not found");
      return;
    }

    res.type(font.type);
    res.sendFile(font.path);
  });

  app.use("/public", express.static(publicDir));

  app.get("/api/state", (_req, res) => {
    res.json({
      activeMod: state.activeMod,
      mode: state.mode,
      remotePageUrl: state.remotePageUrl,
      sourceBaseUrl: state.sourceBaseUrl,
      swfFileName: state.swfFileName,
      externalProxyPolicies: state.externalProxyPolicies,
      requestLog: state.requestLog,
    });
  });

  app.post("/api/mod/:name", express.json(), (req, res) => {
    const name = req.params.name || "vanilla";
    state.activeMod = name;
    logRequest({ method: "POST", url: `/api/mod/${name}`, kind: "state" });
    res.json({ ok: true, activeMod: state.activeMod });
  });

  app.options("/offline-4399", handleOffline4399Api);
  app.all("/offline-4399", express.raw({ type: "*/*", limit: "2mb" }), handleOffline4399Api);

  app.get("/play-local.html", (_req, res) => {
    setCors(res);
    setNoStore(res);
    res.setHeader("Content-Type", "text/html; charset=gb2312");
    const html = fs.readFileSync(path.join(originalDir, "iframe-jjxzfcms.html"));
    const marker = Buffer.from("</body>", "ascii");
    const script = Buffer.from(
      '<script charset="utf-8" src="/public/pet-list.js"></script><script charset="utf-8" src="/public/dark-pet-panel.js"></script>',
      "ascii"
    );
    const markerIndex = html.lastIndexOf(marker);

    if (markerIndex < 0) {
      res.send(Buffer.concat([html, script]));
      return;
    }

    res.send(Buffer.concat([
      html.subarray(0, markerIndex),
      script,
      html.subarray(markerIndex),
    ]));
  });

  app.get("/4399swf/js/chkDomain.js", (_req, res) => {
    setCors(res);
    setNoStore(res);
    res.type("text/javascript").send("");
  });

  app.get(/^\/([^/?]+\.swf)$/, async (req, res, next) => {
    setCors(res);
    setNoStore(res);

    const picked = pickStaticFile(req.params[0]);
    if (picked) {
      logRequest({
        method: req.method,
        url: req.originalUrl,
        kind: "asset",
        source: picked.source,
      });
      writeRuntimeLog("asset", picked.source, req.originalUrl, picked.filePath, fs.statSync(picked.filePath).size);
      res.sendFile(picked.filePath);
      return;
    }

    try {
      const remoteUrl = new URL(req.params[0], state.sourceBaseUrl);
      const response = await fetch(remoteUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: `${state.sourceBaseUrl}jjxzfcms.htm`,
        },
      });

      logRequest({
        method: req.method,
        url: req.originalUrl,
        kind: "remote-fallback",
        target: remoteUrl.toString(),
        status: response.status,
      });

      if (!response.ok) {
        res.status(response.status).send(`Remote asset failed: ${response.status}`);
        return;
      }

      const contentType = response.headers.get("content-type");
      if (contentType) {
        res.type(contentType);
      }

      const body = Buffer.from(await response.arrayBuffer());
      res.send(body);
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/game\/(.+)$/, async (req, res, next) => {
    setCors(res);
    setNoStore(res);

    const relativePath = req.params[0];
    const picked = pickStaticFile(relativePath);
    if (!picked) {
      const remoteUrl = new URL(relativePath, state.sourceBaseUrl);
      try {
        const response = await fetch(remoteUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0",
            Referer: `${state.sourceBaseUrl}jjxzfcms.htm`,
          },
        });

        logRequest({
          method: req.method,
          url: req.originalUrl,
          kind: "remote-fallback",
          target: remoteUrl.toString(),
          status: response.status,
        });

        if (!response.ok) {
          res.status(response.status).send(`Remote asset failed: ${response.status}`);
          return;
        }

        const contentType = response.headers.get("content-type");
        if (contentType) {
          res.type(contentType);
        }

        const body = Buffer.from(await response.arrayBuffer());
        res.send(body);
        return;
      } catch (error) {
        next(error);
        return;
      }
    }

    logRequest({
      method: req.method,
      url: req.originalUrl,
      kind: "asset",
      source: picked.source,
    });
    writeRuntimeLog("asset", picked.source, req.originalUrl, picked.filePath, fs.statSync(picked.filePath).size);
    res.sendFile(picked.filePath);
  });

  app.options("/external", (req, res) => {
    setCors(res);
    res.status(204).end();
  });

  app.all("/external", express.raw({ type: "*/*", limit: "2mb" }), async (req, res, next) => {
    setCors(res);

    const remote = req.query.url;
    if (typeof remote !== "string") {
      res.status(400).send("Missing url");
      return;
    }

    let remoteUrl;
    try {
      remoteUrl = new URL(remote);
    } catch {
      res.status(400).send("Invalid url");
      return;
    }

    if (!["http:", "https:"].includes(remoteUrl.protocol)) {
      res.status(400).send("Unsupported protocol");
      return;
    }

    const policy = findExternalPolicy(remoteUrl);
    if (!policy) {
      res.status(403).send("Host is not allowed");
      return;
    }

    const override = pickExternalOverride(remoteUrl, policy);
    if (override) {
      logRequest({
        method: req.method,
        url: req.originalUrl,
        kind: "external-override",
        source: override.source,
        target: remoteUrl.toString(),
      });
      writeRuntimeLog("external-override", override.source, remoteUrl.toString(), override.filePath);
      res.setHeader("Access-Control-Allow-Origin", "*");
      setNoStore(res);
      res.sendFile(override.filePath);
      return;
    }

    try {
      const headers = {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.4399.com/flash/115225_2.htm",
      };
      if (req.headers["content-type"]) {
        headers["Content-Type"] = req.headers["content-type"];
      }

      const fetchOptions = {
        method: req.method,
        headers: {
          ...headers,
        },
      };

      if (!["GET", "HEAD"].includes(req.method) && req.body?.length) {
        fetchOptions.body = req.body;
      }

      const response = await fetch(remoteUrl, fetchOptions);

      logRequest({
        method: req.method,
        url: req.originalUrl,
        kind: "external-proxy",
        target: remoteUrl.toString(),
        status: response.status,
      });

      const contentType = response.headers.get("content-type");
      if (contentType) {
        res.type(contentType);
      }

      if (!response.ok) {
        res.status(response.status).send(`External asset failed: ${response.status}`);
        return;
      }

      const body = Buffer.from(await response.arrayBuffer());
      res.send(body);
    } catch (error) {
      next(error);
    }
  });

  app.use(
    "/remote",
    createProxyMiddleware({
      target: state.sourceBaseUrl,
      changeOrigin: true,
      pathRewrite: { "^/remote": "" },
      on: {
        proxyReq(proxyReq, req) {
          proxyReq.setHeader("Referer", `${state.sourceBaseUrl}jjxzfcms.htm`);
          logRequest({
            method: req.method,
            url: req.originalUrl,
            kind: "proxy",
            target: `${state.sourceBaseUrl}${req.url.replace(/^\/+/, "")}`,
          });
        },
      },
    })
  );

  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  const listener = await new Promise((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });

  return {
    port,
    listener,
    url: `http://127.0.0.1:${port}/`,
  };
}

module.exports = {
  startLocalServer,
  findExternalPolicy,
};
