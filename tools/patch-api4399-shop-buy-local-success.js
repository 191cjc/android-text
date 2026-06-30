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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-api4399-shop-buy-local-success-patch.swf");

const getStateMethod = "hotpointgame.gameobj::Api4399::::getStateAndBuyShopProp";
const buyCallbackMethod = "hotpointgame.gameobj::Api4399::::getStateAndBuyShopPropCallBack";
const buyMethod = "hotpointgame.gameobj::Api4399::::buyShopProp";
const dgMoneyGetterMethod = "hotpointgame.gview::GameShangChengC::::dgMoney";
const shopBuyByApiMethod = "hotpointgame.gview::GameShangChengC::::buyShopByApi";
const shopBuyByApiOneMethod = "hotpointgame.gview::GameShangChengC::::buyShopByApiOne";
const shopBuyOverMethod = "hotpointgame.gview::GameShangChengC::::buyShopOver";
const shopConfirmClickMethod = "hotpointgame.gview::GameShangChengC::::scgoumaijiemianByClick";
const panelCallbackName = "dataIndexYouData";
const shopBuyCallbackKind = "buyShopProp";
const shopConfirmButtonName = "sctok";
const shopSuccessMessage = "购买成功!";
const mockedShopBalance = 50000;

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

function getLocal(index) {
  if (index >= 0 && index <= 3) {
    return Buffer.from([0xd0 + index]);
  }
  return instruction(0x62, index);
}

function buildMockedShopBalanceCode() {
  if (mockedShopBalance < 0) {
    throw new Error(`mockedShopBalance must be non-negative: ${mockedShopBalance}`);
  }
  if (mockedShopBalance <= 32767) {
    return instruction(0x25, mockedShopBalance); // pushshort
  }

  const chunks = [];
  let remaining = mockedShopBalance;
  while (remaining > 0) {
    const chunk = Math.min(30000, remaining);
    chunks.push(chunk);
    remaining -= chunk;
  }

  return Buffer.concat([
    instruction(0x25, chunks[0]), // pushshort
    ...chunks.slice(1).flatMap((chunk) => [
      instruction(0x25, chunk), // pushshort
      Buffer.from([0xa0]), // add
    ]),
    Buffer.from([0x73]), // convert_i
  ]);
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
    } else if ([1, 2, 3, 4, 5].includes(kind)) {
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
  for (let i = 1; i < count; i += 1) reader.u30();

  count = reader.u30();
  for (let i = 1; i < count; i += 1) reader.u30();

  count = reader.u30();
  reader.offset += Math.max(0, count - 1) * 8;

  count = reader.u30();
  for (let i = 1; i < count; i += 1) reader.bytes(reader.u30());

  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    reader.u8();
    reader.u30();
  }

  count = reader.u30();
  for (let i = 1; i < count; i += 1) {
    const setCount = reader.u30();
    for (let j = 0; j < setCount; j += 1) reader.u30();
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
      for (let j = 0; j < paramCount; j += 1) reader.u30();
    } else {
      throw new Error(`Unsupported multiname kind ${kind}`);
    }
  }

  const methodCount = reader.u30();
  for (let i = 0; i < methodCount; i += 1) {
    const paramCount = reader.u30();
    reader.u30();
    for (let j = 0; j < paramCount; j += 1) reader.u30();
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
      for (let j = 0; j < paramCount; j += 1) reader.u30();
    }
  }

  skipMetadata(reader);

  const classCount = reader.u30();
  for (let i = 0; i < classCount; i += 1) {
    reader.u30();
    reader.u30();
    const flags = reader.u8();
    if ((flags & 0x08) !== 0) reader.u30();
    const interfaceCount = reader.u30();
    for (let j = 0; j < interfaceCount; j += 1) reader.u30();
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

function operandQName(abc, decoded) {
  if (!decoded || decoded.operands.length === 0) {
    return "";
  }
  return qname(abc.multinames[decoded.operands[0]]) || "";
}

function operandFor(abc, qnameSuffix, opNames = null) {
  for (const body of abc.methodBodies) {
    for (const decoded of instructionsFor(body)) {
      if (opNames && !opNames.includes(decoded.name)) {
        continue;
      }
      if (operandQName(abc, decoded).endsWith(qnameSuffix)) {
        return decoded.operands[0];
      }
    }
  }
  throw new Error(`Missing operand ${qnameSuffix}`);
}

function operandForBody(abc, body, qnameSuffix, opNames = null) {
  for (const decoded of instructionsFor(body)) {
    if (opNames && !opNames.includes(decoded.name)) {
      continue;
    }
    if (operandQName(abc, decoded).endsWith(qnameSuffix)) {
      return decoded.operands[0];
    }
  }
  throw new Error(`Missing operand ${qnameSuffix} in method #${body.method}`);
}

function operandForQNameMatch(abc, qnameSuffix, opNames, predicate) {
  for (const body of abc.methodBodies) {
    for (const decoded of instructionsFor(body)) {
      if (opNames && !opNames.includes(decoded.name)) {
        continue;
      }
      const name = operandQName(abc, decoded);
      if (name.endsWith(qnameSuffix) && predicate(name)) {
        return decoded.operands[0];
      }
    }
  }
  throw new Error(`Missing matched operand ${qnameSuffix}`);
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

function firstInstructionBefore(instructions, offset, name, qnameSuffix, abc) {
  for (let i = instructions.length - 1; i >= 0; i -= 1) {
    const decoded = instructions[i];
    if (decoded.offset >= offset) {
      continue;
    }
    if (decoded.name === name && operandQName(abc, decoded).endsWith(qnameSuffix)) {
      return { decoded, index: i };
    }
  }
  return null;
}

function bodyHasCall(abc, body, qnameSuffix) {
  return instructionsFor(body).some((decoded) =>
    ["callproperty", "callpropvoid"].includes(decoded.name) &&
    operandQName(abc, decoded).endsWith(qnameSuffix)
  );
}

function bodyHasString(abc, body, value) {
  const index = abc.strings.findIndex((item) => item === value);
  if (index < 0) {
    return false;
  }
  return instructionsFor(body).some((decoded) =>
    decoded.name === "pushstring" && decoded.operands[0] === index
  );
}

function bodyHasPanelGate(abc, body) {
  return bodyHasString(abc, body, panelCallbackName) && bodyHasString(abc, body, shopBuyCallbackKind);
}

function bodyCallsGameShopBuyOver(abc, body) {
  return instructionsFor(body).some((decoded) => {
    const name = operandQName(abc, decoded);
    return decoded.name === "callpropvoid" &&
      name.endsWith("::buyShopOver") &&
      name.includes("hotpointgame.gview:GameShangChengC");
  });
}

function bodyHasNoSaveShopSuccess(abc, body) {
  return bodyHasPanelGate(abc, body) &&
    bodyHasString(abc, body, shopSuccessMessage) &&
    !bodyCallsGameShopBuyOver(abc, body);
}

function bodyIsOriginalShopConfirmClick(abc, body) {
  return bodyHasCall(abc, body, "::buyShopByApi") && !bodyHasPanelGate(abc, body);
}

function disassembleWindow(abc, body, start, end) {
  return instructionsFor(body)
    .filter((decoded) => decoded.offset >= start && decoded.offset < end)
    .map((decoded) => {
      const detail = operandDescription(abc, decoded);
      return `${decoded.offset}: ${decoded.name}${detail ? ` ${detail}` : ""}`;
    });
}

function writeU30SameLength(buffer, offset, newValue, labelText) {
  const old = readU30At(buffer, offset);
  const encoded = encodeU30(newValue);
  if (old.length !== encoded.length) {
    throw new Error(`${labelText} U30 length would change from ${old.length} to ${encoded.length}`);
  }
  encoded.copy(buffer, offset);
  return { oldValue: old.value, newValue };
}

function replaceMethodCode(abcBuffer, headers, body, code, labelText, options = {}) {
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
  patches.maxStackPatch = maxStack !== header.maxStack
    ? writeU30SameLength(nextAbc, header.maxStackOffset, maxStack, `${labelText} maxStack`)
    : { oldValue: header.maxStack, newValue: header.maxStack };

  const localCount = options.localCount ?? header.localCount;
  patches.localCountPatch = localCount !== header.localCount
    ? writeU30SameLength(nextAbc, header.localCountOffset, localCount, `${labelText} localCount`)
    : { oldValue: header.localCount, newValue: header.localCount };

  if (oldCodeLengthInfo.length !== encodedLength.length) {
    patches.codeLengthU30Bytes = { oldValue: oldCodeLengthInfo.length, newValue: encodedLength.length };
  }

  return { abcBuffer: nextAbc, patches };
}

function buildDirectStateCallbackCode(callbackOperand) {
  return Buffer.concat([
    getLocal(0),
    instruction(0x4f, callbackOperand, 0), // callpropvoid getStateAndBuyShopPropCallBack, 0
    Buffer.from([0x47]), // returnvoid
  ]);
}

function buildLocalSuccessTailCode(operands, objectLocal) {
  return Buffer.concat([
    getLocal(objectLocal),
    instruction(0x60, operands.gameShangChengC), // getlex GameShangChengC
    instruction(0x66, operands.self), // getproperty self
    instruction(0x66, operands.dgMoney), // getproperty dgMoney
    instruction(0x61, operands.balance), // setproperty balance
    getLocal(0),
    getLocal(objectLocal),
    instruction(0x4f, operands.buySuccFun, 1), // callpropvoid buySuccFun, 1
    Buffer.from([0x47]), // returnvoid
  ]);
}

function buildBuyShopOverLocalSuccessCode(operands) {
  return Buffer.concat([
    getLocal(0),
    instruction(0x66, operands.mc), // getproperty mc
    instruction(0x2c, operands.waitPanelString), // pushstring scwpgmz
    instruction(0x66, operands.any), // getproperty *
    instruction(0x60, operands.movieClip), // getlex MovieClip
    Buffer.from([0x87]), // astypelate
    Buffer.from([0x27]), // pushfalse
    instruction(0x61, operands.visible), // setproperty visible
    getLocal(0),
    instruction(0x66, operands.mc), // getproperty mc
    instruction(0x2c, operands.balanceTextString), // pushstring scxingzhuan
    instruction(0x66, operands.any), // getproperty *
    instruction(0x60, operands.textField), // getlex TextField
    Buffer.from([0x87]), // astypelate
    instruction(0x5d, operands.stringConstructor), // findpropstrict String
    getLocal(0),
    instruction(0x66, operands.dgMoney), // getproperty dgMoney
    instruction(0x46, operands.stringConstructor, 1), // callproperty String, 1
    instruction(0x61, operands.text), // setproperty text
    instruction(0x60, operands.goodsManger), // getlex GoodsManger
    instruction(0x2c, operands.successMessageString), // pushstring purchase success
    instruction(0x4f, operands.cwTs, 1), // callpropvoid cwTs, 1
    Buffer.from([0x47]), // returnvoid
  ]);
}

function buildDirectShopSuccessCode(operands, countSource, options = {}) {
  const countCode = countSource === "one"
    ? Buffer.from([0x24, 0x01]) // pushbyte 1
    : Buffer.concat([
        getLocal(0),
        instruction(0x66, operands.buynumCur), // getproperty buynumCur
      ]);

  return Buffer.concat([
    instruction(0x60, operands.flowInterface), // getlex FlowInterface
    instruction(0x60, operands.flowInterface), // getlex FlowInterface
    getLocal(0),
    instruction(0x66, operands.buyshopBD), // getproperty buyshopBD
    instruction(0x66, operands.propId), // getproperty propId
    instruction(0x46, operands.getGoodsById, 1), // callproperty getGoodsById, 1
    countCode,
    instruction(0x4f, operands.addInBagDL, 2), // callpropvoid addInBagDL, 2
    ...(options.closeConfirm
      ? [
          getLocal(0),
          instruction(0x66, operands.scgoumaijiemianMc), // getproperty scgoumaijiemianMc
          Buffer.from([0x27]), // pushfalse
          instruction(0x61, operands.visible), // setproperty visible
        ]
      : []),
    instruction(0x60, operands.goodsManger), // getlex GoodsManger
    instruction(0x2c, operands.successMessageString), // pushstring purchase success
    instruction(0x4f, operands.cwTs, 1), // callpropvoid cwTs, 1
    Buffer.from([0x47]), // returnvoid
  ]);
}

function panelOperandsFor(abc) {
  return {
    externalInterface: operandFor(abc, "::ExternalInterface", ["getlex"]),
    externalCall: operandFor(abc, "::call", ["callproperty"]),
    panelCallbackString: stringIndexFor(abc, panelCallbackName),
    shopBuyString: stringIndexFor(abc, shopBuyCallbackKind),
  };
}

function buildPanelEnabledCheckCode(operands, trueLabel) {
  return [
    instruction(0x60, operands.externalInterface), // getlex ExternalInterface
    instruction(0x2c, operands.panelCallbackString), // pushstring dataIndexYouData
    instruction(0x2c, operands.shopBuyString), // pushstring buyShopProp
    instruction(0x46, operands.externalCall, 2), // callproperty call, 2
    Buffer.from([0x73]), // convert_i
    branch(0x11, trueLabel), // iftrue
  ];
}

function patchDgMoneyGetterMethod(abc, body, abcBuffer, headers) {
  if (bodyHasPanelGate(abc, body)) {
    return { abcBuffer, result: { method: dgMoneyGetterMethod, alreadyPatched: true } };
  }

  const instructions = instructionsFor(body);
  if (!instructions.some((decoded) => decoded.name === "returnvalue")) {
    throw new Error(`${dgMoneyGetterMethod} returnvalue was not found`);
  }

  const panelOperands = panelOperandsFor(abc);
  const code = assemble([
    ...buildPanelEnabledCheckCode(panelOperands, "mockedBalance"),
    body.code,
    label("mockedBalance"),
    buildMockedShopBalanceCode(),
    Buffer.from([0x48]), // returnvalue
  ]);
  const replaced = replaceMethodCode(
    abcBuffer,
    headers,
    body,
    code,
    dgMoneyGetterMethod,
    { maxStack: Math.max(body.maxStack, 4) }
  );

  return {
    abcBuffer: replaced.abcBuffer,
    result: {
      method: dgMoneyGetterMethod,
      codeLength: { oldValue: body.code.length, newValue: code.length },
      patches: replaced.patches,
      operands: { ...panelOperands, mockedShopBalance },
    },
  };
}

function patchGetStateMethod(abc, body, abcBuffer, headers) {
  if (bodyHasPanelGate(abc, body)) {
    return { abcBuffer, result: { method: getStateMethod, alreadyPatched: true } };
  }
  if (!bodyHasCall(abc, body, "::getSaveStateByFun")) {
    throw new Error(`${getStateMethod} is neither original nor panel-gated`);
  }

  const instructions = instructionsFor(body);
  const saveStateCall = instructions.find((decoded) =>
    decoded.name === "callpropvoid" &&
    operandQName(abc, decoded).endsWith("::getSaveStateByFun")
  );
  const previousCallbackGet = firstInstructionBefore(
    instructions,
    saveStateCall.offset,
    "getproperty",
    "::getStateAndBuyShopPropCallBack",
    abc
  );
  if (!previousCallbackGet) {
    throw new Error(`${getStateMethod} callback getter was not found before getSaveStateByFun`);
  }

  const tailStartIndex = previousCallbackGet.index - 2;
  if (tailStartIndex < 0 || instructions[tailStartIndex].name !== "getlocal0") {
    throw new Error(`${getStateMethod} tail layout changed before callback getter`);
  }

  const tailStart = instructions[tailStartIndex].offset;
  const callbackOperand = operandForBody(abc, body, "::getStateAndBuyShopPropCallBack", ["getproperty"]);
  const panelOperands = panelOperandsFor(abc);
  const before = disassembleWindow(abc, body, tailStart, body.code.length);
  const code = assemble([
    body.code.subarray(0, tailStart),
    ...buildPanelEnabledCheckCode(panelOperands, "localSuccess"),
    body.code.subarray(tailStart),
    label("localSuccess"),
    buildDirectStateCallbackCode(callbackOperand),
  ]);
  const replaced = replaceMethodCode(
    abcBuffer,
    headers,
    body,
    code,
    getStateMethod,
    { maxStack: Math.max(body.maxStack, 4) }
  );

  return {
    abcBuffer: replaced.abcBuffer,
    result: {
      method: getStateMethod,
      tailStart,
      codeLength: { oldValue: body.code.length, newValue: code.length },
      patches: replaced.patches,
      before,
      operands: { callbackOperand, ...panelOperands },
    },
  };
}

function patchBuyTailMethod(abc, body, abcBuffer, headers, methodName, objectLocal) {
  if (bodyHasPanelGate(abc, body)) {
    return { abcBuffer, result: { method: methodName, alreadyPatched: true } };
  }
  if (!bodyHasCall(abc, body, "::buyPropNd")) {
    throw new Error(`${methodName} is neither original nor panel-gated`);
  }

  const instructions = instructionsFor(body);
  const buyPropCallIndex = instructions.findIndex((decoded) =>
    decoded.name === "callpropvoid" &&
    operandQName(abc, decoded).endsWith("::buyPropNd")
  );
  if (buyPropCallIndex < 0) {
    throw new Error(`${methodName} buyPropNd call was not found`);
  }

  const tailStartIndex = buyPropCallIndex - 6;
  if (
    tailStartIndex < 0 ||
    instructions[tailStartIndex].name !== "getlex" ||
    !operandQName(abc, instructions[tailStartIndex]).endsWith("::Main") ||
    instructions[tailStartIndex + 2].name !== "iffalse"
  ) {
    throw new Error(`${methodName} buyPropNd tail layout changed`);
  }

  const tailStart = instructions[tailStartIndex].offset;
  const operands = {
    buySuccFun: operandFor(abc, "::buySuccFun", ["callpropvoid"]),
    gameShangChengC: operandFor(abc, "::GameShangChengC", ["getlex"]),
    self: operandFor(abc, "::self", ["getproperty"]),
    dgMoney: operandFor(abc, "::dgMoney", ["getproperty", "setproperty"]),
    balance: operandFor(abc, "::balance", ["getproperty", "setproperty"]),
    ...panelOperandsFor(abc),
  };
  const before = disassembleWindow(abc, body, tailStart, body.code.length);
  const code = assemble([
    body.code.subarray(0, tailStart),
    ...buildPanelEnabledCheckCode(operands, "localSuccess"),
    body.code.subarray(tailStart),
    label("localSuccess"),
    buildLocalSuccessTailCode(operands, objectLocal),
  ]);
  const replaced = replaceMethodCode(
    abcBuffer,
    headers,
    body,
    code,
    methodName,
    { maxStack: Math.max(body.maxStack, 4) }
  );

  return {
    abcBuffer: replaced.abcBuffer,
    result: {
      method: methodName,
      tailStart,
      codeLength: { oldValue: body.code.length, newValue: code.length },
      patches: replaced.patches,
      before,
      operands,
    },
  };
}

function patchDirectShopBuyMethod(abc, body, abcBuffer, headers, methodName, countSource) {
  if (bodyHasPanelGate(abc, body)) {
    return { abcBuffer, result: { method: methodName, alreadyPatched: true } };
  }
  if (!bodyHasCall(abc, body, "::getStateAndBuyShopProp")) {
    throw new Error(`${methodName} is neither original nor panel-gated`);
  }

  const instructions = instructionsFor(body);
  if (instructions[0]?.name !== "getlocal0" || instructions[1]?.name !== "pushscope") {
    throw new Error(`${methodName} prologue layout changed`);
  }

  const prologueEnd = instructions[2]?.offset ?? 2;
  const operands = {
    flowInterface: operandForBody(abc, body, "::FlowInterface", ["getlex"]),
    buyshopBD: operandForBody(abc, body, "::buyshopBD", ["getproperty"]),
    propId: operandForBody(abc, body, "::propId", ["getproperty"]),
    getGoodsById: operandForQNameMatch(
      abc,
      "::getGoodsById",
      ["callproperty"],
      (name) => name.includes("hotpointgame.Control:GM")
    ),
    addInBagDL: operandForQNameMatch(
      abc,
      "::addInBagDL",
      ["callpropvoid"],
      (name) => name.includes("hotpointgame.gameobj:ApiInterface")
    ),
    goodsManger: operandFor(abc, "::GoodsManger", ["getlex"]),
    cwTs: operandFor(abc, "::cwTs", ["callpropvoid"]),
    successMessageString: stringIndexFor(abc, shopSuccessMessage),
    buynumCur: operandForBody(abc, body, "::buynumCur", ["getproperty"]),
    ...panelOperandsFor(abc),
  };
  const before = disassembleWindow(abc, body, 0, Math.min(body.code.length, 80));
  const code = assemble([
    body.code.subarray(0, prologueEnd),
    ...buildPanelEnabledCheckCode(operands, "localSuccess"),
    body.code.subarray(prologueEnd),
    label("localSuccess"),
    buildDirectShopSuccessCode(operands, countSource),
  ]);
  const replaced = replaceMethodCode(
    abcBuffer,
    headers,
    body,
    code,
    methodName,
    { maxStack: Math.max(body.maxStack, 6) }
  );

  return {
    abcBuffer: replaced.abcBuffer,
    result: {
      method: methodName,
      prologueEnd,
      countSource,
      codeLength: { oldValue: body.code.length, newValue: code.length },
      patches: replaced.patches,
      before,
      operands,
    },
  };
}

function patchBuyShopOverMethod(abc, body, abcBuffer, headers) {
  if (bodyHasPanelGate(abc, body)) {
    return { abcBuffer, result: { method: shopBuyOverMethod, alreadyPatched: true } };
  }
  if (!bodyHasCall(abc, body, "::saveDataBeforeNoState")) {
    throw new Error(`${shopBuyOverMethod} is neither original nor panel-gated`);
  }

  const instructions = instructionsFor(body);
  const saveCallIndex = instructions.findIndex((decoded) =>
    decoded.name === "callpropvoid" &&
    operandQName(abc, decoded).endsWith("::saveDataBeforeNoState")
  );
  if (saveCallIndex < 0) {
    throw new Error(`${shopBuyOverMethod} saveDataBeforeNoState call was not found`);
  }

  const saveCall = instructions[saveCallIndex];
  const tailStartIndex = saveCallIndex - 2;
  if (
    tailStartIndex < 0 ||
    instructions[tailStartIndex].name !== "getlex" ||
    !operandQName(abc, instructions[tailStartIndex]).endsWith("::GM")
  ) {
    throw new Error(`${shopBuyOverMethod} saveDataBeforeNoState tail layout changed`);
  }

  const afterSaveOffset = saveCall.offset + saveCall.length;
  const operands = {
    mc: operandForBody(abc, body, "::mc", ["getproperty"]),
    any: operandForBody(abc, body, "::*", ["getproperty"]),
    movieClip: operandForBody(abc, body, "::MovieClip", ["getlex"]),
    visible: operandForBody(abc, body, "::visible", ["setproperty"]),
    textField: operandForBody(abc, body, "::TextField", ["getlex"]),
    stringConstructor: operandForBody(abc, body, "::String", ["findpropstrict", "callproperty"]),
    dgMoney: operandForBody(abc, body, "::dgMoney", ["getproperty"]),
    text: operandForBody(abc, body, "::text", ["setproperty"]),
    goodsManger: operandForBody(abc, body, "::GoodsManger", ["getlex"]),
    cwTs: operandForBody(abc, body, "::cwTs", ["callpropvoid"]),
    waitPanelString: stringIndexFor(abc, "scwpgmz"),
    balanceTextString: stringIndexFor(abc, "scxingzhuan"),
    successMessageString: stringIndexFor(abc, shopSuccessMessage),
    ...panelOperandsFor(abc),
  };
  const tailStart = instructions[tailStartIndex].offset;
  const before = disassembleWindow(abc, body, tailStart, Math.min(body.code.length, 120));
  const code = assemble([
    body.code.subarray(0, tailStart),
    ...buildPanelEnabledCheckCode(operands, "localSuccess"),
    body.code.subarray(tailStart, afterSaveOffset),
    label("afterOriginalSave"),
    body.code.subarray(afterSaveOffset),
    label("localSuccess"),
    buildBuyShopOverLocalSuccessCode(operands),
  ]);
  const replaced = replaceMethodCode(
    abcBuffer,
    headers,
    body,
    code,
    shopBuyOverMethod,
    { maxStack: Math.max(body.maxStack, 6) }
  );

  return {
    abcBuffer: replaced.abcBuffer,
    result: {
      method: shopBuyOverMethod,
      tailStart,
      codeLength: { oldValue: body.code.length, newValue: code.length },
      patches: replaced.patches,
      before,
      operands,
    },
  };
}

function patchShopConfirmClickMethod(abc, body, abcBuffer, headers) {
  if (bodyHasPanelGate(abc, body)) {
    return { abcBuffer, result: { method: shopConfirmClickMethod, alreadyPatched: true } };
  }
  if (!bodyHasCall(abc, body, "::buyShopByApi")) {
    throw new Error(`${shopConfirmClickMethod} is neither original nor panel-gated`);
  }

  const instructions = instructionsFor(body);
  if (instructions[0]?.name !== "getlocal0" || instructions[1]?.name !== "pushscope") {
    throw new Error(`${shopConfirmClickMethod} prologue layout changed`);
  }

  const prologueEnd = instructions[2]?.offset ?? 2;
  const operands = {
    target: operandForBody(abc, body, "::target", ["getproperty"]),
    name: operandForBody(abc, body, "::name", ["getproperty"]),
    confirmButtonString: stringIndexFor(abc, shopConfirmButtonName),
    flowInterface: operandFor(abc, "::FlowInterface", ["getlex"]),
    buyshopBD: operandForBody(abc, body, "::buyshopBD", ["getproperty"]),
    propId: operandFor(abc, "::propId", ["getproperty"]),
    getGoodsById: operandFor(abc, "::getGoodsById", ["callproperty"]),
    addInBagDL: operandFor(abc, "::addInBagDL", ["callpropvoid"]),
    scgoumaijiemianMc: operandForBody(abc, body, "::scgoumaijiemianMc", ["getproperty"]),
    visible: operandFor(abc, "::visible", ["setproperty"]),
    goodsManger: operandFor(abc, "::GoodsManger", ["getlex"]),
    cwTs: operandFor(abc, "::cwTs", ["callpropvoid"]),
    successMessageString: stringIndexFor(abc, shopSuccessMessage),
    buynumCur: operandFor(abc, "::buynumCur", ["getproperty"]),
    ...panelOperandsFor(abc),
  };
  const before = disassembleWindow(abc, body, 0, Math.min(body.code.length, 260));
  const code = assemble([
    body.code.subarray(0, prologueEnd),
    ...buildPanelEnabledCheckCode(operands, "mockEnabled"),
    label("original"),
    body.code.subarray(prologueEnd),
    label("mockEnabled"),
    getLocal(1),
    instruction(0x66, operands.target), // getproperty target
    instruction(0x66, operands.name), // getproperty name
    instruction(0x2c, operands.confirmButtonString), // pushstring sctok
    branch(0x1a, "original"), // ifstrictne
    buildDirectShopSuccessCode(operands, "buynumCur", { closeConfirm: true }),
  ]);
  const replaced = replaceMethodCode(
    abcBuffer,
    headers,
    body,
    code,
    shopConfirmClickMethod,
    { maxStack: Math.max(body.maxStack, 6) }
  );

  return {
    abcBuffer: replaced.abcBuffer,
    result: {
      method: shopConfirmClickMethod,
      prologueEnd,
      codeLength: { oldValue: body.code.length, newValue: code.length },
      patches: replaced.patches,
      before,
      operands,
    },
  };
}

function inspectPatchState(filePath) {
  const swf = decodeSwf(filePath);
  for (const tag of findDoAbcTags(swf.body)) {
    const abc = parseAbc(tag.abc);
    const methodNames = [
      getStateMethod,
      buyCallbackMethod,
      buyMethod,
      dgMoneyGetterMethod,
      shopBuyOverMethod,
      shopConfirmClickMethod,
    ];
    const bodies = methodNames.map((method) => methodBodyFor(abc, method));
    if (bodies.every(Boolean)) {
      const gatedBodies = bodies.slice(0, 5);
      const confirmBody = bodies[5];
      return {
        found: true,
        alreadyPanelGated:
          gatedBodies.every((body) => bodyHasPanelGate(abc, body)) &&
          bodyHasNoSaveShopSuccess(abc, bodies[4]) &&
          bodyIsOriginalShopConfirmClick(abc, confirmBody),
        stalePanelPatch:
          bodies.some((body) => bodyHasPanelGate(abc, body)) &&
          !(
            gatedBodies.every((body) => bodyHasPanelGate(abc, body)) &&
            bodyHasNoSaveShopSuccess(abc, bodies[4]) &&
            bodyIsOriginalShopConfirmClick(abc, confirmBody)
          ),
        originalPatchable:
          bodyHasCall(abc, bodies[0], "::getSaveStateByFun") &&
          bodyHasCall(abc, bodies[1], "::buyPropNd") &&
          bodyHasCall(abc, bodies[2], "::buyPropNd") &&
          bodyHasCall(abc, bodies[4], "::saveDataBeforeNoState") &&
          bodyIsOriginalShopConfirmClick(abc, confirmBody),
      };
    }
  }
  return { found: false, alreadyPanelGated: false, originalPatchable: false };
}

function refreshDeclaredLength(filePath) {
  const swf = decodeSwf(filePath);
  const expected = swf.body.length + 8;
  if (swf.declaredLength === expected) {
    return null;
  }

  const oldValue = swf.declaredLength;
  swf.declaredLength = expected;
  fs.writeFileSync(filePath, encodeSwf(swf));
  return { oldValue, newValue: expected };
}

function refreshPatchedShopBalance(filePath) {
  const swf = decodeSwf(filePath);

  for (const tag of findDoAbcTags(swf.body)) {
    let abcBuffer = tag.abc;
    const abc = parseAbc(abcBuffer);
    const body = methodBodyFor(abc, dgMoneyGetterMethod);
    if (!body || !bodyHasPanelGate(abc, body)) {
      continue;
    }

    const instructions = instructionsFor(body);
    const returnValue = instructions[instructions.length - 1];
    const panelOperands = panelOperandsFor(abc);
    const branchCall = instructions.find((decoded) =>
      decoded.name === "callproperty" &&
      decoded.operands[0] === panelOperands.externalCall &&
      decoded.operands[1] === 2
    );
    if (!branchCall) {
      throw new Error(`${dgMoneyGetterMethod} panel gate call was not found`);
    }
    let tailIndex = instructions.findIndex((decoded) => decoded.offset > branchCall.offset && decoded.name === "returnvalue");
    if (tailIndex < 0) {
      throw new Error(`${dgMoneyGetterMethod} original returnvalue after panel gate was not found`);
    }
    tailIndex += 1;
    const tailCodeOffset = instructions[tailIndex]?.offset ?? -1;
    const tailCodeLength = returnValue ? returnValue.offset - tailCodeOffset : -1;
    if (
      !returnValue ||
      returnValue.name !== "returnvalue" ||
      tailCodeOffset < 0 ||
      tailCodeLength < 0
    ) {
      throw new Error(`${dgMoneyGetterMethod} patched balance tail was not found`);
    }

    const currentBalanceCode = body.code.subarray(tailCodeOffset, tailCodeOffset + tailCodeLength);
    const nextBalanceCode = buildMockedShopBalanceCode();
    const oldBalance = instructions
      .slice(tailIndex, instructions.length - 1)
      .filter((decoded) => decoded.name === "pushshort")
      .reduce((total, decoded) => total + decoded.operands[0], 0);
    if (currentBalanceCode.subarray(0, nextBalanceCode.length).equals(nextBalanceCode) &&
      currentBalanceCode.subarray(nextBalanceCode.length).every((byte) => byte === 0x02)
    ) {
      const declaredLengthPatch = refreshDeclaredLength(filePath);
      return {
        patched: Boolean(declaredLengthPatch),
        alreadyPatched: true,
        balancePatch: null,
        declaredLengthPatch,
      };
    }

    const header = methodBodyHeaders(abcBuffer)[body.index];
    const code = Buffer.concat([
      body.code.subarray(0, tailCodeOffset),
      nextBalanceCode,
      body.code.subarray(returnValue.offset),
    ]);
    const replaced = replaceMethodCode(
      abcBuffer,
      methodBodyHeaders(abcBuffer),
      body,
      code,
      dgMoneyGetterMethod,
      { maxStack: Math.max(header.maxStack, 4) }
    );
    abcBuffer = replaced.abcBuffer;
    rewriteDoAbcTag(swf, tag, abcBuffer);
    swf.declaredLength = swf.body.length + 8;
    fs.writeFileSync(filePath, encodeSwf(swf));
    return {
      patched: true,
      alreadyPatched: true,
      balancePatch: { oldValue: oldBalance, newValue: mockedShopBalance },
      declaredLengthPatch: null,
    };
  }

  throw new Error(`${dgMoneyGetterMethod} patched method was not found`);
}

function patch() {
  const currentState = inspectPatchState(inputPath);
  if (currentState.alreadyPanelGated) {
    const refreshed = refreshPatchedShopBalance(inputPath);
    return {
      ...refreshed,
      inputPath,
      backupPath,
    };
  }

  if (!currentState.found) {
    throw new Error("Api4399 shop buy methods were not found");
  }

  let sourcePath = inputPath;
  if (currentState.stalePanelPatch) {
    if (!fs.existsSync(backupPath)) {
      throw new Error("Current SWF has a stale shop-buy patch and the pre-shop backup is missing");
    }
    sourcePath = backupPath;
  } else if (!currentState.originalPatchable) {
    if (!fs.existsSync(backupPath)) {
      throw new Error("Current SWF is not patchable and the pre-shop backup is missing");
    }
    sourcePath = backupPath;
  } else if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(inputPath, backupPath);
  }

  const swf = decodeSwf(sourcePath);
  const patched = [];

  for (const tag of findDoAbcTags(swf.body)) {
    let abcBuffer = tag.abc;
    let abc = parseAbc(abcBuffer);
    let headers = methodBodyHeaders(abcBuffer);
    let getStateBody = methodBodyFor(abc, getStateMethod);
    let callbackBody = methodBodyFor(abc, buyCallbackMethod);
    let buyBody = methodBodyFor(abc, buyMethod);
    let dgMoneyBody = methodBodyFor(abc, dgMoneyGetterMethod);
    let buyShopOverBody = methodBodyFor(abc, shopBuyOverMethod);
    let shopConfirmClickBody = methodBodyFor(abc, shopConfirmClickMethod);

    if (
      !getStateBody &&
      !callbackBody &&
      !buyBody &&
      !dgMoneyBody &&
      !buyShopOverBody &&
      !shopConfirmClickBody
    ) {
      continue;
    }
    if (
      !getStateBody ||
      !callbackBody ||
      !buyBody ||
      !dgMoneyBody ||
      !buyShopOverBody ||
      !shopConfirmClickBody
    ) {
      throw new Error("Found only part of shop buy methods; refusing partial patch");
    }

    let patchedOne = patchGetStateMethod(abc, getStateBody, abcBuffer, headers);
    abcBuffer = patchedOne.abcBuffer;
    patched.push(patchedOne.result);

    abc = parseAbc(abcBuffer);
    headers = methodBodyHeaders(abcBuffer);
    callbackBody = methodBodyFor(abc, buyCallbackMethod);
    patchedOne = patchBuyTailMethod(abc, callbackBody, abcBuffer, headers, buyCallbackMethod, 1);
    abcBuffer = patchedOne.abcBuffer;
    patched.push(patchedOne.result);

    abc = parseAbc(abcBuffer);
    headers = methodBodyHeaders(abcBuffer);
    buyBody = methodBodyFor(abc, buyMethod);
    patchedOne = patchBuyTailMethod(abc, buyBody, abcBuffer, headers, buyMethod, 6);
    abcBuffer = patchedOne.abcBuffer;
    patched.push(patchedOne.result);

    abc = parseAbc(abcBuffer);
    headers = methodBodyHeaders(abcBuffer);
    dgMoneyBody = methodBodyFor(abc, dgMoneyGetterMethod);
    patchedOne = patchDgMoneyGetterMethod(abc, dgMoneyBody, abcBuffer, headers);
    abcBuffer = patchedOne.abcBuffer;
    patched.push(patchedOne.result);

    abc = parseAbc(abcBuffer);
    headers = methodBodyHeaders(abcBuffer);
    buyShopOverBody = methodBodyFor(abc, shopBuyOverMethod);
    patchedOne = patchBuyShopOverMethod(abc, buyShopOverBody, abcBuffer, headers);
    abcBuffer = patchedOne.abcBuffer;
    patched.push(patchedOne.result);

    rewriteDoAbcTag(swf, tag, abcBuffer);
    swf.declaredLength = swf.body.length + 8;
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched: true,
      inputPath,
      backupPath,
      sourcePath,
      methods: patched,
      outputSize: fs.statSync(inputPath).size,
    };
  }

  throw new Error("Api4399 shop buy methods were not found");
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
