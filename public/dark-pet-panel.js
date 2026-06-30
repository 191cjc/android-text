(function () {
  if (window.__codexMockPanelLoaded) {
    return;
  }
  window.__codexMockPanelLoaded = true;

  const STORAGE_KEY = "__codexRuntimeMockPanel";
  const PANEL_KEY = `${STORAGE_KEY}:panel`;
  const ENCODE_FACTOR = 11000;
  const FIXED_PET_SLOT = 1;
  const MAX_BAG_ITEMS = 12;
  const BAG_SNAPSHOT_BASE = 100000;
  const BAG_SNAPSHOT_STRIDE = 1000;
  const MAX_LOGS = 120;
  const BAG_UI_ENABLED = Boolean(window.__codexBagMockUiEnabled);
  const SKILL_CODES = {
    lw1: 10,
    use1: 20,
    use2: 21,
    use3: 22,
    use4: 23,
  };

  const petList = Array.isArray(window.__codexPetList) ? window.__codexPetList : [];
  const darkPet = petList.find((item) => item.id === 19) || { id: 19, name: "暗黑之子" };

  const itemList = Array.isArray(window.__codexItemList)
    ? window.__codexItemList
    : Array.isArray(window.__codexFashionItemList)
      ? window.__codexFashionItemList
      : [];
  const defaultBagItem = itemList.find((item) => item.bag === 3) || itemList[0] || { id: 411001, name: "暗黑之鹰(衣)", bag: 3 };

  const DEFAULT_STATE = {
    activeTab: "pet",
    petEnabled: false,
    petConsumeOnUse: false,
    petId: darkPet.id,
    petLevel: 1,
    petFusionLevel: 1,
    petSlotMode: "append",
    petSlot: FIXED_PET_SLOT,
    petStage: 0,
    lwSkill1Enabled: false,
    lwSkill1Id: 0,
    lwSkill1Level: 1,
    lwSkill1Exp: 0,
    useSkill1Enabled: false,
    useSkill1Id: 0,
    useSkill1Level: 1,
    useSkill1Exp: 0,
    useSkill2Enabled: false,
    useSkill2Id: 0,
    useSkill2Level: 1,
    useSkill2Exp: 0,
    useSkill3Enabled: false,
    useSkill3Id: 0,
    useSkill3Level: 1,
    useSkill3Exp: 0,
    useSkill4Enabled: false,
    useSkill4Id: 0,
    useSkill4Level: 1,
    useSkill4Exp: 0,
    petLastReadAt: 0,
    bagItemId: defaultBagItem.id,
    bagItemCount: 1,
    bagItems: [],
    bagFilterBag: -1,
    bagFilterType: -1,
    bagLastReadAt: 0,
    bagSnapshot: null,
    currencyEnabled: false,
    currencyValue: 0,
    currencyLastReadAt: 0,
    shopBuyEnabled: false,
    shopBuyLastReadAt: 0,
    logs: [],
  };

  const DEFAULT_PANEL_STATE = {
    x: null,
    y: null,
    minimized: false,
  };

  let state = loadState();
  let panelState = loadPanelState();

  function clampNumber(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  function normalizeBagSnapshot(value) {
    const source = value && typeof value === "object" ? value : {};
    const snapshot = {};
    for (const key of ["0", "1", "2", "3"]) {
      const parsed = Number.parseInt(String(source[key]), 10);
      snapshot[key] = Number.isFinite(parsed) ? Math.max(0, parsed) : null;
    }
    return snapshot;
  }

  function normalizeState(value) {
    const source = value && typeof value === "object" ? value : {};
    const allowedTabs = BAG_UI_ENABLED ? ["pet", "bag", "currency", "shop", "params", "logs"] : ["pet", "currency", "shop", "params", "logs"];
    const activeTab = allowedTabs.includes(source.activeTab)
      ? source.activeTab
      : source.activeTab === "monitor"
        ? "params"
      : DEFAULT_STATE.activeTab;

    const sourceBagItems = Array.isArray(source.bagItems) ? source.bagItems : [];
    const normalizedBagItems = sourceBagItems
      .map((item) => ({
        id: clampNumber(item?.id, 0, 0, 999999),
        count: clampNumber(item?.count, 1, 1, 999),
      }))
      .filter((item) => item.id > 0)
      .slice(0, MAX_BAG_ITEMS);

    const normalized = {
      activeTab,
      petEnabled: Boolean(source.petEnabled),
      petConsumeOnUse: Boolean(source.petConsumeOnUse),
      petId: clampNumber(source.petId, DEFAULT_STATE.petId, 1, 999999),
      petLevel: clampNumber(source.petLevel, DEFAULT_STATE.petLevel, 1, 100),
      petFusionLevel: clampNumber(source.petFusionLevel, DEFAULT_STATE.petFusionLevel, 0, 99),
      petSlotMode: source.petSlotMode === "replace" ? "replace" : "append",
      petSlot: clampNumber(source.petSlot, DEFAULT_STATE.petSlot, 1, 99),
      petStage: clampNumber(source.petStage, DEFAULT_STATE.petStage, 0, 4),
      petLastReadAt: clampNumber(source.petLastReadAt, DEFAULT_STATE.petLastReadAt, 0, 9999999999999),
      bagItemId: clampNumber(source.bagItemId, DEFAULT_STATE.bagItemId, 1, 999999),
      bagItemCount: clampNumber(source.bagItemCount, DEFAULT_STATE.bagItemCount, 1, 999),
      bagItems: normalizedBagItems,
      bagFilterBag: clampNumber(source.bagFilterBag, DEFAULT_STATE.bagFilterBag, -1, 99),
      bagFilterType: clampNumber(source.bagFilterType, DEFAULT_STATE.bagFilterType, -1, 99),
      bagLastReadAt: clampNumber(source.bagLastReadAt, DEFAULT_STATE.bagLastReadAt, 0, 9999999999999),
      bagSnapshot: normalizeBagSnapshot(source.bagSnapshot),
      currencyEnabled: Boolean(source.currencyEnabled),
      currencyValue: clampNumber(source.currencyValue, DEFAULT_STATE.currencyValue, 0, 999999999),
      currencyLastReadAt: clampNumber(source.currencyLastReadAt, DEFAULT_STATE.currencyLastReadAt, 0, 9999999999999),
      shopBuyEnabled: Boolean(source.shopBuyEnabled),
      shopBuyLastReadAt: clampNumber(source.shopBuyLastReadAt, DEFAULT_STATE.shopBuyLastReadAt, 0, 9999999999999),
      logs: Array.isArray(source.logs) ? source.logs.slice(-MAX_LOGS) : [],
    };

    if (!BAG_UI_ENABLED) {
      normalized.bagItems = [];
      normalized.bagLastReadAt = 0;
    }

    for (const prefix of ["lwSkill1", "useSkill1", "useSkill2", "useSkill3", "useSkill4"]) {
      normalized[`${prefix}Enabled`] = Boolean(source[`${prefix}Enabled`]);
      normalized[`${prefix}Id`] = clampNumber(source[`${prefix}Id`], DEFAULT_STATE[`${prefix}Id`], 0, 999999);
      normalized[`${prefix}Level`] = clampNumber(source[`${prefix}Level`], DEFAULT_STATE[`${prefix}Level`], 1, 100);
      normalized[`${prefix}Exp`] = clampNumber(source[`${prefix}Exp`], DEFAULT_STATE[`${prefix}Exp`], 0, 999999999);
    }

    return normalized;
  }

  function loadState() {
    try {
      return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  function saveState(nextState, options) {
    state = normalizeState({ ...state, ...nextState });
    window.__codexRuntimeMock = state;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Live state remains usable even if storage is blocked.
    }
    if (!options || options.render !== false) {
      renderPanel();
    }
    return state;
  }

  function saveStateQuiet(nextState) {
    return saveState(nextState, { render: false });
  }

  function normalizePanelState(value) {
    const source = value && typeof value === "object" ? value : {};
    const x = Number.parseInt(String(source.x), 10);
    const y = Number.parseInt(String(source.y), 10);
    return {
      x: Number.isFinite(x) ? x : DEFAULT_PANEL_STATE.x,
      y: Number.isFinite(y) ? y : DEFAULT_PANEL_STATE.y,
      minimized: Boolean(source.minimized),
    };
  }

  function loadPanelState() {
    try {
      return normalizePanelState(JSON.parse(localStorage.getItem(PANEL_KEY)));
    } catch {
      return { ...DEFAULT_PANEL_STATE };
    }
  }

  function savePanelState(nextState) {
    panelState = normalizePanelState({ ...panelState, ...nextState });
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify(panelState));
    } catch {
      // Ignore storage failures.
    }
    return panelState;
  }

  function nowText() {
    const date = new Date();
    return date.toLocaleTimeString("zh-CN", { hour12: false });
  }

  function petById(id) {
    return petList.find((item) => item.id === Number(id)) || null;
  }

  function selectedPetLabel() {
    const pet = petById(state.petId);
    return pet ? `${pet.name} / ID ${pet.id}` : `ID ${state.petId}`;
  }

  function itemById(id) {
    return itemList.find((item) => item.id === Number(id)) || null;
  }

  function selectedBagItemLabel() {
    const item = itemById(state.bagItemId);
    return item ? `${item.name} / ID ${item.id}` : `ID ${state.bagItemId}`;
  }

  function bagItemLabel(entry) {
    const item = itemById(entry?.id);
    const name = item ? item.name : `ID ${entry?.id || 0}`;
    return `${name} / ID ${entry?.id || 0} x${entry?.count || 1}`;
  }

  function selectedBagItemsLabel() {
    const items = normalizeState(state).bagItems;
    if (items.length === 0) {
      return "未添加道具";
    }
    if (items.length === 1) {
      return bagItemLabel(items[0]);
    }
    return `${items.length} 种道具`;
  }

  function bagLabel(value) {
    const labels = {
      0: "装备",
      1: "宝石",
      2: "其他",
      3: "时装",
      4: "装备槽",
      5: "强化",
      6: "镶嵌",
      7: "合成",
      8: "仓库",
      11: "武魂",
    };
    return labels[value] || `背包 ${value}`;
  }

  function bagSnapshotText() {
    const snapshot = normalizeBagSnapshot(state.bagSnapshot);
    return [0, 1, 2, 3]
      .map((bag) => {
        const value = snapshot[String(bag)];
        return `${bagLabel(bag)}:${value == null ? "?" : value}`;
      })
      .join(" / ");
  }

  function lastReadText(value) {
    if (!value) {
      return "尚未读取";
    }
    const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
    if (seconds < 3) {
      return "刚刚读取";
    }
    if (seconds < 60) {
      return `${seconds} 秒前`;
    }
    return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
  }

  function log(message, detail) {
    const item = {
      at: new Date().toISOString(),
      text: String(message),
      detail: detail == null ? "" : String(detail),
    };
    state.logs = [...state.logs, item].slice(-MAX_LOGS);
    saveState({ logs: state.logs }, { render: false });
    renderLogs();
  }

  function encodePetValue(current) {
    return (current.petId * ENCODE_FACTOR) + (current.petLevel * 100) + current.petFusionLevel;
  }

  function enabledSkillCount() {
    return ["lwSkill1", "useSkill1", "useSkill2", "useSkill3", "useSkill4"]
      .filter((prefix) => state[`${prefix}Enabled`] && state[`${prefix}Id`] > 0)
      .length;
  }

  function skillConfigForCode(code) {
    const numericCode = Number(code);
    const prefix = numericCode === SKILL_CODES.lw1
      ? "lwSkill1"
      : numericCode === SKILL_CODES.use1
        ? "useSkill1"
        : numericCode === SKILL_CODES.use2
          ? "useSkill2"
          : numericCode === SKILL_CODES.use3
            ? "useSkill3"
            : numericCode === SKILL_CODES.use4
              ? "useSkill4"
              : "";
    if (!prefix || !state[`${prefix}Enabled`] || !state[`${prefix}Id`]) {
      return null;
    }
    return {
      id: state[`${prefix}Id`],
      level: state[`${prefix}Level`],
      exp: state[`${prefix}Exp`],
    };
  }

  function skillValue(kind, code) {
    const skill = skillConfigForCode(code);
    if (!skill) {
      return "0";
    }
    if (kind === "bid") return String(skill.id);
    if (kind === "clv") return String(skill.level);
    if (kind === "cexp") return String(skill.exp);
    return "0";
  }

  function markPetTouched(value) {
    const current = state;
    log("Flash 读取宠物 mock", `${selectedPetLabel()} 编码 ${value}`);
    if (current.petConsumeOnUse) {
      saveState({ petEnabled: false, petLastReadAt: Date.now() });
    } else {
      saveState({ petLastReadAt: Date.now() });
    }
  }

  function markBagTouched() {
    log("Flash 读取背包 mock", selectedBagItemsLabel());
    saveState({ bagLastReadAt: Date.now() });
  }

  function findFlashCallback(callbackName) {
    const candidates = [];
    if (window[callbackName] && typeof window[callbackName] === "function") {
      candidates.push(window);
    }
    for (const item of document.querySelectorAll("object, embed")) {
      candidates.push(item);
    }
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentWindow) {
          candidates.push(frame.contentWindow);
        }
        if (frame.contentDocument) {
          candidates.push(...frame.contentDocument.querySelectorAll("object, embed"));
        }
      } catch {
        // Cross-origin frames are not callable from the panel.
      }
    }
    return candidates.find((item) => item && typeof item[callbackName] === "function") || null;
  }

  function sendBagItemsNow() {
    const current = normalizeState(state);
    if (current.bagItems.length === 0) {
      log("发送道具失败", "队列为空");
      return;
    }

    const callbackName = "codexSendBagItems";
    const target = findFlashCallback(callbackName);
    if (!target) {
      log("发送道具失败", `未找到 Flash 回调 ${callbackName}`);
      renderStatus();
      return;
    }

    try {
      target[callbackName]();
      log("发送道具已触发", selectedBagItemsLabel());
    } catch (error) {
      log("发送道具异常", error && error.message ? error.message : String(error));
      renderStatus();
    }
  }

  function markCurrencyTouched(value) {
    log("Flash currency mock read", `goldCurr=${value}`);
    saveState({ currencyLastReadAt: Date.now() });
  }

  function markShopBuyTouched() {
    log("Flash shop buy mock read", "buyShopProp local success");
    saveState({ shopBuyLastReadAt: Date.now() });
  }

  function recordBagSnapshot(payload) {
    const encoded = clampNumber(payload, -1, -1, 999999999);
    if (encoded < BAG_SNAPSHOT_BASE) {
      return false;
    }

    const relative = encoded - BAG_SNAPSHOT_BASE;
    const bag = Math.floor(relative / BAG_SNAPSHOT_STRIDE);
    if (bag < 0 || bag > 3) {
      return false;
    }

    const air = relative % BAG_SNAPSHOT_STRIDE;
    const snapshot = normalizeBagSnapshot(state.bagSnapshot);
    snapshot[String(bag)] = air;
    saveStateQuiet({ bagSnapshot: snapshot, bagLastReadAt: Date.now() });
    if (bag === 3) {
      log("Flash bag snapshot", bagSnapshotText());
    }
    return true;
  }

  window.codexPetMockValue = function () {
    const current = normalizeState(state);
    if (!current.petEnabled) {
      log("Flash 查询宠物 mock", "关闭，返回 0");
      return "0";
    }

    const value = encodePetValue(current);
    markPetTouched(value);
    return String(value);
  };

  window.codexDarkPetValue = window.codexPetMockValue;

  window.codexDarkPetConfig = function () {
    return JSON.stringify(normalizeState(state));
  };

  window.codexDarkPetEnabled = function () {
    return state.petEnabled ? "1" : "0";
  };

  window.dataIndexYouData = function (kind, payload) {
    if (arguments.length === 0) {
      return window.codexPetMockValue();
    }

    if (kind === "goodsId" || kind === "goodsNum") {
      if (kind === "goodsNum" && recordBagSnapshot(payload)) {
        return "0";
      }
      const index = clampNumber(payload, 0, 0, MAX_BAG_ITEMS);
      if (kind === "goodsId" && index >= MAX_BAG_ITEMS) {
        return window.codexBagMockDone();
      }
      return window.codexBagMockValue(kind, index);
    }

    if (kind === "goldCurr" || kind === "currency") {
      return window.codexCurrencyMockValue();
    }

    if (kind === "buyShopProp" || kind === "shopBuy") {
      return window.codexShopBuyMockEnabled();
    }

    if (kind === "curLWJieDuan" || kind === "petStage") {
      return String(normalizeState(state).petStage);
    }

    if (kind === "slot" || kind === "petSlot") {
      const current = normalizeState(state);
      return current.petSlotMode === "replace" ? String(current.petSlot) : "0";
    }

    if (kind === "bid" || kind === "clv" || kind === "cexp") {
      return skillValue(kind, payload);
    }

    if (kind === "petSkillBid" || kind === "petSkillClv" || kind === "petSkillCexp") {
      return skillValue(kind.slice("petSkill".length).toLowerCase(), payload);
    }

    if (kind && typeof kind === "object") {
      return "0";
    }

    return window.codexPetMockValue();
  };

  window.codexBagMockValue = function (kind) {
    if (!BAG_UI_ENABLED) {
      return "0";
    }
    const current = normalizeState(state);
    const index = clampNumber(arguments.length > 1 ? arguments[1] : 0, 0, 0, MAX_BAG_ITEMS - 1);
    const item = current.bagItems[index];
    if (!item) {
      return "0";
    }
    if (kind === "goodsNum") {
      return String(item.count);
    }
    return String(item.id);
  };

  window.codexBagMockDone = function () {
    if (!BAG_UI_ENABLED) {
      return "0";
    }
    const current = normalizeState(state);
    if (current.bagItems.length === 0) {
      return "0";
    }
    markBagTouched();
    return "1";
  };

  window.codexCurrencyMockValue = function () {
    const current = normalizeState(state);
    if (!current.currencyEnabled) {
      return "-1";
    }
    markCurrencyTouched(current.currencyValue);
    return String(current.currencyValue);
  };

  window.codexShopBuyMockEnabled = function () {
    const current = normalizeState(state);
    if (!current.shopBuyEnabled) {
      return "0";
    }
    markShopBuyTouched();
    return "1";
  };

  window.codexPetSnapshot = function () {
    return "0";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function createPanel() {
    if (document.getElementById("codex-runtime-mock-panel")) {
      renderPanel();
      return;
    }

    const style = document.createElement("style");
    style.textContent = `
      #codex-runtime-mock-panel {
        position: fixed;
        z-index: 2147483647;
        right: 18px;
        top: 82px;
        width: 760px;
        max-width: calc(100vw - 20px);
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 8px;
        background: rgba(18, 20, 23, .96);
        color: #f3f6f9;
        box-shadow: 0 18px 42px rgba(0,0,0,.42);
        font: 13px/1.42 "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
        user-select: none;
      }
      #codex-runtime-mock-panel * { box-sizing: border-box; }
      #codex-runtime-mock-panel header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-height: 42px;
        padding: 9px 10px 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,.08);
        cursor: move;
      }
      #codex-runtime-mock-panel .title {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 700;
      }
      #codex-runtime-mock-panel .status {
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 2px 7px;
        border-radius: 999px;
        background: #343a42;
        color: #d4dbe3;
        font-size: 12px;
        font-weight: 400;
      }
      #codex-runtime-mock-panel .status[data-active="1"] {
        background: #176044;
        color: #dffceb;
      }
      #codex-runtime-mock-panel .status[data-active="2"] {
        background: #6a4d14;
        color: #fff0c5;
      }
      #codex-runtime-mock-panel .panelActions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #codex-runtime-mock-panel button {
        min-width: 0;
        height: 30px;
        border: 1px solid #4b5560;
        border-radius: 6px;
        background: #242a31;
        color: #f7fafc;
        padding: 0 10px;
        cursor: pointer;
        font: inherit;
      }
      #codex-runtime-mock-panel button:hover { background: #2f3740; }
      #codex-runtime-mock-panel button.primary {
        border-color: #28734e;
        background: #1f6f48;
      }
      #codex-runtime-mock-panel button.primary:hover { background: #278257; }
      #codex-runtime-mock-panel button.danger {
        border-color: #794241;
        background: #5c2d2d;
      }
      #codex-runtime-mock-panel [data-action="minimize"] {
        width: 30px;
        padding: 0;
        font-size: 18px;
        line-height: 1;
      }
      #codex-runtime-mock-panel .panelBody {
        display: grid;
        grid-template-columns: 112px 1fr;
        min-height: 410px;
        max-height: calc(100vh - 104px);
      }
      #codex-runtime-mock-panel[data-minimized="1"] {
        width: 280px;
      }
      #codex-runtime-mock-panel[data-minimized="1"] header {
        border-bottom: 0;
      }
      #codex-runtime-mock-panel[data-minimized="1"] .panelBody {
        display: none;
      }
      #codex-runtime-mock-panel .tabs {
        padding: 10px 8px;
        border-right: 1px solid rgba(255,255,255,.08);
        background: rgba(255,255,255,.025);
      }
      #codex-runtime-mock-panel .tab {
        width: 100%;
        justify-content: flex-start;
        margin-bottom: 7px;
        text-align: left;
        color: #cfd6dd;
      }
      #codex-runtime-mock-panel .tab[data-active="1"] {
        border-color: #4e8fbd;
        background: #163548;
        color: #edf8ff;
      }
      #codex-runtime-mock-panel .content {
        min-width: 0;
        padding: 12px;
        overflow: auto;
      }
      #codex-runtime-mock-panel .sectionTitle {
        margin: 0 0 10px;
        color: #ffffff;
        font-weight: 700;
      }
      #codex-runtime-mock-panel label {
        display: grid;
        grid-template-columns: 96px minmax(0, 1fr);
        align-items: center;
        gap: 8px;
        margin: 8px 0;
      }
      #codex-runtime-mock-panel label.wide {
        grid-template-columns: 1fr;
        gap: 5px;
      }
      #codex-runtime-mock-panel input,
      #codex-runtime-mock-panel select,
      #codex-runtime-mock-panel textarea {
        width: 100%;
        min-width: 0;
        min-height: 30px;
        border: 1px solid #454f59;
        border-radius: 6px;
        background: #101419;
        color: #f7fafc;
        padding: 5px 8px;
        font: inherit;
        user-select: text;
      }
      #codex-runtime-mock-panel input[type="checkbox"] {
        width: 17px;
        min-height: 17px;
        padding: 0;
        user-select: none;
      }
      #codex-runtime-mock-panel textarea {
        min-height: 86px;
        resize: vertical;
      }
      #codex-runtime-mock-panel output,
      #codex-runtime-mock-panel .hint {
        color: #b7c0c9;
      }
      #codex-runtime-mock-panel .hint {
        margin: 8px 0 0;
        font-size: 12px;
      }
      #codex-runtime-mock-panel .row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #codex-runtime-mock-panel .row.three {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      #codex-runtime-mock-panel .skillBlock {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid rgba(255,255,255,.08);
      }
      #codex-runtime-mock-panel .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }
      #codex-runtime-mock-panel .logList,
      #codex-runtime-mock-panel .petList {
        max-height: 180px;
        overflow: auto;
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 6px;
        background: rgba(0,0,0,.16);
      }
      #codex-runtime-mock-panel .petList button {
        width: 100%;
        height: auto;
        min-height: 28px;
        border: 0;
        border-radius: 0;
        background: transparent;
        padding: 5px 8px;
        text-align: left;
      }
      #codex-runtime-mock-panel .petList button:hover,
      #codex-runtime-mock-panel .petList button[data-active="1"] {
        background: #22313d;
      }
      #codex-runtime-mock-panel .logLine,
      #codex-runtime-mock-panel .petLine {
        padding: 6px 8px;
        border-bottom: 1px solid rgba(255,255,255,.07);
        color: #dce2e8;
        word-break: break-word;
      }
      #codex-runtime-mock-panel .logLine:last-child,
      #codex-runtime-mock-panel .petLine:last-child {
        border-bottom: 0;
      }
      #codex-runtime-mock-panel .muted {
        color: #8f99a3;
      }
      #codex-runtime-mock-panel .bagLayout {
        display: grid;
        grid-template-columns: minmax(170px, .75fr) minmax(170px, .8fr) minmax(245px, 1.1fr);
        gap: 12px;
        align-items: start;
      }
      #codex-runtime-mock-panel .bagMainColumn,
      #codex-runtime-mock-panel .bagQueueColumn,
      #codex-runtime-mock-panel .bagSearchColumn {
        min-width: 0;
      }
      #codex-runtime-mock-panel .bagQueueColumn,
      #codex-runtime-mock-panel .bagSearchColumn {
        padding-left: 12px;
        border-left: 1px solid rgba(255,255,255,.08);
      }
      #codex-runtime-mock-panel .bagSearchColumn {
        display: grid;
        align-content: start;
        gap: 6px;
      }
      #codex-runtime-mock-panel .bagQueueList {
        max-height: 198px;
      }
      #codex-runtime-mock-panel .bagItemList {
        max-height: 300px;
      }
      #codex-runtime-mock-panel .bagQueueColumn .sectionTitle,
      #codex-runtime-mock-panel .bagSearchColumn .sectionTitle {
        margin-bottom: 6px;
      }
      #codex-runtime-mock-panel .bagSearchColumn label {
        margin-top: 0;
      }
      @media (max-width: 520px) {
        #codex-runtime-mock-panel {
          left: 10px;
          right: 10px;
          width: auto;
        }
        #codex-runtime-mock-panel .panelBody {
          grid-template-columns: 1fr;
        }
        #codex-runtime-mock-panel .tabs {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
          border-right: 0;
          border-bottom: 1px solid rgba(255,255,255,.08);
        }
        #codex-runtime-mock-panel .tab {
          margin-bottom: 0;
          text-align: center;
        }
        #codex-runtime-mock-panel .row.three {
          grid-template-columns: 1fr;
        }
        #codex-runtime-mock-panel .bagLayout {
          grid-template-columns: 1fr;
        }
        #codex-runtime-mock-panel .bagQueueColumn,
        #codex-runtime-mock-panel .bagSearchColumn {
          padding-left: 0;
          border-left: 0;
          border-top: 1px solid rgba(255,255,255,.08);
          padding-top: 10px;
        }
      }
    `;
    document.documentElement.appendChild(style);

    const root = document.createElement("section");
    root.id = "codex-runtime-mock-panel";
    root.innerHTML = `
      <header>
        <div class="title">
          <span>运行时 Mock</span>
          <span class="status" data-role="status">关闭</span>
        </div>
        <div class="panelActions">
          <button type="button" data-action="minimize" title="最小化">-</button>
        </div>
      </header>
      <div class="panelBody">
        <nav class="tabs">
          <button type="button" class="tab" data-tab="pet">宠物</button>
          ${BAG_UI_ENABLED ? `<button type="button" class="tab" data-tab="bag">背包</button>` : ""}
          <button type="button" class="tab" data-tab="currency">晶币</button>
          <button type="button" class="tab" data-tab="params">参数</button>
          <button type="button" class="tab" data-tab="logs">日志</button>
        </nav>
        <div class="content" data-role="content"></div>
      </div>
    `;
    document.body.appendChild(root);

    const tabs = root.querySelector(".tabs");
    const paramsTab = root.querySelector('[data-tab="params"]');
    if (tabs && paramsTab && !root.querySelector('[data-tab="shop"]')) {
      const shopTab = document.createElement("button");
      shopTab.type = "button";
      shopTab.className = "tab";
      shopTab.dataset.tab = "shop";
      shopTab.textContent = "商城";
      tabs.insertBefore(shopTab, paramsTab);
    }

    if (panelState.x !== null && panelState.y !== null) {
      root.style.left = `${Math.max(0, panelState.x)}px`;
      root.style.top = `${Math.max(0, panelState.y)}px`;
      root.style.right = "auto";
    }
    root.dataset.minimized = panelState.minimized ? "1" : "0";
    root.querySelector("[data-action=minimize]").textContent = panelState.minimized ? "+" : "-";

    root.addEventListener("click", handleClick);
    root.addEventListener("input", handleInput);
    root.addEventListener("change", handleInput);
    root.querySelector("[data-action=minimize]").addEventListener("click", () => {
      const minimized = root.dataset.minimized !== "1";
      root.dataset.minimized = minimized ? "1" : "0";
      root.querySelector("[data-action=minimize]").textContent = minimized ? "+" : "-";
      const rect = root.getBoundingClientRect();
      savePanelState({ x: rect.left, y: rect.top, minimized });
    });

    enableDrag(root);
    renderPanel();
  }

  function handleClick(event) {
    const root = document.getElementById("codex-runtime-mock-panel");
    const target = event.target.closest("button");
    if (!root || !target || !root.contains(target)) {
      return;
    }

    const tab = target.dataset.tab;
    if (tab) {
      saveState({ activeTab: tab });
      return;
    }

    const action = target.dataset.action;
    if (!action) {
      return;
    }

    if (action === "pet-enable") {
      saveState({ petEnabled: true });
      log("宠物 mock 已开启", `${selectedPetLabel()} 等级 ${state.petLevel} 融合 ${state.petFusionLevel}`);
      return;
    }
    if (action === "pet-disable") {
      saveState({ petEnabled: false });
      log("宠物 mock 已关闭");
      return;
    }
    if (action === "send-bag-items-now") {
      sendBagItemsNow();
      return;
    }
    if (action === "currency-enable") {
      saveState({ currencyEnabled: true });
      log("晶币 mock 已开启", `goldCurr=${state.currencyValue}`);
      return;
    }
    if (action === "currency-disable") {
      saveState({ currencyEnabled: false });
      log("晶币 mock 已关闭");
      return;
    }
    if (action === "shop-buy-enable") {
      saveState({ shopBuyEnabled: true });
      log("商城购买 mock 已开启", "星际商城购买将本地回调成功");
      return;
    }
    if (action === "shop-buy-disable") {
      saveState({ shopBuyEnabled: false });
      log("商城购买 mock 已关闭", "购买继续走官方接口");
      return;
    }
    if (action === "select-item") {
      saveState({ bagItemId: target.dataset.itemId });
      log("选择道具", selectedBagItemLabel());
      return;
    }
    if (action === "add-bag-item") {
      const current = normalizeState(state);
      const nextItems = [
        ...current.bagItems,
        {
          id: current.bagItemId,
          count: current.bagItemCount,
        },
      ].slice(0, MAX_BAG_ITEMS);
      saveState({ bagItems: nextItems });
      log("添加道具队列", bagItemLabel(nextItems[nextItems.length - 1]));
      return;
    }
    if (action === "remove-bag-item") {
      const index = clampNumber(target.dataset.itemIndex, -1, -1, MAX_BAG_ITEMS - 1);
      const nextItems = normalizeState(state).bagItems.filter((_, itemIndex) => itemIndex !== index);
      saveState({ bagItems: nextItems });
      log("移除道具队列", `第 ${index + 1} 项`);
      return;
    }
    if (action === "clear-bag-items") {
      saveState({ bagItems: [] });
      log("清空道具队列");
      return;
    }
    if (action === "select-pet") {
      saveState({ petId: target.dataset.petId, petEnabled: true });
      log("选择宠物", selectedPetLabel());
      return;
    }
    if (action === "clear-logs") {
      saveState({ logs: [] });
      return;
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (!target || !target.dataset || !target.dataset.field) {
      return;
    }

    const field = target.dataset.field;
    if (field === "petSearch") {
      renderPetList(target.value);
      return;
    }
    if (field === "itemSearch") {
      renderItemList(target.value);
      return;
    }

    const next = {};
    if (field === "petEnabled") next.petEnabled = target.checked;
    if (field === "petConsumeOnUse") next.petConsumeOnUse = target.checked;
    if (field === "petId") next.petId = target.value;
    if (field === "petLevel") next.petLevel = target.value;
    if (field === "petFusionLevel") next.petFusionLevel = target.value;
    if (field === "petSlotMode") next.petSlotMode = target.value;
    if (field === "petSlot") next.petSlot = target.value;
    if (field === "petStage") next.petStage = target.value;
    if (field === "bagItemId") next.bagItemId = target.value;
    if (field === "bagItemCount") next.bagItemCount = target.value;
    if (field === "bagFilterBag") next.bagFilterBag = target.value;
    if (field === "bagFilterType") next.bagFilterType = target.value;
    if (field === "currencyEnabled") next.currencyEnabled = target.checked;
    if (field === "currencyValue") next.currencyValue = target.value;
    if (field === "shopBuyEnabled") next.shopBuyEnabled = target.checked;
    for (const prefix of ["lwSkill1", "useSkill1", "useSkill2", "useSkill3", "useSkill4"]) {
      if (field === `${prefix}Enabled`) next[`${prefix}Enabled`] = target.checked;
      if (field === `${prefix}Id`) next[`${prefix}Id`] = target.value;
      if (field === `${prefix}Level`) next[`${prefix}Level`] = target.value;
      if (field === `${prefix}Exp`) next[`${prefix}Exp`] = target.value;
    }
    const shouldRender = target.type === "checkbox" || event.type === "change";
    if (shouldRender) {
      saveState(next);
    } else {
      saveStateQuiet(next);
      renderStatus();
    }
  }

  function renderPanel() {
    const root = document.getElementById("codex-runtime-mock-panel");
    if (!root) {
      return;
    }

    renderStatus();

    for (const button of root.querySelectorAll("[data-tab]")) {
      button.dataset.active = button.dataset.tab === state.activeTab ? "1" : "0";
    }

    const content = root.querySelector("[data-role=content]");
    if (!content) {
      return;
    }
    content.dataset.tab = state.activeTab;

    if (state.activeTab === "pet") {
      content.innerHTML = renderPetTab();
      renderPetList("");
    } else if (state.activeTab === "bag") {
      content.innerHTML = renderBagTab();
      renderItemList("");
    } else if (state.activeTab === "currency") {
      content.innerHTML = renderCurrencyTab();
    } else if (state.activeTab === "shop") {
      content.innerHTML = renderShopTab();
    } else if (state.activeTab === "params") {
      content.innerHTML = renderParamsTab();
    } else {
      content.innerHTML = renderLogsTab();
      renderLogs();
    }
  }

  function renderStatus() {
    const root = document.getElementById("codex-runtime-mock-panel");
    const status = root?.querySelector("[data-role=status]");
    if (!status) {
      return;
    }

    const freshWindow = 30000;
    const petReadFresh = state.petLastReadAt && Date.now() - state.petLastReadAt < freshWindow;
    const bagReadFresh = state.bagLastReadAt && Date.now() - state.bagLastReadAt < freshWindow;
    const currencyReadFresh = state.currencyLastReadAt && Date.now() - state.currencyLastReadAt < freshWindow;
    const shopBuyReadFresh = state.shopBuyLastReadAt && Date.now() - state.shopBuyLastReadAt < freshWindow;

    if (petReadFresh) {
      status.textContent = "宠物已触发";
      status.dataset.active = "1";
    } else if (bagReadFresh) {
      status.textContent = "道具已触发";
      status.dataset.active = "1";
    } else if (currencyReadFresh) {
      status.textContent = "晶币已触发";
      status.dataset.active = "1";
    } else if (shopBuyReadFresh) {
      status.textContent = "商城购买已触发";
      status.dataset.active = "1";
    } else if (state.petEnabled) {
      status.textContent = "宠物待触发";
      status.dataset.active = "2";
    } else if (state.currencyEnabled) {
      status.textContent = "晶币待触发";
      status.dataset.active = "2";
    } else if (state.shopBuyEnabled) {
      status.textContent = "商城购买待触发";
      status.dataset.active = "2";
    } else {
      status.textContent = "关闭";
      status.dataset.active = "0";
    }
  }

  function renderPetTab() {
    const pet = petById(state.petId);
    const asset = pet?.asset ? `资源 ${escapeHtml(pet.asset)}` : "资源未知";
    return `
      <p class="sectionTitle">宠物 Mock</p>
      <label><span>启用</span><input data-field="petEnabled" type="checkbox" ${state.petEnabled ? "checked" : ""}></label>
      <label><span>触发后关闭</span><input data-field="petConsumeOnUse" type="checkbox" ${state.petConsumeOnUse ? "checked" : ""}></label>
      <label><span>当前宠物</span><output>${escapeHtml(selectedPetLabel())}</output></label>
      <label><span>最近读取</span><output>${escapeHtml(lastReadText(state.petLastReadAt))}</output></label>
      <div class="row">
        <label class="wide"><span>ID</span><input data-field="petId" type="number" min="1" max="999999" value="${state.petId}"></label>
        <label class="wide"><span>等级</span><input data-field="petLevel" type="number" min="1" max="100" value="${state.petLevel}"></label>
      </div>
      <label><span>融合等级</span><input data-field="petFusionLevel" type="number" min="0" max="99" value="${state.petFusionLevel}"></label>
      <div class="row">
        <label class="wide"><span>写入方式</span><select data-field="petSlotMode">
          <option value="append" ${state.petSlotMode === "append" ? "selected" : ""}>首个空位</option>
          <option value="replace" ${state.petSlotMode === "replace" ? "selected" : ""}>替换指定位置</option>
        </select></label>
        <label class="wide"><span>指定位置</span><input data-field="petSlot" type="number" min="1" max="99" value="${state.petSlot}"></label>
      </div>
      <label class="wide"><span>搜索宠物</span><input data-field="petSearch" type="search" placeholder="输入名称或 ID"></label>
      <div class="petList" data-role="petList"></div>
      <p class="hint">首个空位会扫描宠物栏和蛋栏；替换指定位置会直接覆盖对应宠物槽。需要在进入存档前开启，Flash 初始化读取后生效。${asset}。已配置 ${enabledSkillCount()} 个技能。</p>
      <div class="actions">
        <button type="button" class="primary" data-action="pet-enable">开启宠物</button>
        <button type="button" data-action="pet-disable">关闭宠物</button>
      </div>
    `;
  }

  function renderPetList(filter) {
    const root = document.getElementById("codex-runtime-mock-panel");
    const list = root?.querySelector("[data-role=petList]");
    if (!list) {
      return;
    }

    const query = String(filter || "").trim().toLowerCase();
    const filtered = petList
      .filter((pet) => {
        if (!query) return true;
        return String(pet.id).includes(query) ||
          String(pet.name || "").toLowerCase().includes(query) ||
          String(pet.asset || "").toLowerCase().includes(query);
      })
      .slice(0, 80);

    if (filtered.length === 0) {
      list.innerHTML = `<div class="logLine muted">没有匹配的宠物，可直接填写 ID。</div>`;
      return;
    }

    list.innerHTML = filtered.map((pet) => `
      <button type="button" data-action="select-pet" data-pet-id="${pet.id}" data-active="${pet.id === state.petId ? "1" : "0"}">
        ${escapeHtml(pet.name)} <span class="muted">ID ${pet.id}${pet.species ? ` / ${escapeHtml(pet.species)}` : ""}</span>
      </button>
    `).join("");
  }

  function renderBagTab() {
    const bagOptions = [-1, ...new Set(itemList.map((item) => item.bag).filter((value) => Number.isFinite(value)).sort((a, b) => a - b))];
    const typeOptions = [-1, ...new Set(itemList.map((item) => item.type).filter((value) => Number.isFinite(value)).sort((a, b) => a - b))];
    const queuedItems = normalizeState(state).bagItems;
    return `
      <p class="sectionTitle">发送道具</p>
      <div class="bagLayout">
        <div class="bagMainColumn">
          <label><span>当前选择</span><output>${escapeHtml(selectedBagItemLabel())}</output></label>
          <label><span>队列数量</span><output>${queuedItems.length}/${MAX_BAG_ITEMS}</output></label>
          <label><span>最近读取</span><output>${escapeHtml(lastReadText(state.bagLastReadAt))}</output></label>
          <label><span>分类空位</span><output>${escapeHtml(bagSnapshotText())}</output></label>
          <div class="row">
            <label class="wide"><span>道具 ID</span><input data-field="bagItemId" type="number" min="1" max="999999" value="${state.bagItemId}"></label>
            <label class="wide"><span>数量</span><input data-field="bagItemCount" type="number" min="1" max="999" value="${state.bagItemCount}"></label>
          </div>
          <div class="actions">
            <button type="button" class="primary" data-action="add-bag-item">加入队列</button>
            <button type="button" data-action="clear-bag-items">清空队列</button>
            <button type="button" class="primary" data-action="send-bag-items-now">立即发送</button>
          </div>
        </div>
        <div class="bagQueueColumn">
          <p class="sectionTitle">发送队列</p>
          <div class="petList bagQueueList">${renderBagQueue()}</div>
        </div>
        <div class="bagSearchColumn">
          <p class="sectionTitle">搜索道具</p>
          <div class="row">
            <label class="wide"><span>背包分类</span><select data-field="bagFilterBag">${bagOptions.map((value) => `<option value="${value}" ${value === state.bagFilterBag ? "selected" : ""}>${value === -1 ? "全部" : `${bagLabel(value)} / ${value}`}</option>`).join("")}</select></label>
            <label class="wide"><span>类型</span><select data-field="bagFilterType">${typeOptions.map((value) => `<option value="${value}" ${value === state.bagFilterType ? "selected" : ""}>${value === -1 ? "全部" : `类型 ${value}`}</option>`).join("")}</select></label>
          </div>
          <label class="wide"><span>关键词</span><input data-field="itemSearch" type="search" placeholder="输入名称、ID、类型或背包"></label>
          <div class="petList bagItemList" data-role="itemList"></div>
        </div>
      </div>
    `;
  }

  function renderBagQueue() {
    const items = normalizeState(state).bagItems;
    if (items.length === 0) {
      return `<div class="logLine muted">队列为空，选择道具后点加入队列。</div>`;
    }
    return items.map((item, index) => `
      <div class="logLine">
        ${escapeHtml(`${index + 1}. ${bagItemLabel(item)}`)}
        <button type="button" data-action="remove-bag-item" data-item-index="${index}">移除</button>
      </div>
    `).join("");
  }

  function renderCurrencyTab() {
    return `
      <p class="sectionTitle">晶币 Mock</p>
      <label><span>启用</span><input data-field="currencyEnabled" type="checkbox" ${state.currencyEnabled ? "checked" : ""}></label>
      <label><span>晶币值</span><input data-field="currencyValue" type="number" min="0" max="999999999" value="${state.currencyValue}"></label>
      <label><span>最近读取</span><output>${escapeHtml(lastReadText(state.currencyLastReadAt))}</output></label>
      <p class="hint">开启后，Flash 读取 goldCurr 时返回这里的数值；关闭后返回 -1，让游戏继续使用原本的晶币数据。</p>
      <div class="actions">
        <button type="button" class="primary" data-action="currency-enable">开启晶币</button>
        <button type="button" data-action="currency-disable">关闭晶币</button>
      </div>
    `;
  }

  function renderShopTab() {
    return `
      <p class="sectionTitle">商城购买 Mock</p>
      <label><span>启用</span><input data-field="shopBuyEnabled" type="checkbox" ${state.shopBuyEnabled ? "checked" : ""}></label>
      <label><span>最近触发</span><output>${escapeHtml(lastReadText(state.shopBuyLastReadAt))}</output></label>
      <p class="hint">目标是星际商城购买链路：GameShangChengS -> GameShangChengC.buyShopByClick -> Api4399.getStateAndBuyShopProp。开启后，购买按钮会跳过后端返回等待，在本地调用成功回调；关闭时继续走原官方购买流程。</p>
      <div class="actions">
        <button type="button" class="primary" data-action="shop-buy-enable">开启商城购买</button>
        <button type="button" data-action="shop-buy-disable">关闭商城购买</button>
      </div>
    `;
  }

  function renderItemList(filter) {
    const root = document.getElementById("codex-runtime-mock-panel");
    const list = root?.querySelector("[data-role=itemList]");
    if (!list) {
      return;
    }

    const query = String(filter || "").trim().toLowerCase();
    const filtered = itemList
      .filter((item) => {
        if (state.bagFilterBag !== -1 && item.bag !== state.bagFilterBag) return false;
        if (state.bagFilterType !== -1 && item.type !== state.bagFilterType) return false;
        if (!query) return true;
        return String(item.id).includes(query) ||
          String(item.name || "").toLowerCase().includes(query) ||
          String(item.type || "").includes(query) ||
          String(item.smallType || "").includes(query) ||
          String(item.bag || "").includes(query) ||
          bagLabel(item.bag).toLowerCase().includes(query);
      })
      .slice(0, 160);

    if (filtered.length === 0) {
      list.innerHTML = `<div class="logLine muted">没有匹配的道具，可以直接填写 ID。</div>`;
      return;
    }

    list.innerHTML = filtered.map((item) => `
      <button type="button" data-action="select-item" data-item-id="${item.id}" data-active="${item.id === state.bagItemId ? "1" : "0"}">
        ${escapeHtml(item.name || "未命名")} <span class="muted">ID ${item.id} / ${escapeHtml(bagLabel(item.bag))} / 类型 ${item.type} / 小类 ${item.smallType}${item.canUse ? " / 可用" : ""}${item.stack > 0 ? ` / 叠加 ${item.stack}` : ""}</span>
      </button>
    `).join("");
  }

  function renderParamsTab() {
    return `
      <p class="sectionTitle">宠物参数</p>
      <label><span>进化阶段</span><input data-field="petStage" type="number" min="0" max="4" value="${state.petStage}"></label>
      <p class="hint">阶段字段来自 PetR.curLWJieDuan，游戏逻辑里范围通常是 0-4。技能存档字段为 bid/cexp/clv，配置后会在注入宠物时写入运行时对象。</p>
      ${renderSkillEditor("lwSkill1", "灵武技能", SKILL_CODES.lw1)}
      ${renderSkillEditor("useSkill1", "出战技能 1", SKILL_CODES.use1)}
      ${renderSkillEditor("useSkill2", "出战技能 2", SKILL_CODES.use2)}
      ${renderSkillEditor("useSkill3", "出战技能 3", SKILL_CODES.use3)}
      ${renderSkillEditor("useSkill4", "出战技能 4", SKILL_CODES.use4)}
    `;
  }

  function renderSkillEditor(prefix, label, code) {
    return `
      <div class="skillBlock">
        <label><span>${escapeHtml(label)}</span><input data-field="${prefix}Enabled" type="checkbox" ${state[`${prefix}Enabled`] ? "checked" : ""}></label>
        <div class="row three">
          <label class="wide"><span>技能 ID</span><input data-field="${prefix}Id" type="number" min="0" max="999999" value="${state[`${prefix}Id`]}"></label>
          <label class="wide"><span>等级</span><input data-field="${prefix}Level" type="number" min="1" max="100" value="${state[`${prefix}Level`]}"></label>
          <label class="wide"><span>经验</span><input data-field="${prefix}Exp" type="number" min="0" max="999999999" value="${state[`${prefix}Exp`]}"></label>
        </div>
        <p class="hint">内部槽码 ${code}</p>
      </div>
    `;
  }

  function renderLogsTab() {
    return `
      <p class="sectionTitle">运行日志</p>
      <div class="actions">
        <button type="button" class="danger" data-action="clear-logs">清空日志</button>
      </div>
      <div class="logList" data-role="logList"></div>
      <p class="hint">如果进入存档后才开启宠物 mock，这里通常只能看到查询关闭或没有查询记录。</p>
    `;
  }

  function renderLogs() {
    const root = document.getElementById("codex-runtime-mock-panel");
    const list = root?.querySelector("[data-role=logList]");
    if (!list) {
      return;
    }

    if (!state.logs.length) {
      list.innerHTML = `<div class="logLine muted">暂无日志</div>`;
      return;
    }

    list.innerHTML = state.logs.slice(-30).reverse().map((item) => {
      const time = item.at ? new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false }) : nowText();
      return `<div class="logLine"><span class="muted">${escapeHtml(time)}</span> ${escapeHtml(item.text)}${item.detail ? `<br><span class="muted">${escapeHtml(item.detail)}</span>` : ""}</div>`;
    }).join("");
  }

  function enableDrag(root) {
    const header = root.querySelector("header");
    let drag = null;

    header.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) {
        return;
      }

      const rect = root.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      root.style.left = `${rect.left}px`;
      root.style.top = `${rect.top}px`;
      root.style.right = "auto";
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    header.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      const maxX = Math.max(0, window.innerWidth - root.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - root.offsetHeight);
      const nextX = Math.min(maxX, Math.max(0, event.clientX - drag.offsetX));
      const nextY = Math.min(maxY, Math.max(0, event.clientY - drag.offsetY));
      root.style.left = `${nextX}px`;
      root.style.top = `${nextY}px`;
    });

    function stopDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      const rect = root.getBoundingClientRect();
      savePanelState({
        x: rect.left,
        y: rect.top,
        minimized: root.dataset.minimized === "1",
      });
      drag = null;
    }

    header.addEventListener("pointerup", stopDrag);
    header.addEventListener("pointercancel", stopDrag);
  }

  log("面板已加载", petList.length ? `宠物列表 ${petList.length} 个` : "未找到宠物列表");

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createPanel, { once: true });
  } else {
    createPanel();
  }
}());
