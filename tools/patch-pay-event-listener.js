const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const projectRoot = path.resolve(__dirname, "..");
const originalRoot = path.join(projectRoot, "original");
const modifiedRoot = path.join(projectRoot, "modified");

function listSwfFiles(rootDir) {
  const results = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listSwfFiles(entryPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".swf")) {
      results.push(entryPath);
    }
  }
  return results;
}

function createPatchTargets() {
  return listSwfFiles(originalRoot).map((inputPath) => {
    const relativePath = path.relative(originalRoot, inputPath);
    return {
      inputPath,
      outputPath: path.join(modifiedRoot, relativePath),
      relativePath,
    };
  });
}

class Reader {
  constructor(buffer, offset = 0) {
    this.buffer = buffer;
    this.offset = offset;
  }

  u8() {
    return this.buffer[this.offset++];
  }

  u16() {
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  u32() {
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u30() {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = this.u8();
      value |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) {
        return value >>> 0;
      }
    }
    return value >>> 0;
  }

  bytes(length) {
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  cstr() {
    const start = this.offset;
    while (this.offset < this.buffer.length && this.buffer[this.offset] !== 0) {
      this.offset += 1;
    }
    const value = this.buffer.subarray(start, this.offset).toString("utf8");
    this.offset += 1;
    return value;
  }
}

function decodeSwf(filePath) {
  const input = fs.readFileSync(filePath);
  const signature = input.subarray(0, 3).toString("ascii");
  const version = input[3];
  const declaredLength = input.readUInt32LE(4);

  if (signature === "FWS") {
    return {
      signature,
      version,
      declaredLength,
      body: Buffer.from(input.subarray(8)),
    };
  }

  if (signature === "CWS") {
    return {
      signature,
      version,
      declaredLength,
      body: zlib.inflateSync(input.subarray(8)),
    };
  }

  throw new Error(`Unsupported SWF signature: ${signature}`);
}

function encodeSwf({ version, declaredLength, body }) {
  const header = Buffer.alloc(8);
  header.write("CWS", 0, "ascii");
  header[3] = version;
  header.writeUInt32LE(declaredLength, 4);
  return Buffer.concat([header, zlib.deflateSync(body)]);
}

function skipMovieHeader(reader) {
  const firstRectByte = reader.buffer[reader.offset];
  const rectBits = firstRectByte >> 3;
  const rectBytes = Math.ceil((5 + rectBits * 4) / 8);
  reader.offset += rectBytes;
  reader.offset += 4;
}

function findDoAbcTags(body) {
  const reader = new Reader(body);
  skipMovieHeader(reader);

  const tags = [];
  while (reader.offset < body.length) {
    const tagStart = reader.offset;
    const tagHeader = reader.u16();
    const code = tagHeader >> 6;
    let length = tagHeader & 0x3f;
    if (length === 0x3f) {
      length = reader.u32();
    }

    const dataStart = reader.offset;
    const data = reader.bytes(length);
    if (code === 82) {
      const tagReader = new Reader(data);
      const flags = tagReader.u32();
      const name = tagReader.cstr();
      tags.push({
        tagStart,
        dataStart,
        flags,
        name,
        abcStart: dataStart + tagReader.offset,
        abc: data.subarray(tagReader.offset),
      });
    }

    if (code === 0) {
      break;
    }
  }

  return tags;
}

function qname(multiname) {
  return multiname?.qname || "";
}

function isPayEventQname(value) {
  return value === "unit4399.events::PayEvent" || value === "unit4399.events.PayEvent";
}

function parseAbc(buffer) {
  const reader = new Reader(buffer);
  reader.u16();
  reader.u16();

  let count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    reader.u30();
  }

  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    reader.u30();
  }

  count = reader.u30();
  reader.offset += Math.max(0, count - 1) * 8;

  const strings = [""];
  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    strings[i] = reader.bytes(reader.u30()).toString("utf8");
  }

  const namespaces = [null];
  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    const kind = reader.u8();
    const name = reader.u30();
    namespaces[i] = { kind, name, value: strings[name] };
  }

  const namespaceSets = [null];
  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    const setCount = reader.u30();
    const set = [];
    for (let j = 0; j < setCount; j += 1) {
      set.push(reader.u30());
    }
    namespaceSets[i] = set;
  }

  const multinames = [null];
  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    const kind = reader.u8();
    const item = { kind };

    if (kind === 0x07 || kind === 0x0d) {
      item.ns = reader.u30();
      item.name = reader.u30();
      item.qname = `${namespaces[item.ns]?.value || ""}::${strings[item.name] || ""}`;
    } else if (kind === 0x0f || kind === 0x10) {
      item.name = reader.u30();
      item.qname = `*::${strings[item.name] || ""}`;
    } else if (kind === 0x11 || kind === 0x12) {
      item.qname = "*::*";
    } else if (kind === 0x09 || kind === 0x0e) {
      item.name = reader.u30();
      item.nsset = reader.u30();
      const nsValues = (namespaceSets[item.nsset] || []).map((index) => namespaces[index]?.value);
      item.qname = `{${nsValues.join(",")}}::${strings[item.name] || ""}`;
    } else if (kind === 0x1b || kind === 0x1c) {
      item.nsset = reader.u30();
      const nsValues = (namespaceSets[item.nsset] || []).map((index) => namespaces[index]?.value);
      item.qname = `{${nsValues.join(",")}}::*`;
    } else if (kind === 0x1d) {
      item.qnameIndex = reader.u30();
      const paramCount = reader.u30();
      item.params = [];
      for (let j = 0; j < paramCount; j += 1) {
        item.params.push(reader.u30());
      }
      item.qname = `TypeName(${item.qnameIndex})`;
    } else {
      throw new Error(`Unsupported multiname kind ${kind} at index ${i}`);
    }

    multinames[i] = item;
  }

  const methodCount = reader.u30();
  const methods = [];
  for (let i = 0; i < methodCount; i += 1) {
    const paramCount = reader.u30();
    const returnType = reader.u30();
    const params = [];
    const paramOffsets = [];

    for (let j = 0; j < paramCount; j += 1) {
      paramOffsets.push(reader.offset);
      params.push(reader.u30());
    }

    const name = reader.u30();
    const flags = reader.u8();
    if ((flags & 0x08) !== 0) {
      const optionCount = reader.u30();
      for (let j = 0; j < optionCount; j += 1) {
        reader.u30();
        reader.u8();
      }
    }
    if ((flags & 0x80) !== 0) {
      for (let j = 0; j < paramCount; j += 1) {
        reader.u30();
      }
    }

    methods.push({
      index: i,
      returnType,
      params,
      paramOffsets,
      name: strings[name],
    });
  }

  skipMetadata(reader);

  const instances = [];
  const classCount = reader.u30();
  for (let i = 0; i < classCount; i += 1) {
    const name = reader.u30();
    reader.u30();
    const flags = reader.u8();
    if ((flags & 0x08) !== 0) {
      reader.u30();
    }
    const interfaceCount = reader.u30();
    for (let j = 0; j < interfaceCount; j += 1) {
      reader.u30();
    }

    const iinit = reader.u30();
    const traits = readTraits(reader);
    instances.push({ name, iinit, traits });
  }

  const classes = [];
  for (let i = 0; i < classCount; i += 1) {
    const cinit = reader.u30();
    const traits = readTraits(reader);
    classes.push({ cinit, traits });
  }

  const scriptCount = reader.u30();
  const scripts = [];
  for (let i = 0; i < scriptCount; i += 1) {
    const init = reader.u30();
    const traits = readTraits(reader);
    scripts.push({ init, traits });
  }

  const methodBodyCount = reader.u30();
  const methodBodies = [];
  for (let i = 0; i < methodBodyCount; i += 1) {
    const method = reader.u30();
    const maxStack = reader.u30();
    const localCount = reader.u30();
    const initScopeDepth = reader.u30();
    const maxScopeDepth = reader.u30();
    const codeLength = reader.u30();
    const codeStart = reader.offset;
    const code = reader.bytes(codeLength);
    const exceptionCount = reader.u30();
    for (let j = 0; j < exceptionCount; j += 1) {
      reader.u30();
      reader.u30();
      reader.u30();
      reader.u30();
      reader.u30();
    }
    readTraits(reader);
    methodBodies.push({
      index: i,
      method,
      maxStack,
      localCount,
      initScopeDepth,
      maxScopeDepth,
      codeStart,
      code,
    });
  }

  return {
    strings,
    namespaces,
    namespaceSets,
    multinames,
    methods,
    instances,
    classes,
    scripts,
    methodBodies,
  };
}

function skipMetadata(reader) {
  const metadataCount = reader.u30();
  for (let i = 0; i < metadataCount; i += 1) {
    reader.u30();
    const itemCount = reader.u30();
    for (let j = 0; j < itemCount; j += 1) {
      reader.u30();
      reader.u30();
    }
  }
}

function readTraits(reader) {
  const traits = [];
  const traitCount = reader.u30();
  for (let i = 0; i < traitCount; i += 1) {
    const name = reader.u30();
    const tag = reader.u8();
    const kind = tag & 0x0f;
    const attrs = tag >> 4;
    const trait = { name, kind };

    if (kind === 0 || kind === 6) {
      reader.u30();
      reader.u30();
      const valueIndex = reader.u30();
      if (valueIndex !== 0) {
        reader.u8();
      }
    } else if (kind === 1 || kind === 2 || kind === 3) {
      reader.u30();
      trait.method = reader.u30();
    } else if (kind === 4) {
      reader.u30();
      reader.u30();
    } else if (kind === 5) {
      reader.u30();
      trait.method = reader.u30();
    } else {
      throw new Error(`Unsupported trait kind ${kind}`);
    }

    if ((attrs & 0x04) !== 0) {
      const metadataCount = reader.u30();
      for (let j = 0; j < metadataCount; j += 1) {
        reader.u30();
      }
    }

    traits.push(trait);
  }
  return traits;
}

function readU30At(buffer, offset) {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = buffer[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, length: i + 1 };
    }
  }
  throw new Error(`Invalid U30 at bytecode offset ${offset}`);
}

function skipU30Operands(buffer, offset, count) {
  let cursor = offset;
  for (let i = 0; i < count; i += 1) {
    cursor += readU30At(buffer, cursor).length;
  }
  return cursor - offset;
}

function instructionLength(code, offset) {
  const op = code[offset];
  switch (op) {
    case 0x04:
    case 0x05:
    case 0x06:
    case 0x08:
    case 0x25:
    case 0x2c:
    case 0x2d:
    case 0x2e:
    case 0x2f:
    case 0x31:
    case 0x40:
    case 0x41:
    case 0x42:
    case 0x53:
    case 0x55:
    case 0x56:
    case 0x58:
    case 0x59:
    case 0x5a:
    case 0x5b:
    case 0x5d:
    case 0x5e:
    case 0x5f:
    case 0x60:
    case 0x61:
    case 0x62:
    case 0x63:
    case 0x66:
    case 0x68:
    case 0x6a:
    case 0x6c:
    case 0x6d:
    case 0x6e:
    case 0x6f:
    case 0x80:
    case 0x86:
    case 0x92:
    case 0x94:
    case 0xb2:
    case 0xc2:
    case 0xc3:
      return 1 + readU30At(code, offset + 1).length;

    case 0x24:
    case 0x65:
      return 2;

    case 0x0c:
    case 0x0d:
    case 0x0e:
    case 0x0f:
    case 0x10:
    case 0x11:
    case 0x12:
    case 0x13:
    case 0x14:
    case 0x15:
    case 0x16:
    case 0x17:
    case 0x18:
    case 0x19:
    case 0x1a:
      return 4;

    case 0x1b: {
      let cursor = offset + 4;
      const caseCount = readU30At(code, cursor);
      cursor += caseCount.length;
      return cursor - offset + 3 * (caseCount.value + 1);
    }

    case 0x32:
      return 1 + skipU30Operands(code, offset + 1, 2);

    case 0x43:
    case 0x44:
    case 0x45:
    case 0x46:
    case 0x4a:
    case 0x4c:
    case 0x4e:
    case 0x4f:
      return 1 + skipU30Operands(code, offset + 1, 2);

    case 0x49:
      return 1 + readU30At(code, offset + 1).length;

    case 0x85:
      return 1 + readU30At(code, offset + 1).length;

    case 0xef: {
      let cursor = offset + 1;
      cursor += 1;
      cursor += readU30At(code, cursor).length;
      cursor += 1;
      cursor += readU30At(code, cursor).length;
      return cursor - offset;
    }

    case 0xf0:
      return 5;

    case 0xf1:
      return 1;

    case 0xf2:
      return 3;

    default:
      return 1;
  }
}

function findPayEventCoercePatches(abc) {
  const payEventMultinames = new Set();
  for (let i = 1; i < abc.multinames.length; i += 1) {
    if (isPayEventQname(qname(abc.multinames[i]))) {
      payEventMultinames.add(i);
    }
  }

  if (payEventMultinames.size === 0) {
    return [];
  }

  const patches = [];
  for (const body of abc.methodBodies) {
    for (let cursor = 0; cursor < body.code.length - 1; cursor += 1) {
      const op = body.code[cursor];
      if (op !== 0x80 && op !== 0x86 && op !== 0xb2) {
        continue;
      }

      let operand;
      try {
        operand = readU30At(body.code, cursor + 1);
      } catch {
        continue;
      }
      if (!payEventMultinames.has(operand.value)) {
        continue;
      }

      const method = abc.methods[body.method];
      patches.push({
        methodIndex: body.method,
        methodName: method?.name || "(anonymous)",
        codeOffset: body.codeStart + cursor,
        length: 1 + operand.length,
        oldInstruction: op === 0x80
          ? "coerce unit4399.events::PayEvent"
          : op === 0x86
            ? "astype unit4399.events::PayEvent"
            : "istype unit4399.events::PayEvent",
        newInstruction: "coerce_a",
      });
    }
  }

  return patches;
}

function findPayEventParamPatches(abc) {
  const patches = [];
  for (const method of abc.methods) {
    for (let index = 0; index < method.params.length; index += 1) {
      if (!isPayEventQname(qname(abc.multinames[method.params[index]]))) {
        continue;
      }

      patches.push({
        methodIndex: method.index,
        methodName: method.name || "(anonymous)",
        paramIndex: index,
        paramOffset: method.paramOffsets[index],
        oldType: "unit4399.events::PayEvent",
        newType: "any",
      });
    }
  }

  return patches;
}

function sameLengthReplacementPatch(body, oldText, newText) {
  const oldBytes = Buffer.from(oldText, "utf8");
  const newBytes = Buffer.from(newText, "utf8");
  if (oldBytes.length !== newBytes.length) {
    throw new Error(`Replacement for ${oldText} must keep the same byte length`);
  }

  const patches = [];
  let offset = -1;
  while ((offset = body.indexOf(oldBytes, offset + 1)) !== -1) {
    patches.push({
      patchKind: "string-replace",
      offset,
      length: oldBytes.length,
      oldText,
      newText,
    });
  }

  return patches;
}

function findControlPaymentEventNamePatches(body, relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").toLowerCase();
  if (!normalized.endsWith("external/cdn.comment.4399pk.com/control/ctrl_mo_v5.swf")) {
    return [];
  }

  const patches = [
    ...sameLengthReplacementPatch(body, "usePayApi", "offPayApi"),
    ...sameLengthReplacementPatch(body, "rechargedMoney", "offlineNoMoney"),
  ];

  const missing = ["usePayApi", "rechargedMoney"].filter((text) => (
    !patches.some((patch) => patch.oldText === text)
  ));
  if (missing.length > 0) {
    throw new Error(`Missing control payment event string(s): ${missing.join(", ")}`);
  }

  return patches;
}

function patchSwf({ inputPath, outputPath, relativePath, expectedPatchCount }) {
  const swf = decodeSwf(inputPath);
  const tags = findDoAbcTags(swf.body);
  const patches = [];

  patches.push(...findControlPaymentEventNamePatches(swf.body, relativePath));

  for (const tag of tags) {
    const abc = parseAbc(tag.abc);
    for (const patch of findPayEventParamPatches(abc)) {
      patches.push({
        ...patch,
        patchKind: "method-param",
        tagName: tag.name,
        offset: tag.abcStart + patch.paramOffset,
      });
    }

    for (const patch of findPayEventCoercePatches(abc)) {
      patches.push({
        ...patch,
        patchKind: "bytecode-coerce",
        tagName: tag.name,
        offset: tag.abcStart + patch.codeOffset,
      });
    }
  }

  if (expectedPatchCount != null && patches.length !== expectedPatchCount) {
    throw new Error(
      `Expected ${expectedPatchCount} PayEvent listener patch target(s) in ${inputPath}, found ${patches.length}`
    );
  }

  if (patches.length === 0) {
    return {
      input: inputPath,
      output: outputPath,
      skipped: true,
      patches,
    };
  }

  for (const patch of patches) {
    if (patch.patchKind === "method-param" && swf.body[patch.offset] === 0x00) {
      continue;
    }

    if (patch.patchKind === "string-replace") {
      const oldBytes = Buffer.from(patch.oldText, "utf8");
      const newBytes = Buffer.from(patch.newText, "utf8");
      if (!swf.body.subarray(patch.offset, patch.offset + patch.length).equals(oldBytes)) {
        throw new Error(`Expected ${patch.oldText} at ${patch.offset}`);
      }
      newBytes.copy(swf.body, patch.offset);
      continue;
    }

    if (patch.patchKind === "method-param") {
      // Current targets use one-byte U30 indices: 15 in the game SWF, 86 in
      // ctrl_mo_v5.swf. If this ever changes, fail instead of corrupting ABC.
      if ((swf.body[patch.offset] & 0x80) !== 0) {
        throw new Error(`PayEvent type index at ${patch.offset} is not a one-byte U30`);
      }

      // ABC method param type 0 means "any". This avoids Ruffle's cross-SWF
      // ApplicationDomain mismatch while preserving the handler body.
      swf.body[patch.offset] = 0x00;
      continue;
    }

    if (patch.patchKind === "bytecode-coerce") {
      if (swf.body[patch.offset] !== 0x80 && swf.body[patch.offset] !== 0x86) {
        throw new Error(`Expected coerce/astype opcode at ${patch.offset}`);
      }

      // Keep bytecode offsets stable. These runtime checks become `coerce_a`;
      // the original U30 operand bytes become nop.
      swf.body[patch.offset] = 0x82;
      for (let i = 1; i < patch.length; i += 1) {
        swf.body[patch.offset + i] = 0x02;
      }
      continue;
    }

    throw new Error(`Unknown patch kind: ${patch.patchKind}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, encodeSwf(swf));

  return {
    input: inputPath,
    output: outputPath,
    patches,
    outputSize: fs.statSync(outputPath).size,
  };
}

function main() {
  let patchedCount = 0;
  for (const target of createPatchTargets()) {
    const result = patchSwf(target);
    if (result.skipped) {
      continue;
    }

    patchedCount += 1;
    console.log(result);
  }

  if (patchedCount === 0) {
    console.log("No PayEvent listener parameter patches found.");
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  decodeSwf,
  encodeSwf,
  findDoAbcTags,
  parseAbc,
  qname,
  isPayEventQname,
  findPayEventParamPatches,
  findPayEventCoercePatches,
};
