const path = require("path");
const {
  decodeSwf,
  findDoAbcTags,
  parseAbc,
  qname,
} = require("./patch-pay-event-listener");
const {
  buildMethodNames,
  decodeInstruction,
  operandDescription,
} = require("./inspect-abc-references");

function methodBodyFor(abc, methodIndex) {
  return abc.methodBodies.find((body) => body.method === methodIndex);
}

function disassembleBody(abc, body) {
  const lines = [];
  let cursor = 0;
  while (cursor < body.code.length) {
    let insn;
    try {
      insn = decodeInstruction(body.code, cursor);
    } catch (error) {
      lines.push(`${String(cursor).padStart(5, " ")}  decode_error ${error.message}`);
      cursor += 1;
      continue;
    }
    const detail = operandDescription(abc, insn);
    lines.push(`${String(insn.offset).padStart(5, " ")}  ${insn.name}${detail ? ` ${detail}` : ""}`);
    cursor += Math.max(1, insn.length);
  }
  return lines;
}

function dump(filePath, pattern) {
  const swf = decodeSwf(filePath);
  const output = [];
  for (const tag of findDoAbcTags(swf.body)) {
    const abc = parseAbc(tag.abc);
    const methodNames = buildMethodNames(abc);

    for (const [methodIndex, owners] of methodNames.entries()) {
      if (!owners.some((owner) => owner.includes(pattern))) {
        continue;
      }
      const body = methodBodyFor(abc, methodIndex);
      const method = abc.methods[methodIndex];
      output.push("");
      output.push(`method #${methodIndex} ${method?.name || "(anonymous)"}`);
      output.push(`owners: ${owners.join(" | ")}`);
      if (!body) {
        output.push("  <no body>");
        continue;
      }
      output.push(`body #${body.index} maxStack=${body.maxStack} localCount=${body.localCount} codeLength=${body.code.length} codeStart=${body.codeStart}`);
      output.push(...disassembleBody(abc, body));
    }

    for (let i = 0; i < abc.instances.length; i += 1) {
      const className = qname(abc.multinames[abc.instances[i].name]);
      if (!className.includes(pattern)) {
        continue;
      }
      output.push("");
      output.push(`class ${className}`);
      output.push(`instance traits: ${(abc.instances[i].traits || []).length}`);
      output.push(`static traits: ${(abc.classes?.[i]?.traits || []).length}`);
    }
  }
  return output.join("\n");
}

function main() {
  const filePath = process.argv[2] || path.join("modified", "L4399Main_gamefile.swf");
  const pattern = process.argv[3] || "Open4399ToolsService";
  console.log(dump(filePath, pattern));
}

if (require.main === module) {
  main();
}
