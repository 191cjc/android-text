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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-dljldata-offline-rewards-patch.swf");

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

function buildOfflineIsOkCode(targetLength) {
  const code = Buffer.from([
    0xd0, // getlocal0
    0x30, // pushscope
    0x27, // pushfalse
    0x48, // returnvalue
  ]);

  if (code.length > targetLength) {
    throw new Error(`Offline DljlData.isOk code ${code.length} exceeds target length ${targetLength}`);
  }

  return Buffer.concat([code, Buffer.alloc(targetLength - code.length, 0x02)]);
}

function patch() {
  const swf = decodeSwf(inputPath);

  for (const tag of findDoAbcTags(swf.body)) {
    const abc = parseAbc(tag.abc);
    const body = methodBodyFor(abc, "hotpointgame.views.dljlPanel::DljlData::static::::isOk");
    if (!body) {
      continue;
    }

    const before = disassembleWindow(abc, body, 0, Math.min(body.code.length, 153));
    const newCode = buildOfflineIsOkCode(body.code.length);

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }

    newCode.copy(swf.body, tag.abcStart + body.codeStart);
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched: true,
      inputPath,
      backupPath,
      method: "hotpointgame.views.dljlPanel::DljlData::static::::isOk",
      codeLength: body.code.length,
      before,
      outputSize: fs.statSync(inputPath).size,
    };
  }

  throw new Error("DljlData.isOk body was not found");
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
