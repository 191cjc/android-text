const zlib = require("zlib");

function findElementEnd(xml, start) {
  const tagAtStart = /^<s\b[^>]*>/i.exec(xml.slice(start));
  if (!tagAtStart || /\/>\s*$/i.test(tagAtStart[0])) {
    return start + (tagAtStart ? tagAtStart[0].length : 0);
  }

  const tagPattern = /<\/?s\b[^>]*\/?>/gi;
  tagPattern.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(xml))) {
    const tag = match[0];
    if (/^<\/s\b/i.test(tag)) {
      depth -= 1;
    } else if (!/\/>\s*$/i.test(tag)) {
      depth += 1;
    }
    if (depth === 0) {
      return tagPattern.lastIndex;
    }
  }

  return -1;
}

function readNumberField(block, name) {
  const pattern = new RegExp(`<s\\s+type="Number"\\s+name="${name}">([^<]*)<\\/s>`, "i");
  const match = pattern.exec(block);
  return match ? match[1] : null;
}

function replacementCheckBlock(block) {
  const leadingWhitespace = /^\s*/.exec(block)?.[0] || "";
  const childWhitespace = `${leadingWhitespace}  `;
  const co = readNumberField(block, "co");
  const idai = readNumberField(block, "idai");
  const lines = [
    `${leadingWhitespace}<s type="Object" name="cm">`,
    `${childWhitespace}<s type="Array" name="fa"/>`,
    `${childWhitespace}<s type="Array" name="dm"/>`,
  ];

  if (idai != null) {
    lines.push(`${childWhitespace}<s type="Number" name="idai">${idai}</s>`);
  }
  if (co != null) {
    lines.push(`${childWhitespace}<s type="Number" name="co">${co}</s>`);
  }

  lines.push(`${leadingWhitespace}</s>`);
  return lines.join("\n");
}

function looksLikeCheckFlagBlock(block) {
  return /\bname="fa"/i.test(block) && /\bname="dm"/i.test(block);
}

function sanitizeSaveXml(xml) {
  if (typeof xml !== "string" || !xml.includes('name="cm"')) {
    return { xml, changed: false, checkBlocks: 0 };
  }

  const blockPattern = /<s\b(?=[^>]*\btype="Object")(?=[^>]*\bname="cm")[^>]*>/gi;
  let cursor = 0;
  let changed = false;
  let checkBlocks = 0;
  let output = "";
  let match;

  while ((match = blockPattern.exec(xml))) {
    const start = match.index;
    const end = findElementEnd(xml, start);
    if (end <= start) {
      continue;
    }

    const block = xml.slice(start, end);
    if (!looksLikeCheckFlagBlock(block)) {
      continue;
    }

    const replacement = replacementCheckBlock(block);
    output += xml.slice(cursor, start);
    output += replacement;
    cursor = end;
    changed = changed || replacement !== block;
    checkBlocks += 1;
    blockPattern.lastIndex = end;
  }

  if (checkBlocks === 0) {
    return { xml, changed: false, checkBlocks };
  }

  output += xml.slice(cursor);
  return {
    xml: output,
    changed,
    checkBlocks,
  };
}

function sanitizeSaveData(data) {
  if (typeof data !== "string" || data.length === 0) {
    return { data, changed: false, checkBlocks: 0, reason: "empty" };
  }

  try {
    const inflated = zlib.inflateSync(Buffer.from(data, "base64"));
    const xml = inflated.toString("latin1");
    const sanitized = sanitizeSaveXml(xml);
    if (!sanitized.changed) {
      return {
        data,
        changed: false,
        checkBlocks: sanitized.checkBlocks,
        reason: sanitized.checkBlocks > 0 ? "already-clean" : "no-check-block",
      };
    }

    return {
      data: zlib.deflateSync(Buffer.from(sanitized.xml, "latin1")).toString("base64"),
      changed: true,
      checkBlocks: sanitized.checkBlocks,
      reason: "sanitized",
    };
  } catch (error) {
    return {
      data,
      changed: false,
      checkBlocks: 0,
      reason: error.message,
    };
  }
}

module.exports = {
  sanitizeSaveData,
  sanitizeSaveXml,
};
