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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-auto-start-role-patch.swf");

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

function buildAutoStartCode(abc, showBody, startClickBody) {
  const chooseJob = instructionAt(startClickBody, 91, "getproperty").operands[0];
  const gm = instructionAt(startClickBody, 84, "getlex").operands[0];
  const testapi = instructionAt(startClickBody, 87, "getproperty").operands[0];
  const jobFlag = instructionAt(startClickBody, 94, "setproperty").operands[0];
  const leafLineTime = instructionAt(startClickBody, 105, "setproperty").operands[0];
  const readData = instructionAt(startClickBody, 114, "callpropvoid").operands[0];
  const manHuaKaiC = instructionAt(startClickBody, 118, "getlex").operands[0];
  const open = instructionAt(startClickBody, 121, "callpropvoid").operands[0];

  const xuanrenjiemianMc = instructionAt(startClickBody, 77, "getproperty").operands[0];
  const visible = instructionAt(startClickBody, 81, "setproperty").operands[0];

  const code = Buffer.concat([
    Buffer.from([0xd0, 0x30]), // getlocal0, pushscope

    // Default to the first role so the offline path does not depend on a Flash mouse event.
    Buffer.from([0xd0]), // getlocal0
    Buffer.from([0x24, 0x01]), // pushbyte 1
    insn(0x68, chooseJob), // initproperty chooseJob

    // Hide the role panel if it has just been opened.
    Buffer.from([0xd0]), // getlocal0
    insn(0x66, xuanrenjiemianMc), // getproperty xuanrenjiemianMc
    Buffer.from([0x27]), // pushfalse
    insn(0x61, visible), // setproperty visible

    // Same start-game branch as GameInitC.xuanrenjiemianMcCH("kaishiyouxi").
    insn(0x60, gm), // getlex GM
    insn(0x66, testapi), // getproperty testapi
    Buffer.from([0xd0]), // getlocal0
    insn(0x66, chooseJob), // getproperty chooseJob
    insn(0x61, jobFlag), // setproperty jobFlag

    insn(0x60, gm), // getlex GM
    insn(0x66, testapi), // getproperty testapi
    Buffer.from([0x24, 0x00]), // pushbyte 0
    insn(0x61, leafLineTime), // setproperty leafLineTime

    insn(0x60, gm), // getlex GM
    insn(0x66, testapi), // getproperty testapi
    insn(0x4f, readData, 0), // callpropvoid readData, 0

    insn(0x60, manHuaKaiC), // getlex ManHuaKaiC
    insn(0x4f, open, 0), // callpropvoid open, 0
    Buffer.from([0x47]), // returnvoid
  ]);

  if (code.length > showBody.code.length) {
    throw new Error(`Auto-start code ${code.length} exceeds showXuanrenjiemianMc length ${showBody.code.length}`);
  }

  return Buffer.concat([code, Buffer.alloc(showBody.code.length - code.length, 0x02)]);
}

function patch() {
  const swf = decodeSwf(inputPath);

  for (const tag of findDoAbcTags(swf.body)) {
    const abc = parseAbc(tag.abc);
    const showBody = methodBodyFor(abc, "hotpointgame.gview::GameInitC::::showXuanrenjiemianMc");
    const startClickBody = methodBodyFor(abc, "hotpointgame.gview::GameInitC::::xuanrenjiemianMcCH");
    if (!showBody || !startClickBody) {
      continue;
    }

    const before = {
      showXuanrenjiemianMc: disassembleWindow(abc, showBody, 0, 220),
      startBranch: disassembleWindow(abc, startClickBody, 75, 125),
    };

    const newCode = buildAutoStartCode(abc, showBody, startClickBody);

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }
    newCode.copy(swf.body, tag.abcStart + showBody.codeStart);
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched: true,
      inputPath,
      backupPath,
      method: "hotpointgame.gview::GameInitC::::showXuanrenjiemianMc",
      codeLength: showBody.code.length,
      newCodeLength: newCode.length,
      before,
      outputSize: fs.statSync(inputPath).size,
    };
  }

  throw new Error("GameInitC showXuanrenjiemianMc/xuanrenjiemianMcCH bodies were not found");
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
