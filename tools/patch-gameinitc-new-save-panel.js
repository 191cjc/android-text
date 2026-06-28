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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-new-save-panel-patch.swf");

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
    const insn = decodeInstruction(body.code, cursor);
    if (insn.offset >= start && insn.offset <= end) {
      const detail = operandDescription(abc, insn);
      lines.push(`${insn.offset}: ${insn.name}${detail ? ` ${detail}` : ""}`);
    }
    cursor += Math.max(1, insn.length);
  }
  return lines;
}

function patch() {
  const swf = decodeSwf(inputPath);
  const patched = [];

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

    const resetBefore = disassembleWindow(abc, resetBody, 1015, 1026);
    const saveBefore = disassembleWindow(abc, saveListBody, 40, 90);

    let resetCurMcPatched = false;
    let cursor = 0;
    while (cursor < resetBody.code.length) {
      const insn = decodeInstruction(resetBody.code, cursor);
      if (insn.offset === 1020 && insn.name === "pushstring") {
        if (![gengxinString, xinjianString].includes(insn.operands[0])) {
          throw new Error(`Unexpected reset curMc string index ${insn.operands[0]}`);
        }
        if (insn.operands[0] !== xinjianString) {
          writeU30SameLength(
            swf.body,
            tag.abcStart + resetBody.codeStart + insn.offset + 1,
            insn.operands[0],
            xinjianString,
            "reset curMc"
          );
          patched.push("reset.curMc=gengxin->xinjian");
        }
        resetCurMcPatched = true;
      }
      cursor += Math.max(1, insn.length);
    }
    if (!resetCurMcPatched) {
      throw new Error("reset curMc pushstring target was not found");
    }

    const saveOffsets = new Set([46, 82]);
    const seenSaveOffsets = new Set();
    cursor = 0;
    while (cursor < saveListBody.code.length) {
      const insn = decodeInstruction(saveListBody.code, cursor);
      if (saveOffsets.has(insn.offset) && insn.name === "getproperty") {
        if (![tempFMultiname, curMcMultiname].includes(insn.operands[0])) {
          throw new Error(`Unexpected SaveListOkCH property at ${insn.offset}: ${insn.operands[0]}`);
        }
        if (insn.operands[0] !== curMcMultiname) {
          writeU30SameLength(
            swf.body,
            tag.abcStart + saveListBody.codeStart + insn.offset + 1,
            insn.operands[0],
            curMcMultiname,
            `SaveListOkCH ${insn.offset}`
          );
          patched.push(`SaveListOkCH.${insn.offset}=tempF->curMc`);
        }
        seenSaveOffsets.add(insn.offset);
      }
      cursor += Math.max(1, insn.length);
    }
    for (const offset of saveOffsets) {
      if (!seenSaveOffsets.has(offset)) {
        throw new Error(`SaveListOkCH getproperty at ${offset} was not found`);
      }
    }

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched,
      inputPath,
      backupPath,
      method: "hotpointgame.gview::GameInitC",
      resetBefore,
      saveBefore,
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
