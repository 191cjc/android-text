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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-cloud-first-save-list-patch.swf");

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

function insn(op, ...operands) {
  return Buffer.concat([
    Buffer.from([op]),
    ...operands.map((operand) => encodeU30(operand)),
  ]);
}

function branch(op, offset) {
  const out = Buffer.alloc(4);
  out[0] = op;
  out.writeIntLE(offset, 1, 3);
  return out;
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

function findGameInitCMultinameIndex(abc, wantedName) {
  const index = abc.multinames.findIndex((item) => {
    const value = qname(item);
    return value.includes("GameInitC") && value.endsWith(`::${wantedName}`);
  });
  if (index < 0) {
    throw new Error(`Missing GameInitC multiname ${wantedName}`);
  }
  return index;
}

function findMultinameIndex(abc, wantedName) {
  const index = abc.multinames.findIndex((item) => {
    const value = qname(item);
    return value.endsWith(`::${wantedName}`);
  });
  if (index < 0) {
    throw new Error(`Missing multiname ${wantedName}`);
  }
  return index;
}

function findStringIndex(abc, value) {
  const index = abc.strings.findIndex((item) => item === value);
  if (index < 0) {
    throw new Error(`Missing string ${value}`);
  }
  return index;
}

function writeU30SameLength(buffer, absoluteOffset, oldValue, newValue, label) {
  const oldBytes = encodeU30(oldValue);
  const newBytes = encodeU30(newValue);
  if (oldBytes.length !== newBytes.length) {
    throw new Error(`${label} replacement would change bytecode length`);
  }
  newBytes.copy(buffer, absoluteOffset);
}

function instructionAt(body, offset, expectedName) {
  const decoded = decodeInstruction(body.code, offset);
  if (decoded.name !== expectedName) {
    throw new Error(`Expected ${expectedName} at ${offset}, found ${decoded.name}`);
  }
  return decoded;
}

function disassembleWindow(abc, body, start, end) {
  const lines = [];
  let cursor = 0;
  while (cursor < body.code.length) {
    const decoded = decodeInstruction(body.code, cursor);
    if (decoded.offset >= start && decoded.offset <= end) {
      const detail = operandDescription(abc, decoded);
      lines.push(`${decoded.offset}: ${decoded.name}${detail ? ` ${detail}` : ""}`);
    }
    cursor += Math.max(1, decoded.length);
  }
  return lines;
}

function patch() {
  const swf = decodeSwf(inputPath);

  for (const tag of findDoAbcTags(swf.body)) {
    const abc = parseAbc(tag.abc);
    const resetBody = methodBodyFor(abc, "hotpointgame.gview::GameInitC::::reset");
    const saveListBody = methodBodyFor(abc, "hotpointgame.gview::GameInitC::::SaveListOkCH");
    if (!resetBody || !saveListBody) {
      continue;
    }

    const curs = findGameInitCMultinameIndex(abc, "curs");
    const curMc = findGameInitCMultinameIndex(abc, "curMc");
    const tempF = findGameInitCMultinameIndex(abc, "tempF");
    const mc = findGameInitCMultinameIndex(abc, "mc");
    const x = findGameInitCMultinameIndex(abc, "x");
    const y = findGameInitCMultinameIndex(abc, "y");
    const fone = findGameInitCMultinameIndex(abc, "fone");
    const gm = findMultinameIndex(abc, "GM");
    const addChild = findGameInitCMultinameIndex(abc, "addChild");
    const xinjian = findStringIndex(abc, "xinjian");
    const gengxin = findStringIndex(abc, "gengxin");

    const before = {
      saveListHead: disassembleWindow(abc, saveListBody, 0, 12),
      saveListMode: disassembleWindow(abc, saveListBody, 44, 88),
      resetDefault: disassembleWindow(abc, resetBody, 1018, 1025),
      resetTail: disassembleWindow(abc, resetBody, 1150, 1184),
    };
    const patched = [];

    const guard = Buffer.concat([
      insn(0x60, curs), // getlex curs
      Buffer.from([0x24, 0x01]), // pushbyte 1
      branch(0x14, 106), // ifne +106
    ]);
    if (guard.length !== 9) {
      throw new Error(`SaveListOkCH guard length ${guard.length} is not 9`);
    }
    guard.copy(swf.body, tag.abcStart + saveListBody.codeStart + 2);
    patched.push("SaveListOkCH.guard=curs");

    for (const offset of [46, 82]) {
      const propertyInsn = instructionAt(saveListBody, offset, "getproperty");
      if (propertyInsn.operands[0] !== curMc) {
        if (propertyInsn.operands[0] !== tempF) {
          throw new Error(`Unexpected SaveListOkCH property at ${offset}: ${propertyInsn.operands[0]}`);
        }
        writeU30SameLength(
          swf.body,
          tag.abcStart + saveListBody.codeStart + propertyInsn.offset + 1,
          propertyInsn.operands[0],
          curMc,
          `SaveListOkCH ${offset}`
        );
        patched.push(`SaveListOkCH.${offset}=tempF->curMc`);
      }
    }

    const defaultString = instructionAt(resetBody, 1020, "pushstring");
    if (defaultString.operands[0] !== xinjian) {
      if (defaultString.operands[0] !== gengxin) {
        throw new Error(`Unexpected reset default string index ${defaultString.operands[0]}`);
      }
      writeU30SameLength(
        swf.body,
        tag.abcStart + resetBody.codeStart + defaultString.offset + 1,
        defaultString.operands[0],
        xinjian,
        "reset curMc default"
      );
      patched.push("reset.curMc=gengxin->xinjian");
    }

    const originalTail = Buffer.concat([
      Buffer.from([0xd0]), // getlocal0
      insn(0x66, mc),
      Buffer.from([0x24, 0x00]),
      insn(0x61, x),
      Buffer.from([0xd0]),
      insn(0x66, mc),
      Buffer.from([0x24, 0x00]),
      insn(0x61, y),
      insn(0x60, gm),
      insn(0x66, fone),
      Buffer.from([0xd0]),
      insn(0x66, mc),
      insn(0x4f, addChild, 1),
      Buffer.from([0x47]),
    ]);
    if (originalTail.length > 33) {
      throw new Error(`Original reset tail ${originalTail.length} exceeds 33`);
    }
    const tailStart = tag.abcStart + resetBody.codeStart + 1152;
    originalTail.copy(swf.body, tailStart);
    swf.body.fill(0x02, tailStart + originalTail.length, tailStart + 33);
    patched.push("reset.tail=no-auto-save-list");

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched,
      inputPath,
      backupPath,
      before,
      outputSize: fs.statSync(inputPath).size,
    };
  }

  throw new Error("GameInitC reset/SaveListOkCH bodies were not found");
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
