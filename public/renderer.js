const statusEl = document.getElementById("status");
const activeModEl = document.getElementById("activeMod");
const swfFileNameEl = document.getElementById("swfFileName");
const requestLogEl = document.getElementById("requestLog");
const playerHost = document.getElementById("player");

let player;
let appState;

function setStatus(message) {
  statusEl.textContent = message;
}

async function fetchState() {
  const response = await fetch("/api/state");
  if (!response.ok) {
    throw new Error(`state ${response.status}`);
  }
  return response.json();
}

async function setMod(name) {
  const response = await fetch(`/api/mod/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`mod ${response.status}`);
  }
  await refreshState();
}

function renderLog(entries) {
  requestLogEl.textContent = "";
  for (const entry of entries.slice(0, 80)) {
    const item = document.createElement("li");
    const kind = document.createElement("b");
    const url = document.createElement("span");
    kind.textContent = entry.kind || "local";
    url.textContent = entry.url;
    item.append(kind, url);
    requestLogEl.append(item);
  }
}

async function refreshState() {
  const state = await fetchState();
  appState = state;
  activeModEl.textContent = state.activeMod;
  swfFileNameEl.textContent = state.swfFileName;
  renderLog(state.requestLog || []);
  return state;
}

async function loadGame() {
  setStatus("加载中");
  const state = appState || (await refreshState());
  playerHost.textContent = "";

  const ruffle = window.RufflePlayer.newest();
  player = ruffle.createPlayer();
  player.id = "rufflePlayer";
  player.style.width = "960px";
  player.style.height = "600px";
  playerHost.append(player);

  await player.ruffle().load({
    url: `/game/${encodeURIComponent(state.swfFileName)}?ts=${Date.now()}`,
    allowScriptAccess: true,
  });
  setStatus("运行中");
  await refreshState();
}

document.getElementById("reloadGame").addEventListener("click", () => {
  loadGame().catch((error) => {
    console.error(error);
    setStatus("加载失败");
  });
});

document.getElementById("useVanilla").addEventListener("click", async () => {
  await setMod("vanilla");
  await loadGame();
});

document.getElementById("useLocalMod").addEventListener("click", async () => {
  await setMod("local");
  await loadGame();
});

document.getElementById("refreshLog").addEventListener("click", () => {
  refreshState().catch(console.error);
});

window.addEventListener("DOMContentLoaded", () => {
  refreshState()
    .then(() => loadGame())
    .catch((error) => {
      console.error(error);
      setStatus("加载失败");
    });
  setInterval(() => refreshState().catch(console.error), 3000);
});
