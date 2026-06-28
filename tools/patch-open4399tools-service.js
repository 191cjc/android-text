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
const backupPath = path.join(projectRoot, "modified", "L4399Main_gamefile.before-open4399tools-patch.swf");

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

function findQNameIndex(abc, expected) {
  const index = abc.multinames.findIndex((item) => qname(item) === expected);
  if (index < 0) {
    throw new Error(`Missing multiname ${expected}`);
  }
  return index;
}

function findConstructorBody(abc) {
  const names = buildMethodNames(abc);
  for (const body of abc.methodBodies) {
    const owners = names.get(body.method) || [];
    if (owners.includes("open4399Tools::Open4399ToolsService::<init>")) {
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

function buildBypassCode(abc, targetLength) {
  const getInstance = findQNameIndex(abc, "open4399Tools::Open4399ToolsApi");
  const getInstanceProp = findQNameIndex(abc, "{,,,open4399Tools,open4399Tools,http://adobe.com/AS3/2006/builtin,open4399Tools:Open4399ToolsService,open4399Tools:Open4399ToolsService}::getInstance");
  const eventClass = findQNameIndex(abc, "open4399Tools.events::Open4399ToolsEvent");
  const serviceInit = findQNameIndex(abc, "{,,,open4399Tools,open4399Tools,http://adobe.com/AS3/2006/builtin,open4399Tools:Open4399ToolsService,open4399Tools:Open4399ToolsService}::SERVICE_INIT");
  const dispatchEvent = findQNameIndex(abc, "{,,,open4399Tools,open4399Tools,http://adobe.com/AS3/2006/builtin,open4399Tools:Open4399ToolsService,open4399Tools:Open4399ToolsService}::dispatchEvent");

  const code = Buffer.concat([
    Buffer.from([0xd0, 0x30, 0xd0]), // getlocal0, pushscope, getlocal0
    insn(0x49, 0), // constructsuper 0
    insn(0x60, getInstance), // getlex Open4399ToolsApi
    insn(0x46, getInstanceProp, 0), // callproperty getInstance, 0
    insn(0x5d, eventClass), // findpropstrict Open4399ToolsEvent
    insn(0x60, eventClass), // getlex Open4399ToolsEvent
    insn(0x66, serviceInit), // getproperty SERVICE_INIT
    insn(0x4a, eventClass, 1), // constructprop Open4399ToolsEvent, 1
    insn(0x4f, dispatchEvent, 1), // callpropvoid dispatchEvent, 1
    Buffer.from([0x47]), // returnvoid
  ]);

  if (code.length > targetLength) {
    throw new Error(`Bypass code length ${code.length} exceeds target length ${targetLength}`);
  }

  return Buffer.concat([
    code,
    Buffer.alloc(targetLength - code.length, 0x02),
  ]);
}

function patch() {
  const swf = decodeSwf(inputPath);
  const tags = findDoAbcTags(swf.body);

  for (const tag of tags) {
    const abc = parseAbc(tag.abc);
    const body = findConstructorBody(abc);
    if (!body) {
      continue;
    }

    const before = disassemble(abc, body).slice(0, 12);
    const newCode = buildBypassCode(abc, body.code.length);
    newCode.copy(swf.body, tag.abcStart + body.codeStart);

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(inputPath, backupPath);
    }
    fs.writeFileSync(inputPath, encodeSwf(swf));

    return {
      patched: true,
      inputPath,
      backupPath,
      method: "open4399Tools::Open4399ToolsService::<init>",
      codeLength: body.code.length,
      replacementLength: newCode.length,
      before,
      outputSize: fs.statSync(inputPath).size,
    };
  }

  throw new Error("Open4399ToolsService constructor body was not found");
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
