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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-manhuakaic-auto-enter-game-patch.swf");

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

function buildAutoEnterGameCode(abc, targetLength) {
  const gm = findQNameIndex(
    abc,
    (value) => value.endsWith("::GM"),
    "GM"
  );
  const enterCunFlag = findQNameIndex(
    abc,
    (value) => value.endsWith("::enterCunFlag"),
    "enterCunFlag"
  );
  const enterGame = findQNameIndex(
    abc,
    (value) => value.endsWith("::enterGame"),
    "enterGame"
  );

  const code = Buffer.concat([
    Buffer.from([0xd0, 0x30]), // getlocal0, pushscope

    // Match the existing skip-button branch without constructing the comic UI.
    insn(0x60, gm), // getlex GM
    Buffer.from([0x27]), // pushfalse
    insn(0x61, enterCunFlag), // setproperty enterCunFlag

    insn(0x60, gm), // getlex GM
    insn(0x4f, enterGame, 0), // callpropvoid enterGame, 0
    Buffer.from([0x47]), // returnvoid
  ]);

  if (code.length > targetLength) {
    throw new Error(`Auto-enter-game code ${code.length} exceeds target length ${targetLength}`);
  }

  return Buffer.concat([code, Buffer.alloc(targetLength - code.length, 0x02)]);
}

function patch() {
  const swf = decodeSwf(inputPath);

  for (const tag of findDoAbcTags(swf.body)) {
    const abc = parseAbc(tag.abc);
    const body = methodBodyFor(abc, "hotpointgame.gview::ManHuaKaiC::static::::open");
    if (!body) {
      continue;
    }

    const before = disassembleWindow(abc, body, 0, body.code.length);
    const newCode = buildAutoEnterGameCode(abc, body.code.length);

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }

    newCode.copy(swf.body, tag.abcStart + body.codeStart);
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched: true,
      inputPath,
      backupPath,
      method: "hotpointgame.gview::ManHuaKaiC::static::::open",
      codeLength: body.code.length,
      before,
      outputSize: fs.statSync(inputPath).size,
    };
  }

  throw new Error("ManHuaKaiC.open body was not found");
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
