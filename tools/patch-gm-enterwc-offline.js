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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-enterwc-offline-patch.swf");

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

function findQNameIndex(abc, predicate, description) {
  const index = abc.multinames.findIndex((item) => predicate(qname(item)));
  if (index < 0) {
    throw new Error(`Missing multiname ${description}`);
  }
  return index;
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

function disassemble(abc, body) {
  const lines = [];
  let cursor = 0;
  while (cursor < body.code.length) {
    const decoded = decodeInstruction(body.code, cursor);
    const detail = operandDescription(abc, decoded);
    lines.push(`${decoded.offset}: ${decoded.name}${detail ? ` ${detail}` : ""}`);
    cursor += Math.max(1, decoded.length);
  }
  return lines;
}

function buildOfflineCode(abc, targetLength) {
  const enterGameInitc = findQNameIndex(
    abc,
    (value) => value.endsWith("::enterGameInitc"),
    "enterGameInitc"
  );

  const code = Buffer.concat([
    Buffer.from([0xd0, 0x30]), // getlocal0, pushscope
    insn(0x5d, enterGameInitc), // findpropstrict enterGameInitc
    insn(0x4f, enterGameInitc, 0), // callpropvoid enterGameInitc, 0
    Buffer.from([0x47]), // returnvoid
  ]);

  if (code.length > targetLength) {
    throw new Error(`Offline enterWc code ${code.length} exceeds target length ${targetLength}`);
  }

  return Buffer.concat([code, Buffer.alloc(targetLength - code.length, 0x02)]);
}

function patch() {
  const swf = decodeSwf(inputPath);

  for (const tag of findDoAbcTags(swf.body)) {
    const abc = parseAbc(tag.abc);
    const body = methodBodyFor(abc, "hotpointgame.Control::GM::static::::enterWc");
    if (!body) {
      continue;
    }

    const before = disassemble(abc, body);
    const newCode = buildOfflineCode(abc, body.code.length);
    newCode.copy(swf.body, tag.abcStart + body.codeStart);

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched: true,
      inputPath,
      backupPath,
      method: "hotpointgame.Control::GM::static::::enterWc",
      codeLength: body.code.length,
      before,
      outputSize: fs.statSync(inputPath).size,
    };
  }

  throw new Error("GM.enterWc body was not found");
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
