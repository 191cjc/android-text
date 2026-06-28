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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-auto-new-save-patch.swf");

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

function instructionAt(body, offset, expectedName) {
  let cursor = 0;
  while (cursor < body.code.length) {
    const decoded = decodeInstruction(body.code, cursor);
    if (decoded.offset === offset) {
      if (decoded.name !== expectedName) {
        throw new Error(`Expected ${expectedName} at ${offset}, found ${decoded.name}`);
      }
      return decoded;
    }
    cursor += Math.max(1, decoded.length);
  }
  throw new Error(`Instruction at ${offset} was not found`);
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

    const gengxinString = findStringIndex(abc, "gengxin");
    const xinjianString = findStringIndex(abc, "xinjian");
    const tempFMultiname = findGameInitCMultinameIndex(abc, "tempF");
    const curMcMultiname = findGameInitCMultinameIndex(abc, "curMc");
    const saveListOkCH = findGameInitCMultinameIndex(abc, "SaveListOkCH");

    const before = {
      resetDefault: disassembleWindow(abc, resetBody, 1018, 1025),
      resetTail: disassembleWindow(abc, resetBody, 1150, 1184),
      saveList: disassembleWindow(abc, saveListBody, 44, 88),
    };

    const patched = [];

    const defaultString = instructionAt(resetBody, 1020, "pushstring");
    if (defaultString.operands[0] !== gengxinString) {
      writeU30SameLength(
        swf.body,
        tag.abcStart + resetBody.codeStart + defaultString.offset + 1,
        defaultString.operands[0],
        gengxinString,
        "reset curMc default"
      );
      patched.push("reset.curMc=xinjian->gengxin");
    }

    for (const offset of [46, 82]) {
      const propertyInsn = instructionAt(saveListBody, offset, "getproperty");
      if (propertyInsn.operands[0] !== tempFMultiname) {
        if (propertyInsn.operands[0] !== curMcMultiname) {
          throw new Error(`Unexpected SaveListOkCH property at ${offset}: ${propertyInsn.operands[0]}`);
        }
        writeU30SameLength(
          swf.body,
          tag.abcStart + saveListBody.codeStart + propertyInsn.offset + 1,
          propertyInsn.operands[0],
          tempFMultiname,
          `SaveListOkCH ${offset}`
        );
        patched.push(`SaveListOkCH.${offset}=curMc->tempF`);
      }
    }

    const tailStart = 1152;
    const tailEnd = 1185;
    const tailLength = tailEnd - tailStart;
    const getlexGM = instructionAt(resetBody, 1170, "getlex");
    const getpropertyFone = instructionAt(resetBody, 1173, "getproperty");
    const getpropertyMc = instructionAt(resetBody, 1177, "getproperty");
    const callAddChild = instructionAt(resetBody, 1180, "callpropvoid");

    const newTail = Buffer.concat([
      Buffer.from([0xd0]), // getlocal0
      insn(0x2c, xinjianString), // pushstring "xinjian"
      insn(0x68, tempFMultiname), // initproperty tempF
      Buffer.from([0xd0]), // getlocal0
      insn(0x4f, saveListOkCH, 0), // callpropvoid SaveListOkCH, 0
      insn(0x60, getlexGM.operands[0]), // getlex GM
      insn(0x66, getpropertyFone.operands[0]), // getproperty fone
      Buffer.from([0xd0]), // getlocal0
      insn(0x66, getpropertyMc.operands[0]), // getproperty mc
      insn(0x4f, callAddChild.operands[0], callAddChild.operands[1]), // callpropvoid addChild, 1
      Buffer.from([0x47]), // returnvoid
    ]);

    if (newTail.length > tailLength) {
      throw new Error(`New reset tail ${newTail.length} exceeds available ${tailLength}`);
    }

    const paddedTail = Buffer.concat([newTail, Buffer.alloc(tailLength - newTail.length, 0x02)]);
    paddedTail.copy(swf.body, tag.abcStart + resetBody.codeStart + tailStart);
    patched.push(`reset.tail=auto-tempF-saveList (${newTail.length}/${tailLength})`);

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
