const fs = require("fs");
const path = require("path");
const {
  decodeSwf,
  encodeSwf,
  findDoAbcTags,
  parseAbc,
} = require("./patch-pay-event-listener");
const {
  buildMethodNames,
  decodeInstruction,
  operandDescription,
} = require("./inspect-abc-references");

const projectRoot = path.resolve(__dirname, "..");
const inputPath = path.join(projectRoot, "modified", "L4399Main_gamefile.swf");
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-default-menu-patch.swf");

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

function findResetBody(abc) {
  const names = buildMethodNames(abc);
  return abc.methodBodies.find((body) => {
    const owners = names.get(body.method) || [];
    return owners.includes("hotpointgame.gview::GameInitC::::reset");
  }) || null;
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

  for (const tag of findDoAbcTags(swf.body)) {
    const abc = parseAbc(tag.abc);
    const body = findResetBody(abc);
    if (!body) {
      continue;
    }

    const oldIndex = abc.strings.findIndex((value) => value === "gengxin");
    const newIndex = abc.strings.findIndex((value) => value === "xinjian");
    if (oldIndex < 0 || newIndex < 0) {
      throw new Error("Missing xinjian/gengxin string constants");
    }

    let patchOffset = null;
    let cursor = 0;
    while (cursor < body.code.length) {
      const insn = decodeInstruction(body.code, cursor);
      if (
        insn.offset === 195 &&
        insn.name === "pushstring" &&
        insn.operands[0] === oldIndex
      ) {
        patchOffset = tag.abcStart + body.codeStart + insn.offset + 1;
        break;
      }
      cursor += Math.max(1, insn.length);
    }

    if (patchOffset == null) {
      throw new Error("Default GameInitC menu pushstring target was not found");
    }

    const newBytes = encodeU30(newIndex);
    const oldBytes = encodeU30(oldIndex);
    if (newBytes.length !== oldBytes.length) {
      throw new Error("String index replacement would change bytecode length");
    }

    const before = disassembleWindow(abc, body, 180, 205);
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }
    newBytes.copy(swf.body, patchOffset);
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched: true,
      inputPath,
      backupPath,
      method: "hotpointgame.gview::GameInitC::::reset",
      oldIndex,
      newIndex,
      patchOffset,
      before,
      outputSize: fs.statSync(inputPath).size,
    };
  }

  throw new Error("GameInitC.reset body was not found");
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
