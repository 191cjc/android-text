const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const TAG_NAMES = {
  0: "End",
  1: "ShowFrame",
  2: "DefineShape",
  6: "DefineBits",
  8: "JPEGTables",
  9: "SetBackgroundColor",
  10: "DefineFont",
  11: "DefineText",
  12: "DoAction",
  14: "DefineSound",
  18: "SoundStreamHead",
  19: "SoundStreamBlock",
  20: "DefineBitsLossless",
  21: "DefineBitsJPEG2",
  22: "DefineShape2",
  26: "PlaceObject2",
  32: "DefineShape3",
  33: "DefineText2",
  35: "DefineBitsJPEG3",
  36: "DefineBitsLossless2",
  39: "DefineSprite",
  43: "FrameLabel",
  46: "DefineMorphShape",
  48: "DefineFont2",
  56: "ExportAssets",
  57: "ImportAssets",
  59: "DoInitAction",
  60: "DefineVideoStream",
  61: "VideoFrame",
  62: "DefineFontInfo2",
  69: "FileAttributes",
  70: "PlaceObject3",
  72: "DoABC",
  75: "DefineFont3",
  76: "SymbolClass",
  77: "Metadata",
  82: "DoABC",
  87: "DefineBinaryData",
  88: "DefineFontName",
  89: "StartSound2",
  90: "DefineBitsJPEG4",
  91: "DefineFont4",
};

const IMAGE_TAGS = new Set([6, 21, 35, 90]);
const LOSSLESS_TAGS = new Set([20, 36]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readSwf(filePath) {
  const input = fs.readFileSync(filePath);
  const signature = input.subarray(0, 3).toString("ascii");
  const version = input[3];
  const declaredLength = input.readUInt32LE(4);
  let body = input.subarray(8);

  if (signature === "CWS") {
    body = zlib.inflateSync(body);
  } else if (signature !== "FWS") {
    throw new Error(`Unsupported SWF signature ${signature}`);
  }

  return {
    filePath,
    signature,
    version,
    declaredLength,
    compressedSize: input.length,
    body,
  };
}

function rectByteLength(buffer, offset) {
  const nbits = buffer[offset] >> 3;
  return Math.ceil((5 + nbits * 4) / 8);
}

function tagName(code) {
  return TAG_NAMES[code] || `Tag${code}`;
}

function readCString(buffer, offset) {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) {
    end += 1;
  }
  return {
    value: buffer.subarray(offset, end).toString("utf8"),
    next: end + 1,
  };
}

function extensionForData(data, fallback = "bin") {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "jpg";
  }
  if (data.length >= 6 && data.subarray(0, 3).toString("ascii") === "GIF") {
    return "gif";
  }
  if (data.length >= 3 && data.subarray(0, 3).toString("ascii") === "CWS") {
    return "swf";
  }
  if (data.length >= 3 && data.subarray(0, 3).toString("ascii") === "FWS") {
    return "swf";
  }
  if (data.length >= 3 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) {
    return "mp3";
  }
  if (data.length >= 3 && data.subarray(0, 3).toString("ascii") === "ID3") {
    return "mp3";
  }
  return fallback;
}

function safeName(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function rgbaToPng(width, height, rgba) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (stride + 1)] = 0;
    rgba.copy(scanlines, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    header,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function losslessToPng(payload, hasAlpha) {
  if (payload.length < 7) {
    return null;
  }

  const format = payload[2];
  const width = payload.readUInt16LE(3);
  const height = payload.readUInt16LE(5);
  let offset = 7;
  let colorTableSize = 0;
  if (format === 3) {
    colorTableSize = payload[offset] + 1;
    offset += 1;
  }

  let data;
  try {
    data = zlib.inflateSync(payload.subarray(offset));
  } catch {
    return null;
  }

  const rgba = Buffer.alloc(width * height * 4);

  if (format === 3) {
    const entrySize = hasAlpha ? 4 : 3;
    const palette = [];
    let paletteOffset = 0;
    for (let index = 0; index < colorTableSize; index += 1) {
      const r = data[paletteOffset];
      const g = data[paletteOffset + 1];
      const b = data[paletteOffset + 2];
      const a = hasAlpha ? data[paletteOffset + 3] : 255;
      palette.push([r, g, b, a]);
      paletteOffset += entrySize;
    }

    const rowBytes = Math.ceil(width / 4) * 4;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const color = palette[data[paletteOffset + y * rowBytes + x]] || [0, 0, 0, 0];
        const pixel = (y * width + x) * 4;
        rgba[pixel] = color[0];
        rgba[pixel + 1] = color[1];
        rgba[pixel + 2] = color[2];
        rgba[pixel + 3] = color[3];
      }
    }
  } else if (format === 4) {
    const rowBytes = Math.ceil((width * 2) / 4) * 4;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const packed = data.readUInt16LE(y * rowBytes + x * 2);
        const pixel = (y * width + x) * 4;
        rgba[pixel] = ((packed >> 10) & 0x1f) * 255 / 31;
        rgba[pixel + 1] = ((packed >> 5) & 0x1f) * 255 / 31;
        rgba[pixel + 2] = (packed & 0x1f) * 255 / 31;
        rgba[pixel + 3] = 255;
      }
    }
  } else if (format === 5) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const source = (y * width + x) * 4;
        const pixel = source;
        if (hasAlpha) {
          rgba[pixel] = data[source + 1];
          rgba[pixel + 1] = data[source + 2];
          rgba[pixel + 2] = data[source + 3];
          rgba[pixel + 3] = data[source];
        } else {
          rgba[pixel] = data[source + 1];
          rgba[pixel + 1] = data[source + 2];
          rgba[pixel + 2] = data[source + 3];
          rgba[pixel + 3] = 255;
        }
      }
    }
  } else {
    return null;
  }

  return {
    width,
    height,
    format,
    png: rgbaToPng(width, height, rgba),
  };
}

function parseSymbolClass(payload) {
  if (payload.length < 2) {
    return [];
  }
  const count = payload.readUInt16LE(0);
  const symbols = [];
  let offset = 2;
  for (let index = 0; index < count && offset + 2 <= payload.length; index += 1) {
    const id = payload.readUInt16LE(offset);
    offset += 2;
    const read = readCString(payload, offset);
    offset = read.next;
    symbols.push({ id, name: read.value });
  }
  return symbols;
}

function parseExportAssets(payload) {
  if (payload.length < 2) {
    return [];
  }
  const count = payload.readUInt16LE(0);
  const exports = [];
  let offset = 2;
  for (let index = 0; index < count && offset + 2 <= payload.length; index += 1) {
    const id = payload.readUInt16LE(offset);
    offset += 2;
    const read = readCString(payload, offset);
    offset = read.next;
    exports.push({ id, name: read.value });
  }
  return exports;
}

function parseTags(buffer, start, end, context, tags = []) {
  let offset = start;
  while (offset + 2 <= end) {
    const headerOffset = offset;
    const header = buffer.readUInt16LE(offset);
    offset += 2;
    const code = header >> 6;
    let length = header & 0x3f;
    if (length === 0x3f) {
      if (offset + 4 > end) {
        break;
      }
      length = buffer.readUInt32LE(offset);
      offset += 4;
    }
    const payloadOffset = offset;
    const payloadEnd = Math.min(offset + length, end);
    const payload = buffer.subarray(payloadOffset, payloadEnd);
    const tag = {
      code,
      name: tagName(code),
      length,
      offset: headerOffset,
      context,
    };
    tags.push(tag);

    if (code === 39 && payload.length >= 4) {
      const spriteId = payload.readUInt16LE(0);
      const frameCount = payload.readUInt16LE(2);
      tag.characterId = spriteId;
      tag.frameCount = frameCount;
      parseTags(payload, 4, payload.length, `sprite:${spriteId}`, tags);
    }

    offset += length;
    if (code === 0 && context !== "root") {
      break;
    }
  }
  return tags;
}

function writeAsset(outputDir, category, name, data) {
  const dir = path.join(outputDir, category);
  ensureDir(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, data);
  return path.relative(outputDir, filePath).replace(/\\/g, "/");
}

function dumpAssets(swf, outputDir) {
  ensureDir(outputDir);
  const frameSizeLength = rectByteLength(swf.body, 0);
  const firstTagOffset = frameSizeLength + 4;
  const tags = parseTags(swf.body, firstTagOffset, swf.body.length, "root");
  const tagCounts = {};
  const assets = [];
  const symbols = [];
  const exports = [];
  let jpegTables = null;

  for (const tag of tags) {
    tagCounts[tag.name] = (tagCounts[tag.name] || 0) + 1;
    const payload = tag.context === "root"
      ? swf.body.subarray(tag.offset, Math.min(tag.offset + 6 + tag.length, swf.body.length))
      : null;
    void payload;
  }

  function payloadForTag(tag) {
    const header = swf.body.readUInt16LE(tag.offset);
    let offset = tag.offset + 2;
    let length = header & 0x3f;
    if (length === 0x3f) {
      length = swf.body.readUInt32LE(offset);
      offset += 4;
    }
    return swf.body.subarray(offset, offset + length);
  }

  for (const tag of tags.filter((item) => item.context === "root")) {
    const payload = payloadForTag(tag);

    if (tag.code === 8) {
      jpegTables = payload;
      writeAsset(outputDir, "raw", "jpeg_tables.bin", payload);
      continue;
    }

    if (tag.code === 76) {
      symbols.push(...parseSymbolClass(payload));
      continue;
    }

    if (tag.code === 56) {
      exports.push(...parseExportAssets(payload));
      continue;
    }

    if (IMAGE_TAGS.has(tag.code) && payload.length >= 2) {
      const id = payload.readUInt16LE(0);
      let imageData = payload.subarray(2);
      let alphaData = null;
      if (tag.code === 35 && payload.length >= 6) {
        const alphaOffset = payload.readUInt32LE(2);
        imageData = payload.subarray(6, 6 + alphaOffset);
        alphaData = payload.subarray(6 + alphaOffset);
      } else if (tag.code === 90 && payload.length >= 8) {
        const alphaOffset = payload.readUInt32LE(2);
        imageData = payload.subarray(8, 8 + alphaOffset);
        alphaData = payload.subarray(8 + alphaOffset);
      }
      if (tag.code === 6 && jpegTables && imageData[0] !== 0xff) {
        imageData = Buffer.concat([jpegTables, imageData]);
      }
      const ext = extensionForData(imageData, "img");
      const file = writeAsset(outputDir, "images", `${id}_${tag.name}.${ext}`, imageData);
      const asset = { id, kind: "image", tag: tag.name, file, size: imageData.length, format: ext };
      if (alphaData?.length) {
        asset.alphaFile = writeAsset(outputDir, "images", `${id}_${tag.name}.alpha.zlib`, alphaData);
        asset.alphaSize = alphaData.length;
      }
      assets.push(asset);
      continue;
    }

    if (LOSSLESS_TAGS.has(tag.code) && payload.length >= 7) {
      const id = payload.readUInt16LE(0);
      const converted = losslessToPng(payload, tag.code === 36);
      if (converted) {
        const file = writeAsset(outputDir, "images", `${id}_${tag.name}.png`, converted.png);
        assets.push({
          id,
          kind: "image",
          tag: tag.name,
          file,
          size: converted.png.length,
          width: converted.width,
          height: converted.height,
          bitmapFormat: converted.format,
        });
      }
      writeAsset(outputDir, "raw", `${id}_${tag.name}.bin`, payload);
      continue;
    }

    if (tag.code === 14 && payload.length >= 7) {
      const id = payload.readUInt16LE(0);
      const packed = payload[2];
      const soundFormat = packed >> 4;
      const soundRate = (packed >> 2) & 3;
      const soundSize = (packed >> 1) & 1;
      const soundType = packed & 1;
      const sampleCount = payload.readUInt32LE(3);
      const rawData = payload.subarray(7);
      let data = rawData;
      if (soundFormat === 2 && rawData.length > 2) {
        data = rawData.subarray(2);
      }
      const ext = soundFormat === 2 ? "mp3" : extensionForData(data, "sound");
      const file = writeAsset(outputDir, "sounds", `${id}_${tag.name}.${ext}`, data);
      assets.push({
        id,
        kind: "sound",
        tag: tag.name,
        file,
        size: data.length,
        soundFormat,
        soundRate,
        soundSize,
        soundType,
        sampleCount,
      });
      continue;
    }

    if (tag.code === 87 && payload.length >= 6) {
      const id = payload.readUInt16LE(0);
      const data = payload.subarray(6);
      const ext = extensionForData(data, "bin");
      const file = writeAsset(outputDir, "binary", `${id}_${tag.name}.${ext}`, data);
      assets.push({ id, kind: "binary", tag: tag.name, file, size: data.length, format: ext });
      continue;
    }
  }

  const symbolById = new Map();
  for (const symbol of [...exports, ...symbols]) {
    if (!symbolById.has(symbol.id)) {
      symbolById.set(symbol.id, []);
    }
    symbolById.get(symbol.id).push(symbol.name);
  }
  for (const asset of assets) {
    asset.names = symbolById.get(asset.id) || [];
  }

  const report = {
    source: swf.filePath,
    signature: swf.signature,
    version: swf.version,
    compressedSize: swf.compressedSize,
    declaredLength: swf.declaredLength,
    inflatedSize: swf.body.length + 8,
    frame: {
      firstTagOffset,
    },
    tagCounts,
    assets,
    symbols,
    exports,
  };

  fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(report, null, 2));
  return report;
}

function main() {
  const file = process.argv[2] || path.join("modified", "xfbbv451.swf");
  const baseName = path.basename(file, path.extname(file));
  const outputDir = process.argv[3] || path.join("assets", "exported", baseName);
  const swf = readSwf(file);
  const report = dumpAssets(swf, outputDir);

  console.log({
    source: file,
    outputDir,
    version: report.version,
    compressedSize: report.compressedSize,
    inflatedSize: report.inflatedSize,
    tagTypes: Object.keys(report.tagCounts).length,
    assetCount: report.assets.length,
    imageCount: report.assets.filter((asset) => asset.kind === "image").length,
    soundCount: report.assets.filter((asset) => asset.kind === "sound").length,
    binaryCount: report.assets.filter((asset) => asset.kind === "binary").length,
    symbolCount: report.symbols.length,
    exportCount: report.exports.length,
  });
}

main();
