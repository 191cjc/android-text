const fs = require("fs");
const path = require("path");
const {
  decodeSwf,
  encodeSwf,
  findDoAbcTags,
  parseAbc,
  qname,
} = require("./patch-pay-event-listener");
const {
  buildMethodNames,
  decodeInstruction,
  operandDescription,
} = require("./inspect-abc-references");

const projectRoot = path.resolve(__dirname, "..");
const inputPath = path.join(projectRoot, "modified", "L4399Main_gamefile.swf");
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-runtime-mock-dark-pet-patch.swf");

const encodedSlotFactor = 11000;
const fixedPetSlot = 1;
const callbackFunctionName = "dataIndexYouData";
const enablePetMockPatch = process.env.CODEX_DISABLE_PET_MOCK_PATCH !== "1";
const enableSaveGuardPatch = process.env.CODEX_DISABLE_SAVE_GUARD_PATCH !== "1";
const enableCurrencyMockPatch = process.env.CODEX_DISABLE_CURRENCY_MOCK_PATCH !== "1";
const petMockPatchMode = process.env.CODEX_PET_MOCK_PATCH_MODE || "fixed-slot";
const enableBagGiftPatch = process.env.CODEX_ENABLE_BAG_GIFT_MOCK === "1" || process.env.CODEX_ENABLE_BAG_MOCK === "1";
const enableBagSaveAfterCountPatch = process.env.CODEX_ENABLE_BAG_SAVE_AFTER_COUNT_MOCK === "1";
const enableBagDisplayPatch = process.env.CODEX_ENABLE_BAG_DISPLAY_MOCK === "1";
const enablePlayerBagPanelPatch = process.env.CODEX_ENABLE_PLAYER_BAG_PANEL_MOCK === "1";
const enableBagReadPatch = process.env.CODEX_ENABLE_BAG_READ_MOCK === "1";
// The gameStart bag injection can run before the bag subsystem is ready and
// has caused the game to hang on entry. Keep the code dormant unless we
// explicitly opt into re-testing this experimental hook.
const enableBagGameStartPatch = process.env.CODEX_ENABLE_GAMESTART_BAG_MOCK === "1";
const maxBagMockItems = 12;
const bagSnapshotPayloadBase = 100000;
const bagSnapshotPayloadStride = 1000;
const bagItemIdCallbackKind = "goodsId";
const bagItemCountCallbackKind = "goodsNum";
const currencyCallbackKind = "goldCurr";
const petSlotCallbackKind = "slot";
const petStageCallbackKind = "curLWJieDuan";
const petSkillBidCallbackKind = "bid";
const petSkillClvCallbackKind = "clv";
const petSkillCexpCallbackKind = "cexp";

const saveAfterCountMethod = "hotpointgame.pet::PetManager::::saveAfterCount";
const gameStartMethod = "hotpointgame.Control::GM::static::::gameStart";
const addPetBypidMethod = "hotpointgame.pet::PetManager::::addPetBypid";
const saveDataStartMethod = "hotpointgame.gameobj::Api4399::::saveDataStart";
const saveProcessMethod = "hotpointgame.gameobj::Api4399::::saveProcess";
const petRReadDataMethod = "hotpointgame.pet::PetR::static::::readData";
const addPetSkillBypidMethod = "hotpointgame.pet::PetManager::::addPetSkillBypid";
const petSkillReadDataMethod = "hotpointgame.pet::PetSkillShowSaveD::static::::readData";
const petRPetlWSkillByGodMethod = "hotpointgame.pet::PetR::::petlWSkillByGod";
const bagFactoryReadMethod = "hotpointgame.models.bag::BagFactory::static::::read";
const bagFactorySjChFunMethod = "hotpointgame.models.bag::BagFactory::static::::sjChFun";
const bagFactoryBcLbMethod = "hotpointgame.models.bag::BagFactory::static::::bcLb";
const bagFactoryOnlyBagOneMethod = "hotpointgame.models.bag::BagFactory::static::::onlyBagOne";
const playerBagPanelInitPanelMethod = "hotpointgame.views.playerPanel::PlayerBagPanel::::initPanel";
const bagDisplayInitGoodsDisplayMethod = "hotpointgame.views.playerPanel::BagDisplay::::initGoodsDisplay";
const currencyGetterMethods = [
  "hotpointgame.Control::FlowInterface::static::::getGodByRole",
  "hotpointgame.grole::CPlayer::::getGodByRole",
  "hotpointgame.grole::CplayerWomGun::::getGodByRole",
  "hotpointgame.grole::CplayerManGun::::getGodByRole",
  "hotpointgame.models.bag::WareroomSlot::::getGoldCurr",
];

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

  u30() {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = this.u8();
      value |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) {
        return value >>> 0;
      }
    }
    throw new Error(`Invalid U30 at ABC offset ${this.offset - 5}`);
  }

  bytes(length) {
    this.offset += length;
  }
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
  throw new Error(`Invalid U30 at byte offset ${offset}`);
}

function encodeU30(value) {
  const bytes = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (current !== 0);
  return Buffer.from(bytes);
}

function instruction(op, ...operands) {
  return Buffer.concat([
    Buffer.from([op]),
    ...operands.map((operand) => encodeU30(operand)),
  ]);
}

function branchInstruction(op, offset) {
  const encoded = Buffer.alloc(4);
  encoded[0] = op;
  encoded.writeIntLE(offset, 1, 3);
  return encoded;
}

function label(name) {
  return { kind: "label", name };
}

function branch(op, target) {
  return { kind: "branch", op, target };
}

function assemble(parts) {
  const labels = new Map();
  let offset = 0;

  for (const part of parts) {
    if (Buffer.isBuffer(part)) {
      offset += part.length;
    } else if (part?.kind === "label") {
      labels.set(part.name, offset);
    } else if (part?.kind === "branch") {
      offset += 4;
    } else {
      throw new Error(`Unsupported assembly part: ${part}`);
    }
  }

  const output = [];
  offset = 0;
  for (const part of parts) {
    if (Buffer.isBuffer(part)) {
      output.push(part);
      offset += part.length;
    } else if (part?.kind === "branch") {
      if (!labels.has(part.target)) {
        throw new Error(`Missing branch label: ${part.target}`);
      }
      const targetOffset = labels.get(part.target);
      output.push(branchInstruction(part.op, targetOffset - (offset + 4)));
      offset += 4;
    }
  }

  return Buffer.concat(output);
}

function pushIntLiteral(value) {
  if (value >= -128 && value <= 127) {
    return Buffer.from([0x24, value & 0xff]); // pushbyte
  }
  return instruction(0x25, value); // pushshort
}

function getLocal(index) {
  if (index >= 0 && index <= 3) {
    return Buffer.from([0xd0 + index]);
  }
  return instruction(0x62, index);
}

function setLocal(index) {
  if (index >= 0 && index <= 3) {
    return Buffer.from([0xd4 + index]);
  }
  return instruction(0x63, index);
}

function incLocalI(index) {
  return instruction(0xc2, index);
}

function encodeTag(code, payload) {
  if (payload.length < 0x3f) {
    const header = Buffer.alloc(2);
    header.writeUInt16LE((code << 6) | payload.length, 0);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE((code << 6) | 0x3f, 0);
  header.writeUInt32LE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function rewriteDoAbcTag(swf, tag, abcBuffer) {
  const dataPrefix = swf.body.subarray(tag.dataStart, tag.abcStart);
  const payload = Buffer.concat([dataPrefix, abcBuffer]);
  const encoded = encodeTag(82, payload);

  let oldHeaderLength = tag.dataStart - tag.tagStart;
  const tagHeader = swf.body.readUInt16LE(tag.tagStart);
  if ((tagHeader & 0x3f) === 0x3f) {
    oldHeaderLength = 6;
  }
  const oldLength = oldHeaderLength + (tag.abcStart - tag.dataStart) + tag.abc.length;

  swf.body = Buffer.concat([
    swf.body.subarray(0, tag.tagStart),
    encoded,
    swf.body.subarray(tag.tagStart + oldLength),
  ]);
}

function skipTraits(reader) {
  const traitCount = reader.u30();
  for (let i = 0; i < traitCount; i += 1) {
    reader.u30();
    const tag = reader.u8();
    const kind = tag & 0x0f;
    const attrs = tag >> 4;

    if (kind === 0 || kind === 6) {
      reader.u30();
      reader.u30();
      const valueIndex = reader.u30();
      if (valueIndex !== 0) {
        reader.u8();
      }
    } else if (kind === 1 || kind === 2 || kind === 3) {
      reader.u30();
      reader.u30();
    } else if (kind === 4) {
      reader.u30();
      reader.u30();
    } else if (kind === 5) {
      reader.u30();
      reader.u30();
    } else {
      throw new Error(`Unsupported trait kind ${kind}`);
    }

    if ((attrs & 0x04) !== 0) {
      const metadataCount = reader.u30();
      for (let j = 0; j < metadataCount; j += 1) {
        reader.u30();
      }
    }
  }
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

function methodBodyHeaders(abcBuffer) {
  const reader = new Reader(abcBuffer);
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

  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    reader.bytes(reader.u30());
  }

  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    reader.u8();
    reader.u30();
  }

  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    const setCount = reader.u30();
    for (let j = 0; j < setCount; j += 1) {
      reader.u30();
    }
  }

  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    const kind = reader.u8();
    if (kind === 0x07 || kind === 0x0d) {
      reader.u30();
      reader.u30();
    } else if (kind === 0x0f || kind === 0x10) {
      reader.u30();
    } else if (kind === 0x11 || kind === 0x12) {
      // Marker-only multiname.
    } else if (kind === 0x09 || kind === 0x0e) {
      reader.u30();
      reader.u30();
    } else if (kind === 0x1b || kind === 0x1c) {
      reader.u30();
    } else if (kind === 0x1d) {
      reader.u30();
      const paramCount = reader.u30();
      for (let j = 0; j < paramCount; j += 1) {
        reader.u30();
      }
    } else {
      throw new Error(`Unsupported multiname kind ${kind}`);
    }
  }

  const methodCount = reader.u30();
  for (let i = 0; i < methodCount; i += 1) {
    const paramCount = reader.u30();
    reader.u30();
    for (let j = 0; j < paramCount; j += 1) {
      reader.u30();
    }
    reader.u30();
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
  }

  skipMetadata(reader);

  const classCount = reader.u30();
  for (let i = 0; i < classCount; i += 1) {
    reader.u30();
    reader.u30();
    const flags = reader.u8();
    if ((flags & 0x08) !== 0) {
      reader.u30();
    }
    const interfaceCount = reader.u30();
    for (let j = 0; j < interfaceCount; j += 1) {
      reader.u30();
    }
    reader.u30();
    skipTraits(reader);
  }

  for (let i = 0; i < classCount; i += 1) {
    reader.u30();
    skipTraits(reader);
  }

  const scriptCount = reader.u30();
  for (let i = 0; i < scriptCount; i += 1) {
    reader.u30();
    skipTraits(reader);
  }

  const bodyCount = reader.u30();
  const headers = [];
  for (let i = 0; i < bodyCount; i += 1) {
    const methodOffset = reader.offset;
    const method = reader.u30();
    const maxStackOffset = reader.offset;
    const maxStack = reader.u30();
    const localCountOffset = reader.offset;
    const localCount = reader.u30();
    const initScopeDepthOffset = reader.offset;
    const initScopeDepth = reader.u30();
    const maxScopeDepthOffset = reader.offset;
    const maxScopeDepth = reader.u30();
    const codeLengthOffset = reader.offset;
    const codeLength = reader.u30();
    const codeStart = reader.offset;
    reader.bytes(codeLength);

    const exceptionCount = reader.u30();
    for (let j = 0; j < exceptionCount; j += 1) {
      reader.u30();
      reader.u30();
      reader.u30();
      reader.u30();
      reader.u30();
    }
    skipTraits(reader);

    headers.push({
      index: i,
      method,
      methodOffset,
      maxStack,
      maxStackOffset,
      localCount,
      localCountOffset,
      initScopeDepth,
      initScopeDepthOffset,
      maxScopeDepth,
      maxScopeDepthOffset,
      codeLength,
      codeLengthOffset,
      codeStart,
    });
  }

  return headers;
}

function methodBodyFor(abc, ownerName) {
  const names = buildMethodNames(abc);
  for (const body of abc.methodBodies) {
    const owners = names.get(body.method) || [];
    if (owners.includes(ownerName)) {
      return body;
    }
  }
  return null;
}

function instructionsFor(body) {
  const instructions = [];
  let cursor = 0;
  while (cursor < body.code.length) {
    const decoded = decodeInstruction(body.code, cursor);
    instructions.push(decoded);
    cursor += Math.max(1, decoded.length);
  }
  return instructions;
}

function operandFor(abc, body, opName, qnameSuffix) {
  for (const decoded of instructionsFor(body)) {
    if (decoded.name !== opName || decoded.operands.length === 0) {
      continue;
    }
    const name = qname(abc.multinames[decoded.operands[0]]) || "";
    if (name.endsWith(qnameSuffix)) {
      return decoded.operands[0];
    }
  }
  throw new Error(`Missing ${opName} ${qnameSuffix}`);
}

function instructionAfter(abc, body, opName, qnameSuffix) {
  for (const decoded of instructionsFor(body)) {
    if (decoded.name !== opName || decoded.operands.length === 0) {
      continue;
    }
    const name = qname(abc.multinames[decoded.operands[0]]) || "";
    if (name.endsWith(qnameSuffix)) {
      return decoded.offset + decoded.length;
    }
  }
  throw new Error(`Missing ${opName} ${qnameSuffix}`);
}

function stringIndexFor(abc, ...values) {
  for (const value of values) {
    const index = abc.strings.findIndex((item) => item === value);
    if (index >= 0) {
      return index;
    }
  }
  throw new Error(`Missing string constant: ${values.join(" or ")}`);
}

function disassembleBody(abc, body) {
  return instructionsFor(body).map((decoded) => {
    const detail = operandDescription(abc, decoded);
    return `${decoded.offset}: ${decoded.name}${detail ? ` ${detail}` : ""}`;
  });
}

function bodyHasCallback(abc, body, kind) {
  const callbackIndex = abc.strings.findIndex((item) => item === callbackFunctionName);
  const kindIndex = kind ? abc.strings.findIndex((item) => item === kind) : -1;
  if (callbackIndex < 0) {
    return false;
  }

  const callbackSeen = instructionsFor(body).some((decoded) =>
    decoded.name === "pushstring" && decoded.operands[0] === callbackIndex
  );
  if (!callbackSeen || kindIndex < 0) {
    return callbackSeen;
  }

  return instructionsFor(body).some((decoded) =>
    decoded.name === "pushstring" && decoded.operands[0] === kindIndex
  );
}

function insertMethodCode(abcBuffer, headers, body, insertOffset, insertCode, label, options = {}) {
  const header = headers[body.index];
  if (insertOffset < 0 || insertOffset > header.codeLength) {
    throw new Error(`${label} insert offset ${insertOffset} is outside code length ${header.codeLength}`);
  }

  const oldCodeLengthInfo = readU30At(abcBuffer, header.codeLengthOffset);
  const codeBefore = abcBuffer.subarray(header.codeStart, header.codeStart + insertOffset);
  const codeAfter = abcBuffer.subarray(header.codeStart + insertOffset, header.codeStart + header.codeLength);
  const code = Buffer.concat([codeBefore, insertCode, codeAfter]);
  const encodedLength = encodeU30(code.length);
  const exceptionsOffset = header.codeStart + header.codeLength;
  const before = abcBuffer.subarray(0, header.codeLengthOffset);
  const after = abcBuffer.subarray(exceptionsOffset);
  const nextAbc = Buffer.concat([before, encodedLength, code, after]);
  const patches = {
    codeLength: { oldValue: header.codeLength, newValue: code.length },
  };

  const maxStack = options.maxStack ?? header.maxStack;
  if (maxStack !== header.maxStack) {
    patches.maxStackPatch = writeU30SameLength(nextAbc, header.maxStackOffset, maxStack, `${label} maxStack`);
  } else {
    patches.maxStackPatch = { oldValue: header.maxStack, newValue: header.maxStack };
  }

  const localCount = options.localCount ?? header.localCount;
  if (localCount !== header.localCount) {
    patches.localCountPatch = writeU30SameLength(nextAbc, header.localCountOffset, localCount, `${label} localCount`);
  } else {
    patches.localCountPatch = { oldValue: header.localCount, newValue: header.localCount };
  }

  if (oldCodeLengthInfo.length !== encodedLength.length) {
    patches.codeLengthU30Bytes = { oldValue: oldCodeLengthInfo.length, newValue: encodedLength.length };
  }

  return { abcBuffer: nextAbc, patches };
}

function replaceMethodCode(abcBuffer, headers, body, code, label, options = {}) {
  const header = headers[body.index];
  const oldCodeLength = header.codeLength;
  const oldCodeLengthInfo = readU30At(abcBuffer, header.codeLengthOffset);
  const encodedLength = encodeU30(code.length);
  const exceptionsOffset = header.codeStart + oldCodeLength;
  const before = abcBuffer.subarray(0, header.codeLengthOffset);
  const after = abcBuffer.subarray(exceptionsOffset);
  const nextAbc = Buffer.concat([before, encodedLength, code, after]);
  const patches = {
    codeLength: { oldValue: oldCodeLength, newValue: code.length },
  };

  const maxStack = options.maxStack ?? header.maxStack;
  if (maxStack !== header.maxStack) {
    patches.maxStackPatch = writeU30SameLength(nextAbc, header.maxStackOffset, maxStack, `${label} maxStack`);
  } else {
    patches.maxStackPatch = { oldValue: header.maxStack, newValue: header.maxStack };
  }

  const localCount = options.localCount ?? header.localCount;
  if (localCount !== header.localCount) {
    patches.localCountPatch = writeU30SameLength(nextAbc, header.localCountOffset, localCount, `${label} localCount`);
  } else {
    patches.localCountPatch = { oldValue: header.localCount, newValue: header.localCount };
  }

  if (oldCodeLengthInfo.length !== encodedLength.length) {
    patches.codeLengthU30Bytes = { oldValue: oldCodeLengthInfo.length, newValue: encodedLength.length };
  }

  return { abcBuffer: nextAbc, patches };
}

function paddedCode(code, targetLength, label) {
  if (code.length > targetLength) {
    throw new Error(`${label} code ${code.length} exceeds target length ${targetLength}`);
  }
  return Buffer.concat([code, Buffer.alloc(targetLength - code.length, 0x02)]);
}

function patchSaveDataStartAntiCheatBypass(abc, body, abcBuffer) {
  const firstInsn = decodeInstruction(body.code, 6);
  const secondInsn = decodeInstruction(body.code, 10);
  const branchInsn = decodeInstruction(body.code, 15);

  if (
    firstInsn.name === "pushfalse" &&
    body.code.subarray(7, 15).every((value) => value === 0x02) &&
    branchInsn.name === "iffalse"
  ) {
    return { alreadyPatched: true };
  }

  if (firstInsn.name !== "getlex" || secondInsn.name !== "callproperty" || branchInsn.name !== "iffalse") {
    throw new Error(`${saveDataStartMethod} does not match expected isXg guard layout`);
  }

  const firstTarget = qname(abc.multinames[firstInsn.operands[0]]) || "";
  const secondTarget = qname(abc.multinames[secondInsn.operands[0]]) || "";
  if (!firstTarget.endsWith("::FlowInterface") || !secondTarget.endsWith("::isXg")) {
    throw new Error(`${saveDataStartMethod} guard targets changed: ${firstTarget}, ${secondTarget}`);
  }

  const before = disassembleBody(abc, body).slice(0, 12);
  Buffer.concat([Buffer.from([0x27]), Buffer.alloc(8, 0x02)]).copy(abcBuffer, body.codeStart + 6);
  return { alreadyPatched: false, before };
}

function buildDarkPetSaveAfterCountCode(
  abc,
  saveAfterCountBody,
  addPetBypidBody,
  saveProcessBody,
  petRReadDataBody,
  petRPetlWSkillByGodBody,
  bagSjChFunBody
) {
  const gs = operandFor(abc, saveAfterCountBody, "getlex", "::GS");
  const a1 = operandFor(abc, saveAfterCountBody, "getproperty", "::a1");
  const opennum = operandFor(abc, saveAfterCountBody, "getproperty", "::opennum");
  const petRConstruct = operandFor(abc, addPetBypidBody, "findpropstrict", "::PetR");
  const initBid = operandFor(abc, addPetBypidBody, "callpropvoid", "::initBid");
  const petArr = operandFor(abc, addPetBypidBody, "getproperty", "::petArr");
  const eggArr = operandFor(abc, addPetBypidBody, "getproperty", "::eggArr");
  const wildcard = operandFor(abc, addPetBypidBody, "setproperty", "::*");
  const externalInterface = operandFor(abc, saveProcessBody, "getlex", "::ExternalInterface");
  const externalCall = operandFor(abc, saveProcessBody, "callproperty", "::call");
  const callbackString = stringIndexFor(abc, callbackFunctionName);
  const lv = operandFor(abc, petRReadDataBody, "setproperty", "::lv");
  const tolv = operandFor(abc, petRReadDataBody, "setproperty", "::tolv");
  const petSlotString = stringIndexFor(abc, petSlotCallbackKind);
  const originalSaveAfterCode = Buffer.from(saveAfterCountBody.code);

  const callbackCall = (kindString, slotCode) => {
    const args = [
      instruction(0x60, externalInterface), // getlex ExternalInterface
      instruction(0x2c, callbackString), // pushstring callback
    ];
    if (kindString != null) {
      args.push(instruction(0x2c, kindString));
    }
    if (slotCode != null) {
      args.push(pushIntLiteral(slotCode));
    }
    args.push(instruction(0x46, externalCall, 1 + (kindString == null ? 0 : 1) + (slotCode == null ? 0 : 1)));
    return Buffer.concat(args);
  };

  const code = assemble([
    Buffer.from([0xd0, 0x30]), // getlocal0, pushscope
    callbackCall(null, null),
    Buffer.from([0x73, 0xd6, 0xd2]), // convert_i, setlocal2, getlocal2
    branch(0x11, "hasMockPet"), // iftrue
    branch(0x10, "runOriginalSaveAfterCount"), // jump
    label("hasMockPet"),
    instruction(0x5d, petRConstruct), // findpropstrict PetR
    instruction(0x4a, petRConstruct, 0), // constructprop PetR, 0
    Buffer.from([0xd5]), // setlocal1
    Buffer.from([0xd1, 0xd2]), // getlocal1, getlocal2
    instruction(0x25, encodedSlotFactor), // pushshort 11000
    Buffer.from([0xa3, 0x73]), // divide, convert_i
    instruction(0x4f, initBid, 1), // callpropvoid initBid, 1
    Buffer.from([0xd1, 0xd2]), // getlocal1, getlocal2
    instruction(0x25, encodedSlotFactor), // pushshort 11000
    Buffer.from([0xa4, 0x24, 100, 0xa3, 0x73]), // modulo, pushbyte 100, divide, convert_i
    instruction(0x61, lv), // setproperty lv
    Buffer.from([0xd1, 0xd2, 0x24, 100, 0xa4, 0x73]), // getlocal1, getlocal2, pushbyte 100, modulo, convert_i
    instruction(0x61, tolv), // setproperty tolv
    callbackCall(petSlotString, null),
    Buffer.from([0x73]), // convert_i
    setLocal(4),
    getLocal(4),
    pushIntLiteral(0),
    branch(0x17, "hasPetSlot"), // ifgt
    instruction(0x60, gs), // getlex GS
    instruction(0x66, a1), // getproperty a1
    Buffer.from([0x73]), // convert_i
    setLocal(4),
    branch(0x10, "checkPetSlotLoop"),
    label("petSlotLoop"),
    Buffer.from([0xd0]), // getlocal0
    instruction(0x66, petArr), // getproperty petArr
    getLocal(4),
    instruction(0x66, wildcard), // getproperty *
    Buffer.from([0x20, 0xab, 0x2a]), // pushnull, equals, dup
    branch(0x12, "petSlotSecondFalse"), // iffalse
    Buffer.from([0x29, 0xd0]), // pop, getlocal0
    instruction(0x66, eggArr), // getproperty eggArr
    getLocal(4),
    instruction(0x66, wildcard), // getproperty *
    Buffer.from([0x20, 0xab]), // pushnull, equals
    label("petSlotSecondFalse"),
    branch(0x12, "nextPetSlot"), // iffalse
    branch(0x10, "hasPetSlot"), // jump
    label("nextPetSlot"),
    incLocalI(4),
    label("checkPetSlotLoop"),
    getLocal(4),
    Buffer.from([0xd0]), // getlocal0
    instruction(0x66, opennum), // getproperty opennum
    branch(0x16, "petSlotLoop"), // ifle
    branch(0x10, "runOriginalSaveAfterCount"), // no free slot
    label("hasPetSlot"),
    Buffer.from([0xd0]), // getlocal0
    instruction(0x66, petArr), // getproperty petArr
    getLocal(4),
    Buffer.from([0xd1]), // getlocal1
    instruction(0x61, wildcard), // setproperty *
    label("runOriginalSaveAfterCount"),
    originalSaveAfterCode.subarray(2),
  ]);

  return {
    code,
    operands: {
      petRConstruct,
      initBid,
      petArr,
      wildcard,
      externalInterface,
      externalCall,
      callbackString,
      petSlotString,
      lv,
      tolv,
    },
  };
}

function buildFixedSlotPetSaveAfterCountCode(
  abc,
  addPetBypidBody,
  saveProcessBody,
  petRReadDataBody,
  bagSjChFunBody
) {
  const petRConstruct = operandFor(abc, addPetBypidBody, "findpropstrict", "::PetR");
  const initBid = operandFor(abc, addPetBypidBody, "callpropvoid", "::initBid");
  const petArr = operandFor(abc, addPetBypidBody, "getproperty", "::petArr");
  const wildcard = operandFor(abc, addPetBypidBody, "setproperty", "::*");
  const externalInterface = operandFor(abc, saveProcessBody, "getlex", "::ExternalInterface");
  const externalCall = operandFor(abc, saveProcessBody, "callproperty", "::call");
  const callbackString = stringIndexFor(abc, callbackFunctionName);
  const lv = operandFor(abc, petRReadDataBody, "setproperty", "::lv");
  const tolv = operandFor(abc, petRReadDataBody, "setproperty", "::tolv");
  const goodsIdString = bagSjChFunBody ? stringIndexFor(abc, bagItemIdCallbackKind) : null;
  const bagBuilt = bagSjChFunBody
    ? buildBagInsertCode(abc, saveProcessBody, bagSjChFunBody, { done: true })
    : null;

  const earlyExitCode = bagBuilt
    ? [
      instruction(0x60, externalInterface), // getlex ExternalInterface
      instruction(0x2c, callbackString), // pushstring callback
      instruction(0x2c, goodsIdString),
      pushIntLiteral(0),
      instruction(0x46, externalCall, 3), // callproperty call, 3
      Buffer.from([0x73]), // convert_i
      setLocal(3),
      getLocal(2),
      branch(0x11, "hasMockWork"), // iftrue
      getLocal(3),
      branch(0x11, "hasMockWork"), // iftrue
      Buffer.from([0x47]), // returnvoid
      label("hasMockWork"),
    ]
    : [
      getLocal(2),
      branch(0x11, "hasMockPet"), // iftrue
      Buffer.from([0x47]), // returnvoid
    ];

  const petWriteCode = [
    getLocal(2),
    branch(0x12, "skipPetMock"), // iffalse
    label("hasMockPet"),
    instruction(0x5d, petRConstruct), // findpropstrict PetR
    instruction(0x4a, petRConstruct, 0), // constructprop PetR, 0
    Buffer.from([0xd5]), // setlocal1
    Buffer.from([0xd1, 0xd2]), // getlocal1, getlocal2
    instruction(0x25, encodedSlotFactor), // pushshort 11000
    Buffer.from([0xa3, 0x73]), // divide, convert_i
    instruction(0x4f, initBid, 1), // callpropvoid initBid, 1
    Buffer.from([0xd1, 0xd2]), // getlocal1, getlocal2
    instruction(0x25, encodedSlotFactor), // pushshort 11000
    Buffer.from([0xa4, 0x24, 100, 0xa3, 0x73]), // modulo, pushbyte 100, divide, convert_i
    instruction(0x61, lv), // setproperty lv
    Buffer.from([0xd1, 0xd2, 0x24, 100, 0xa4, 0x73]), // getlocal1, getlocal2, pushbyte 100, modulo, convert_i
    instruction(0x61, tolv), // setproperty tolv
    Buffer.from([0xd0]), // getlocal0
    instruction(0x66, petArr), // getproperty petArr
    Buffer.from([0x24, fixedPetSlot, 0xd1]), // pushbyte fixed slot, getlocal1
    instruction(0x61, wildcard), // setproperty *
    label("skipPetMock"),
  ];

  const code = assemble([
    Buffer.from([0xd0, 0x30]), // getlocal0, pushscope
    instruction(0x60, externalInterface), // getlex ExternalInterface
    instruction(0x2c, callbackString), // pushstring callback
    instruction(0x46, externalCall, 1), // callproperty call, 1
    Buffer.from([0x73, 0xd6, 0xd2]), // convert_i, setlocal2, getlocal2
    ...earlyExitCode,
    ...petWriteCode,
    ...(bagBuilt ? [bagBuilt.code] : []),
    Buffer.from([0x47]), // returnvoid
  ]);

  return {
    code,
    operands: {
      petRConstruct,
      initBid,
      petArr,
      wildcard,
      externalInterface,
      externalCall,
      callbackString,
      lv,
      tolv,
      ...(bagBuilt ? { bag: bagBuilt.operands } : {}),
    },
  };
}

function buildBagInsertCode(abc, saveProcessBody, bagSjChFunBody, options = {}) {
  const externalInterface = operandFor(abc, saveProcessBody, "getlex", "::ExternalInterface");
  const externalCall = operandFor(abc, saveProcessBody, "callproperty", "::call");
  const callbackString = stringIndexFor(abc, callbackFunctionName);
  const goodsIdString = stringIndexFor(abc, bagItemIdCallbackKind);
  const goodsNumString = stringIndexFor(abc, bagItemCountCallbackKind);
  const addInBagById = operandFor(abc, bagSjChFunBody, "callpropvoid", "::addInBagById");
  const isFullById = operandFor(abc, bagSjChFunBody, "callproperty", "::isFullById");

  const callbackCall = (kindString, slotCode) => {
    const args = [
      instruction(0x60, externalInterface), // getlex ExternalInterface
      instruction(0x2c, callbackString), // pushstring callback
      instruction(0x2c, kindString),
      pushIntLiteral(slotCode),
    ];
    args.push(instruction(0x46, externalCall, 3));
    return Buffer.concat(args);
  };

  const snapshotCode = [];
  if (options.snapshot) {
    const { bagReadBody, bagOnlyBagOneBody } = options.snapshot;
    const getAirGirdNum = operandFor(abc, bagOnlyBagOneBody, "callproperty", "::getAirGirdNum");
    const bagOperands = [
      operandFor(abc, bagReadBody, "getlex", "::equipBag"),
      operandFor(abc, bagReadBody, "getlex", "::gemBag"),
      operandFor(abc, bagReadBody, "getlex", "::otherBag"),
      operandFor(abc, bagReadBody, "getlex", "::clothesBag"),
    ];

    for (let index = 0; index < bagOperands.length; index += 1) {
      snapshotCode.push(
        instruction(0x60, externalInterface), // getlex ExternalInterface
        instruction(0x2c, callbackString), // pushstring callback
        instruction(0x2c, goodsNumString),
        pushIntLiteral(bagSnapshotPayloadBase + index * bagSnapshotPayloadStride),
        instruction(0x60, bagOperands[index]), // getlex BagFactory.<category>Bag
        instruction(0x46, getAirGirdNum, 0), // callproperty getAirGirdNum, 0
        Buffer.from([0xa0]), // add
        instruction(0x46, externalCall, 3), // callproperty call, 3
        Buffer.from([0x29]) // pop
      );
    }
  }

  const bagItemCode = (index) => [
    callbackCall(goodsIdString, index),
    Buffer.from([0x73]), // convert_i
    setLocal(3),
    getLocal(3),
    pushIntLiteral(0),
    branch(0x0e, `skipBagMock${index}`), // ifngt
    callbackCall(goodsNumString, index),
    Buffer.from([0x73]), // convert_i
    setLocal(4),
    getLocal(4),
    pushIntLiteral(1),
    branch(0x18, `hasBagCount${index}`), // ifge
    pushIntLiteral(1),
    setLocal(4),
    label(`hasBagCount${index}`),
    instruction(0x5d, isFullById), // findpropstrict isFullById
    getLocal(3),
    getLocal(4),
    instruction(0x46, isFullById, 2), // callproperty isFullById, 2
    branch(0x12, `skipBagMock${index}`), // iffalse
    instruction(0x5d, addInBagById), // findpropstrict addInBagById
    getLocal(3),
    getLocal(4),
    pushIntLiteral(0),
    instruction(0x4f, addInBagById, 3), // callpropvoid addInBagById, 3
    label(`skipBagMock${index}`),
  ];

  const doneCode = options.done
    ? [
      instruction(0x60, externalInterface), // getlex ExternalInterface
      instruction(0x2c, callbackString), // pushstring callback
      instruction(0x2c, goodsIdString),
      pushIntLiteral(maxBagMockItems),
      instruction(0x46, externalCall, 3), // callproperty call, 3
      Buffer.from([0x29]), // pop
    ]
    : [];

  const code = assemble([
    ...snapshotCode,
    ...Array.from({ length: maxBagMockItems }, (_, index) => bagItemCode(index)).flat(),
    ...doneCode,
  ]);

  return {
    code,
    operands: {
      externalInterface,
      externalCall,
      callbackString,
      goodsIdString,
      goodsNumString,
      addInBagById,
      isFullById,
      ...(options.snapshot ? { bagSnapshot: true } : {}),
    },
  };
}

function buildBagGiftReplacementCode(abc, saveProcessBody, bagSjChFunBody, bcLbBody) {
  const externalInterface = operandFor(abc, saveProcessBody, "getlex", "::ExternalInterface");
  const externalCall = operandFor(abc, saveProcessBody, "callproperty", "::call");
  const callbackString = stringIndexFor(abc, callbackFunctionName);
  const goodsIdString = stringIndexFor(abc, bagItemIdCallbackKind);
  const goodsNumString = stringIndexFor(abc, bagItemCountCallbackKind);
  const addInBagById = operandFor(abc, bagSjChFunBody, "callpropvoid", "::addInBagById");
  const isFullById = operandFor(abc, bagSjChFunBody, "callproperty", "::isFullById");
  const hdGoodsTs = operandFor(abc, bagSjChFunBody, "callpropvoid", "::hdGoodsTs");
  const saveDataByKai = operandFor(abc, bcLbBody, "callpropvoid", "::saveDataByKai");
  const originalCode = Buffer.from(bcLbBody.code);

  const callbackCall = (kindString, slotCode) => Buffer.concat([
    instruction(0x60, externalInterface), // getlex ExternalInterface
    instruction(0x2c, callbackString), // pushstring callback
    instruction(0x2c, kindString),
    pushIntLiteral(slotCode),
    instruction(0x46, externalCall, 3), // callproperty call, 3
  ]);

  const bagItemCode = (index) => [
    callbackCall(goodsIdString, index),
    Buffer.from([0x73]), // convert_i
    setLocal(2),
    getLocal(2),
    pushIntLiteral(0),
    branch(0x0e, `skipBagGiftMock${index}`), // ifngt
    callbackCall(goodsNumString, index),
    Buffer.from([0x73]), // convert_i
    setLocal(3),
    getLocal(3),
    pushIntLiteral(1),
    branch(0x18, `hasBagGiftCount${index}`), // ifge
    pushIntLiteral(1),
    setLocal(3),
    label(`hasBagGiftCount${index}`),
    instruction(0x5d, isFullById), // findpropstrict isFullById
    getLocal(2),
    getLocal(3),
    instruction(0x46, isFullById, 2), // callproperty isFullById, 2
    branch(0x12, `skipBagGiftMock${index}`), // iffalse
    instruction(0x5d, addInBagById), // findpropstrict addInBagById
    getLocal(2),
    getLocal(3),
    pushIntLiteral(0),
    instruction(0x4f, addInBagById, 3), // callpropvoid addInBagById, 3
    instruction(0x5d, hdGoodsTs), // findpropstrict hdGoodsTs
    getLocal(2),
    getLocal(3),
    instruction(0x4f, hdGoodsTs, 2), // callpropvoid hdGoodsTs, 2
    label(`skipBagGiftMock${index}`),
  ];

  const code = assemble([
    Buffer.from([0xd0, 0x30]), // getlocal0, pushscope
    callbackCall(goodsIdString, 0),
    Buffer.from([0x73]), // convert_i
    setLocal(2),
    getLocal(2),
    pushIntLiteral(0),
    branch(0x0e, "runOriginalBcLb"), // ifngt
    ...Array.from({ length: maxBagMockItems }, (_, index) => bagItemCode(index)).flat(),
    instruction(0x60, externalInterface), // getlex ExternalInterface
    instruction(0x2c, callbackString), // pushstring callback
    instruction(0x2c, goodsIdString),
    pushIntLiteral(maxBagMockItems),
    instruction(0x46, externalCall, 3), // callproperty call, 3
    Buffer.from([0x29]), // pop
    instruction(0x5d, saveDataByKai), // findpropstrict saveDataByKai
    instruction(0x4f, saveDataByKai, 0), // callpropvoid saveDataByKai, 0
    Buffer.from([0x47]), // returnvoid
    label("runOriginalBcLb"),
    originalCode.subarray(2),
  ]);

  return {
    code,
    operands: {
      externalInterface,
      externalCall,
      callbackString,
      goodsIdString,
      goodsNumString,
      addInBagById,
      isFullById,
      hdGoodsTs,
      saveDataByKai,
    },
  };
}

function buildBagGameStartInsertCode(abc, saveProcessBody, bagSjChFunBody) {
  return buildBagInsertCode(abc, saveProcessBody, bagSjChFunBody);
}

function buildBagDisplayInsertCode(abc, saveProcessBody, bagReadBody, bagSjChFunBody, bagOnlyBagOneBody) {
  const options = { done: true };
  if (bagReadBody && bagOnlyBagOneBody) {
    options.snapshot = { bagReadBody, bagOnlyBagOneBody };
  }
  return buildBagInsertCode(abc, saveProcessBody, bagSjChFunBody, options);
}

function buildPlayerBagPanelInsertCode(abc, saveProcessBody, bagReadBody, bagSjChFunBody, bagOnlyBagOneBody) {
  return buildBagDisplayInsertCode(abc, saveProcessBody, bagReadBody, bagSjChFunBody, bagOnlyBagOneBody);
}

function buildBagReadInsertCode(abc, saveProcessBody, bagReadBody, bagSjChFunBody, bagOnlyBagOneBody) {
  return buildBagInsertCode(abc, saveProcessBody, bagSjChFunBody, {
    done: true,
    snapshot: { bagReadBody, bagOnlyBagOneBody },
  });
}

function buildCurrencyGetterCode(abc, saveProcessBody, targetBody) {
  const externalInterface = operandFor(abc, saveProcessBody, "getlex", "::ExternalInterface");
  const externalCall = operandFor(abc, saveProcessBody, "callproperty", "::call");
  const callbackString = stringIndexFor(abc, callbackFunctionName);
  const currencyString = stringIndexFor(abc, currencyCallbackKind);
  const originalCode = Buffer.from(targetBody.code);

  const code = assemble([
    Buffer.from([0xd0, 0x30]), // getlocal0, pushscope
    instruction(0x60, externalInterface), // getlex ExternalInterface
    instruction(0x2c, callbackString), // pushstring callback
    instruction(0x2c, currencyString), // pushstring goldCurr
    instruction(0x46, externalCall, 2), // callproperty call, 2
    Buffer.from([0x73]), // convert_i
    setLocal(1),
    getLocal(1),
    pushIntLiteral(0),
    branch(0x15, "runOriginalCurrencyGetter"), // iflt
    getLocal(1),
    Buffer.from([0x48]), // returnvalue
    label("runOriginalCurrencyGetter"),
    originalCode.subarray(2),
  ]);

  return {
    code,
    operands: {
      externalInterface,
      externalCall,
      callbackString,
      currencyString,
    },
  };
}

function writeU30SameLength(buffer, offset, newValue, label) {
  const old = readU30At(buffer, offset);
  const encoded = encodeU30(newValue);
  if (old.length !== encoded.length) {
    throw new Error(`${label} U30 length would change from ${old.length} to ${encoded.length}`);
  }
  encoded.copy(buffer, offset);
  return { oldValue: old.value, newValue };
}

function patch() {
  const swf = decodeSwf(inputPath);
  const patched = [];

  const ensureBackup = () => {
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }
  };

  for (const tag of findDoAbcTags(swf.body)) {
    let abcBuffer = tag.abc;
    let abc = parseAbc(abcBuffer);
    let headers = methodBodyHeaders(abcBuffer);

    const saveAfterCountBody = methodBodyFor(abc, saveAfterCountMethod);
    const addPetBypidBody = methodBodyFor(abc, addPetBypidMethod);
    const saveProcessBody = methodBodyFor(abc, saveProcessMethod);
    const petRReadDataBody = methodBodyFor(abc, petRReadDataMethod);
    const petRPetlWSkillByGodBody = methodBodyFor(abc, petRPetlWSkillByGodMethod);
    const currencySaveProcessBody = enableCurrencyMockPatch ? methodBodyFor(abc, saveProcessMethod) : null;
    const bagSjChFunBody = (enableBagGiftPatch || enableBagSaveAfterCountPatch || enablePlayerBagPanelPatch || enableBagReadPatch || enableBagGameStartPatch)
      ? methodBodyFor(abc, bagFactorySjChFunMethod)
      : null;
    const bagBcLbBody = enableBagGiftPatch ? methodBodyFor(abc, bagFactoryBcLbMethod) : null;

    if (enableCurrencyMockPatch && currencySaveProcessBody) {
      for (const methodName of currencyGetterMethods) {
        const currencyBody = methodBodyFor(abc, methodName);
        if (!currencyBody) {
          continue;
        }
        if (bodyHasCallback(abc, currencyBody, currencyCallbackKind)) {
          patched.push({
            method: methodName,
            currencyMock: true,
            alreadyPatched: true,
          });
          continue;
        }

        const before = disassembleBody(abc, currencyBody);
        const built = buildCurrencyGetterCode(abc, currencySaveProcessBody, currencyBody);
        const replaced = replaceMethodCode(
          abcBuffer,
          headers,
          currencyBody,
          built.code,
          methodName,
          { maxStack: Math.max(currencyBody.maxStack, 4), localCount: Math.max(currencyBody.localCount, 2) }
        );
        abcBuffer = replaced.abcBuffer;
        ensureBackup();

        patched.push({
          method: methodName,
          currencyMock: true,
          codeLength: { oldValue: currencyBody.code.length, newValue: built.code.length },
          patches: replaced.patches,
          operands: built.operands,
          before,
        });

        abc = parseAbc(abcBuffer);
        headers = methodBodyHeaders(abcBuffer);
      }
    }

    if (
      (enablePetMockPatch || enableBagSaveAfterCountPatch) &&
      saveAfterCountBody &&
      addPetBypidBody &&
      saveProcessBody &&
      petRReadDataBody &&
      petRPetlWSkillByGodBody &&
      true
    ) {
      const before = disassembleBody(abc, saveAfterCountBody);
      const saveAfterCountBagSjChFunBody = enableBagSaveAfterCountPatch ? bagSjChFunBody : null;
      const built = petMockPatchMode === "append-scan"
        ? buildDarkPetSaveAfterCountCode(
          abc,
          saveAfterCountBody,
          addPetBypidBody,
          saveProcessBody,
          petRReadDataBody,
          petRPetlWSkillByGodBody,
          saveAfterCountBagSjChFunBody
        )
        : buildFixedSlotPetSaveAfterCountCode(
          abc,
          addPetBypidBody,
          saveProcessBody,
          petRReadDataBody,
          saveAfterCountBagSjChFunBody
        );
      const replaced = replaceMethodCode(
        abcBuffer,
        headers,
        saveAfterCountBody,
        built.code,
        saveAfterCountMethod,
        { maxStack: Math.max(saveAfterCountBody.maxStack, 16), localCount: Math.max(saveAfterCountBody.localCount, 5) }
      );
      abcBuffer = replaced.abcBuffer;
      ensureBackup();

      patched.push({
        method: saveAfterCountMethod,
        petMockPatchMode,
        codeLength: { oldValue: saveAfterCountBody.code.length, newValue: built.code.length },
        patches: replaced.patches,
        operands: built.operands,
        before,
      });

      abc = parseAbc(abcBuffer);
      headers = methodBodyHeaders(abcBuffer);
    }

    if (enableBagGiftPatch && bagBcLbBody && saveProcessBody && bagSjChFunBody) {
      if (bodyHasCallback(abc, bagBcLbBody, bagItemIdCallbackKind)) {
        patched.push({
          method: bagFactoryBcLbMethod,
          bagMock: true,
          trigger: "newbie-gift-button-bcLb",
          alreadyPatched: true,
        });
      } else {
        const before = disassembleBody(abc, bagBcLbBody);
        const built = buildBagGiftReplacementCode(abc, saveProcessBody, bagSjChFunBody, bagBcLbBody);
        const replaced = replaceMethodCode(
          abcBuffer,
          headers,
          bagBcLbBody,
          built.code,
          bagFactoryBcLbMethod,
          { maxStack: Math.max(bagBcLbBody.maxStack, 16), localCount: Math.max(bagBcLbBody.localCount, 4) }
        );
        abcBuffer = replaced.abcBuffer;
        ensureBackup();

        patched.push({
          method: bagFactoryBcLbMethod,
          bagMock: true,
          trigger: "newbie-gift-button-bcLb",
          codeLength: { oldValue: bagBcLbBody.code.length, newValue: built.code.length },
          patches: replaced.patches,
          operands: built.operands,
          before,
        });

        abc = parseAbc(abcBuffer);
        headers = methodBodyHeaders(abcBuffer);
      }
    }

    const nextBagReadBody = enableBagReadPatch ? methodBodyFor(abc, bagFactoryReadMethod) : null;
    const nextBagReadSaveProcessBody = enableBagReadPatch ? methodBodyFor(abc, saveProcessMethod) : null;
    const nextBagReadSjChFunBody = enableBagReadPatch ? methodBodyFor(abc, bagFactorySjChFunMethod) : null;
    const nextBagOnlyBagOneBody = enableBagReadPatch ? methodBodyFor(abc, bagFactoryOnlyBagOneMethod) : null;
    const nextBagDisplayBody = enableBagDisplayPatch ? methodBodyFor(abc, bagDisplayInitGoodsDisplayMethod) : null;
    const nextBagDisplaySaveProcessBody = enableBagDisplayPatch ? methodBodyFor(abc, saveProcessMethod) : null;
    const nextBagDisplayReadBody = enableBagDisplayPatch ? methodBodyFor(abc, bagFactoryReadMethod) : null;
    const nextBagDisplaySjChFunBody = enableBagDisplayPatch ? methodBodyFor(abc, bagFactorySjChFunMethod) : null;
    const nextBagDisplayOnlyBagOneBody = enableBagDisplayPatch ? methodBodyFor(abc, bagFactoryOnlyBagOneMethod) : null;
    if (
      enableBagDisplayPatch &&
      nextBagDisplayBody &&
      nextBagDisplaySaveProcessBody &&
      nextBagDisplaySjChFunBody
    ) {
      const insertOffset = instructionAfter(abc, nextBagDisplayBody, "callpropvoid", "::initBagData");
      const before = disassembleBody(abc, nextBagDisplayBody);
      const built = buildBagDisplayInsertCode(
        abc,
        nextBagDisplaySaveProcessBody,
        nextBagDisplayReadBody,
        nextBagDisplaySjChFunBody,
        nextBagDisplayOnlyBagOneBody
      );
      const replaced = insertMethodCode(
        abcBuffer,
        headers,
        nextBagDisplayBody,
        insertOffset,
        built.code,
        bagDisplayInitGoodsDisplayMethod,
        { maxStack: Math.max(nextBagDisplayBody.maxStack, 16), localCount: Math.max(nextBagDisplayBody.localCount, 5) }
      );
      abcBuffer = replaced.abcBuffer;
      ensureBackup();

      patched.push({
        method: bagDisplayInitGoodsDisplayMethod,
        bagMock: true,
        trigger: "bag-display-initGoodsDisplay-after-initBagData",
        insertOffset,
        codeLength: {
          oldValue: nextBagDisplayBody.code.length,
          newValue: nextBagDisplayBody.code.length + built.code.length,
        },
        patches: replaced.patches,
        operands: built.operands,
        before,
      });

      abc = parseAbc(abcBuffer);
      headers = methodBodyHeaders(abcBuffer);
    }

    const nextBagPanelBody = enablePlayerBagPanelPatch ? methodBodyFor(abc, playerBagPanelInitPanelMethod) : null;
    const nextBagPanelSaveProcessBody = enablePlayerBagPanelPatch ? methodBodyFor(abc, saveProcessMethod) : null;
    const nextBagPanelReadBody = enablePlayerBagPanelPatch ? methodBodyFor(abc, bagFactoryReadMethod) : null;
    const nextBagPanelSjChFunBody = enablePlayerBagPanelPatch ? methodBodyFor(abc, bagFactorySjChFunMethod) : null;
    const nextBagPanelOnlyBagOneBody = enablePlayerBagPanelPatch ? methodBodyFor(abc, bagFactoryOnlyBagOneMethod) : null;
    if (
      enablePlayerBagPanelPatch &&
      nextBagPanelBody &&
      nextBagPanelSaveProcessBody &&
      nextBagPanelSjChFunBody
    ) {
      const lastInstruction = instructionsFor(nextBagPanelBody).at(-1);
      if (!lastInstruction || lastInstruction.name !== "returnvoid") {
        throw new Error(`${playerBagPanelInitPanelMethod} no longer ends with returnvoid`);
      }
      const before = disassembleBody(abc, nextBagPanelBody);
      const built = buildPlayerBagPanelInsertCode(
        abc,
        nextBagPanelSaveProcessBody,
        nextBagPanelReadBody,
        nextBagPanelSjChFunBody,
        nextBagPanelOnlyBagOneBody
      );
      const replaced = insertMethodCode(
        abcBuffer,
        headers,
        nextBagPanelBody,
        lastInstruction.offset,
        built.code,
        playerBagPanelInitPanelMethod,
        { maxStack: Math.max(nextBagPanelBody.maxStack, 16), localCount: Math.max(nextBagPanelBody.localCount, 5) }
      );
      abcBuffer = replaced.abcBuffer;
      ensureBackup();

      patched.push({
        method: playerBagPanelInitPanelMethod,
        bagMock: true,
        trigger: "player-bag-panel-initPanel-before-return",
        insertOffset: lastInstruction.offset,
        codeLength: {
          oldValue: nextBagPanelBody.code.length,
          newValue: nextBagPanelBody.code.length + built.code.length,
        },
        patches: replaced.patches,
        operands: built.operands,
        before,
      });

      abc = parseAbc(abcBuffer);
      headers = methodBodyHeaders(abcBuffer);
    }

    if (
      enableBagReadPatch &&
      nextBagReadBody &&
      nextBagReadSaveProcessBody &&
      nextBagReadSjChFunBody &&
      nextBagOnlyBagOneBody
    ) {
      const lastInstruction = instructionsFor(nextBagReadBody).at(-1);
      if (!lastInstruction || lastInstruction.name !== "returnvoid") {
        throw new Error(`${bagFactoryReadMethod} no longer ends with returnvoid`);
      }
      const before = disassembleBody(abc, nextBagReadBody);
      const built = buildBagReadInsertCode(
        abc,
        nextBagReadSaveProcessBody,
        nextBagReadBody,
        nextBagReadSjChFunBody,
        nextBagOnlyBagOneBody
      );
      const replaced = insertMethodCode(
        abcBuffer,
        headers,
        nextBagReadBody,
        lastInstruction.offset,
        built.code,
        bagFactoryReadMethod,
        { maxStack: Math.max(nextBagReadBody.maxStack, 16), localCount: Math.max(nextBagReadBody.localCount, 5) }
      );
      abcBuffer = replaced.abcBuffer;
      ensureBackup();

      patched.push({
        method: bagFactoryReadMethod,
        bagMock: true,
        trigger: "after-read-before-return",
        insertOffset: lastInstruction.offset,
        codeLength: {
          oldValue: nextBagReadBody.code.length,
          newValue: nextBagReadBody.code.length + built.code.length,
        },
        patches: replaced.patches,
        operands: built.operands,
        before,
      });

      abc = parseAbc(abcBuffer);
      headers = methodBodyHeaders(abcBuffer);
    }

    const nextGameStartBody = methodBodyFor(abc, gameStartMethod);
    const nextSaveProcessBody = methodBodyFor(abc, saveProcessMethod);
    const nextBagSjChFunBody = enableBagGameStartPatch ? methodBodyFor(abc, bagFactorySjChFunMethod) : null;
    if (enableBagGameStartPatch && nextGameStartBody && nextSaveProcessBody && nextBagSjChFunBody) {
      const insertOffset = instructionAfter(abc, nextGameStartBody, "callpropvoid", "::initDataAgain");
      const built = buildBagGameStartInsertCode(abc, nextSaveProcessBody, nextBagSjChFunBody);
      const replaced = insertMethodCode(
        abcBuffer,
        headers,
        nextGameStartBody,
        insertOffset,
        built.code,
        gameStartMethod,
        { maxStack: Math.max(nextGameStartBody.maxStack, 16), localCount: Math.max(nextGameStartBody.localCount, 5) }
      );
      abcBuffer = replaced.abcBuffer;
      ensureBackup();

      patched.push({
        method: gameStartMethod,
        bagMock: true,
        insertOffset,
        codeLength: {
          oldValue: nextGameStartBody.code.length,
          newValue: nextGameStartBody.code.length + built.code.length,
        },
        patches: replaced.patches,
        operands: built.operands,
      });

      abc = parseAbc(abcBuffer);
      headers = methodBodyHeaders(abcBuffer);
    }

    const nextSaveDataStartBody = methodBodyFor(abc, saveDataStartMethod);
    if (enableSaveGuardPatch && nextSaveDataStartBody) {
      const result = patchSaveDataStartAntiCheatBypass(abc, nextSaveDataStartBody, abcBuffer);
      if (!result.alreadyPatched) {
        ensureBackup();
      }
      patched.push({
        method: saveDataStartMethod,
        antiCheatBypass: true,
        alreadyPatched: result.alreadyPatched,
        before: result.before,
      });

      abc = parseAbc(abcBuffer);
      headers = methodBodyHeaders(abcBuffer);
    }

    if (abcBuffer !== tag.abc) {
      rewriteDoAbcTag(swf, tag, abcBuffer);
    }
  }

  const required = new Set([
    ...(enableCurrencyMockPatch ? currencyGetterMethods : []),
    ...(enablePetMockPatch || enableBagSaveAfterCountPatch ? [saveAfterCountMethod] : []),
    ...(enableSaveGuardPatch ? [saveDataStartMethod] : []),
    ...(enableBagGiftPatch ? [bagFactoryBcLbMethod] : []),
    ...(enableBagDisplayPatch ? [bagDisplayInitGoodsDisplayMethod] : []),
    ...(enablePlayerBagPanelPatch ? [playerBagPanelInitPanelMethod] : []),
    ...(enableBagReadPatch ? [bagFactoryReadMethod] : []),
    ...(enableBagGameStartPatch ? [gameStartMethod] : []),
  ]);
  for (const item of patched) {
    required.delete(item.method);
  }
  if (required.size > 0) {
    throw new Error(`Missing patch target(s): ${[...required].join(", ")}`);
  }

  swf.declaredLength = swf.body.length + 8;
  fs.writeFileSync(inputPath, encodeSwf(swf));

  return {
    patched: true,
    inputPath,
    backupPath,
    encodedSlotFactor,
    fixedPetSlot,
    enablePetMockPatch,
    enableSaveGuardPatch,
    enableCurrencyMockPatch,
    petMockPatchMode,
    enableBagGiftPatch,
    enableBagSaveAfterCountPatch,
    enableBagDisplayPatch,
    enablePlayerBagPanelPatch,
    enableBagReadPatch,
    enableBagGameStartPatch,
    patches: patched,
    outputSize: fs.statSync(inputPath).size,
  };
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
