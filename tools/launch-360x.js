const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { startLocalServer } = require("../src/local-server");
const { state } = require("../src/app-state");

const projectRoot = path.resolve(__dirname, "..");
const userDataDir = path.join(projectRoot, ".browser-data", "360x");
const officialGameUrl = "https://www.4399.com/flash/115225_2.htm";

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

async function main() {
  const browserPath = findBrowser();
  const mode = process.env.LAUNCH_360X_MODE || "official";
  const useIsolatedProfile = process.env.LAUNCH_360X_PROFILE === "isolated";
  const debugPort = process.env.LAUNCH_360X_DEBUG_PORT;

  if (mode === "local") {
    state.activeMod = process.env.LAUNCH_360X_MOD || "local";
  }

  const server = mode === "local" ? await startLocalServer() : null;
  const targetUrl = mode === "local"
    ? `${server.url}play-local.html`
    : (process.env.LAUNCH_360X_URL || officialGameUrl);

  const args = ["--new-window", targetUrl];
  if (debugPort) {
    args.unshift(`--remote-debugging-port=${debugPort}`);
    args.unshift("--remote-allow-origins=*");
  }
  if (useIsolatedProfile) {
    fs.mkdirSync(userDataDir, { recursive: true });
    args.unshift(`--user-data-dir=${userDataDir}`);
  }

  const child = spawn(browserPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });

  child.unref();

  if (server) {
    console.log(`Local server running at ${server.url}`);
  }
  console.log(`Opened 360 Extreme Browser X: ${targetUrl}`);
  if (debugPort) {
    console.log(`Remote debugging: http://127.0.0.1:${debugPort}/json/version`);
  }
  if (server) {
    console.log("Press Ctrl+C in this terminal to stop the local server.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
