const fs = require("fs");
const path = require("path");

const windowsFontDir = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");

const CORE_FONT_FILES = [
  { name: "simsun.ttc", path: path.join(windowsFontDir, "simsun.ttc"), type: "font/collection" },
  { name: "simhei.ttf", path: path.join(windowsFontDir, "simhei.ttf"), type: "font/ttf" },
  { name: "msyh.ttc", path: path.join(windowsFontDir, "msyh.ttc"), type: "font/collection" },
];

const EXTRA_FONT_FILES = [
  { name: "msyhbd.ttc", path: path.join(windowsFontDir, "msyhbd.ttc"), type: "font/collection" },
  { name: "arial.ttf", path: path.join(windowsFontDir, "arial.ttf"), type: "font/ttf" },
  { name: "times.ttf", path: path.join(windowsFontDir, "times.ttf"), type: "font/ttf" },
];

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    return "/";
  }
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function availableFontSources(baseUrl) {
  const prefix = normalizeBaseUrl(baseUrl);
  return ruffleFontFiles()
    .filter((font) => fs.existsSync(font.path))
    .map((font) => `${prefix}fonts/${encodeURIComponent(font.name)}`);
}

function getRuffleFontFile(name) {
  const font = [...CORE_FONT_FILES, ...EXTRA_FONT_FILES].find((item) => (
    item.name.toLowerCase() === String(name).toLowerCase()
  ));
  if (!font || !fs.existsSync(font.path)) {
    return null;
  }
  return font;
}

function ruffleFontFiles() {
  return process.env.RUFFLE_FONT_SET === "full"
    ? [...CORE_FONT_FILES, ...EXTRA_FONT_FILES]
    : CORE_FONT_FILES;
}

function deviceFontRenderer() {
  return process.env.RUFFLE_DEVICE_FONT_RENDERER || "embedded";
}

function createRuffleConfig(baseUrl) {
  return {
    autoplay: "on",
    unmuteOverlay: "hidden",
    allowScriptAccess: true,
    allowNetworking: "all",
    logLevel: "warn",
    deviceFontRenderer: deviceFontRenderer(),
    fontSources: availableFontSources(baseUrl),
    defaultFonts: {
      sans: [
        "Microsoft YaHei",
        "\u5fae\u8f6f\u96c5\u9ed1",
        "SimSun",
        "\u5b8b\u4f53",
        "SimHei",
        "\u9ed1\u4f53",
        "Arial",
        "Noto Sans",
      ],
      serif: [
        "SimSun",
        "\u5b8b\u4f53",
        "NSimSun",
        "\u65b0\u5b8b\u4f53",
        "Times New Roman",
      ],
      typewriter: [
        "NSimSun",
        "\u65b0\u5b8b\u4f53",
        "SimSun",
        "\u5b8b\u4f53",
        "Consolas",
        "Courier New",
      ],
    },
  };
}

module.exports = {
  createRuffleConfig,
  getRuffleFontFile,
};
