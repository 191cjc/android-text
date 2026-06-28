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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-role-start-default-patch.swf");

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

function readS24(buffer, offset) {
  let value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
  if ((value & 0x800000) !== 0) {
    value |= 0xff000000;
  }
  return value;
}

function writeS24(buffer, offset, value) {
  const unsigned = value < 0 ? value + 0x1000000 : value;
  buffer[offset] = unsigned & 0xff;
  buffer[offset + 1] = (unsigned >> 8) & 0xff;
  buffer[offset + 2] = (unsigned >> 16) & 0xff;
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
    const body = methodBodyFor(abc, "hotpointgame.gview::GameInitC::::xuanrenjiemianMcCH");
    if (!body) {
      continue;
    }

    const switchInsn = decodeInstruction(body.code, 355);
    if (switchInsn.name !== "lookupswitch") {
      throw new Error(`Expected lookupswitch at 355, found ${switchInsn.name}`);
    }

    const before = disassembleWindow(abc, body, 275, 375);
    const defaultOffset = readS24(body.code, 356);
    const case4Offset = readS24(body.code, 372);
    const startCaseOffset = readS24(body.code, 363);

    if (defaultOffset !== -87 || case4Offset !== -87 || startCaseOffset !== -280) {
      throw new Error(
        `Unexpected xuanrenjiemian switch offsets default=${defaultOffset} case4=${case4Offset} start=${startCaseOffset}`
      );
    }

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }

    const absoluteCodeStart = tag.abcStart + body.codeStart;
    writeS24(swf.body, absoluteCodeStart + 356, startCaseOffset);
    writeS24(swf.body, absoluteCodeStart + 372, startCaseOffset);
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched: true,
      inputPath,
      backupPath,
      method: "hotpointgame.gview::GameInitC::::xuanrenjiemianMcCH",
      changed: {
        defaultOffset: `${defaultOffset}->${startCaseOffset}`,
        case4Offset: `${case4Offset}->${startCaseOffset}`,
      },
      before,
      outputSize: fs.statSync(inputPath).size,
    };
  }

  throw new Error("xuanrenjiemianMcCH body was not found");
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
