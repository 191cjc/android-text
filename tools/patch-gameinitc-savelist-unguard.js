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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-savelist-unguard-patch.swf");

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
    const body = methodBodyFor(abc, "hotpointgame.gview::GameInitC::::SaveListOkCH");
    if (!body) {
      continue;
    }

    const before = disassembleWindow(abc, body, 0, 14);
    const expected = [
      [2, "getlex"],
      [5, "pushbyte"],
      [7, "ifne"],
    ];

    for (const [offset, name] of expected) {
      const decoded = decodeInstruction(body.code, offset);
      if (decoded.name !== name) {
        throw new Error(`Expected ${name} at SaveListOkCH offset ${offset}, found ${decoded.name}`);
      }
    }

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }

    const absoluteStart = tag.abcStart + body.codeStart + 2;
    swf.body.fill(0x02, absoluteStart, absoluteStart + 9);
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched: true,
      inputPath,
      backupPath,
      method: "hotpointgame.gview::GameInitC::::SaveListOkCH",
      replacedOffsets: "2..10",
      before,
      outputSize: fs.statSync(inputPath).size,
    };
  }

  throw new Error("SaveListOkCH body was not found");
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
