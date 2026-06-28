const path = require("path");
const {
  decodeSwf,
  findDoAbcTags,
  parseAbc,
  qname,
} = require("./patch-pay-event-listener");

function readU30At(buffer, offset) {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = buffer[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, length: i + 1 };
    }
  }
  throw new Error(`Invalid U30 at bytecode offset ${offset}`);
}

function readS24(buffer, offset) {
  let value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
  if ((value & 0x800000) !== 0) {
    value |= 0xff000000;
  }
  return value;
}

function skipU30Operands(buffer, offset, count) {
  let cursor = offset;
  const operands = [];
  for (let i = 0; i < count; i += 1) {
    const operand = readU30At(buffer, cursor);
    operands.push(operand.value);
    cursor += operand.length;
  }
  return { length: cursor - offset, operands };
}

const opNames = {
  0x02: "nop",
  0x03: "throw",
  0x04: "getsuper",
  0x05: "setsuper",
  0x06: "dxns",
  0x07: "dxnslate",
  0x08: "kill",
  0x09: "label",
  0x0c: "ifnlt",
  0x0d: "ifnle",
  0x0e: "ifngt",
  0x0f: "ifnge",
  0x10: "jump",
  0x11: "iftrue",
  0x12: "iffalse",
  0x13: "ifeq",
  0x14: "ifne",
  0x15: "iflt",
  0x16: "ifle",
  0x17: "ifgt",
  0x18: "ifge",
  0x19: "ifstricteq",
  0x1a: "ifstrictne",
  0x1b: "lookupswitch",
  0x1c: "pushwith",
  0x1d: "popscope",
  0x1e: "nextname",
  0x1f: "hasnext",
  0x20: "pushnull",
  0x21: "pushundefined",
  0x23: "nextvalue",
  0x24: "pushbyte",
  0x25: "pushshort",
  0x26: "pushtrue",
  0x27: "pushfalse",
  0x28: "pushnan",
  0x29: "pop",
  0x2a: "dup",
  0x2b: "swap",
  0x2c: "pushstring",
  0x2d: "pushint",
  0x2e: "pushuint",
  0x2f: "pushdouble",
  0x30: "pushscope",
  0x31: "pushnamespace",
  0x32: "hasnext2",
  0x40: "newfunction",
  0x41: "call",
  0x42: "construct",
  0x43: "callmethod",
  0x44: "callstatic",
  0x45: "callsuper",
  0x46: "callproperty",
  0x47: "returnvoid",
  0x48: "returnvalue",
  0x49: "constructsuper",
  0x4a: "constructprop",
  0x4c: "callproplex",
  0x4e: "callsupervoid",
  0x4f: "callpropvoid",
  0x53: "applytype",
  0x55: "newobject",
  0x56: "newarray",
  0x57: "newactivation",
  0x58: "newclass",
  0x59: "getdescendants",
  0x5a: "newcatch",
  0x5d: "findpropstrict",
  0x5e: "findproperty",
  0x5f: "finddef",
  0x60: "getlex",
  0x61: "setproperty",
  0x62: "getlocal",
  0x63: "setlocal",
  0x64: "getglobalscope",
  0x65: "getscopeobject",
  0x66: "getproperty",
  0x68: "initproperty",
  0x6a: "deleteproperty",
  0x6c: "getslot",
  0x6d: "setslot",
  0x6e: "getglobalslot",
  0x6f: "setglobalslot",
  0x70: "convert_s",
  0x71: "esc_xelem",
  0x72: "esc_xattr",
  0x73: "convert_i",
  0x74: "convert_u",
  0x75: "convert_d",
  0x76: "convert_b",
  0x77: "convert_o",
  0x78: "checkfilter",
  0x80: "coerce",
  0x82: "coerce_a",
  0x85: "coerce_s",
  0x86: "astype",
  0x87: "astypelate",
  0x90: "negate",
  0x91: "increment",
  0x92: "inclocal",
  0x93: "decrement",
  0x94: "declocal",
  0x95: "typeof",
  0x96: "not",
  0x97: "bitnot",
  0xa0: "add",
  0xa1: "subtract",
  0xa2: "multiply",
  0xa3: "divide",
  0xa4: "modulo",
  0xa5: "lshift",
  0xa6: "rshift",
  0xa7: "urshift",
  0xa8: "bitand",
  0xa9: "bitor",
  0xaa: "bitxor",
  0xab: "equals",
  0xac: "strictequals",
  0xad: "lessthan",
  0xae: "lessequals",
  0xaf: "greaterthan",
  0xb0: "greaterequals",
  0xb1: "instanceof",
  0xb2: "istype",
  0xb3: "istypelate",
  0xb4: "in",
  0xc0: "increment_i",
  0xc1: "decrement_i",
  0xc2: "inclocal_i",
  0xc3: "declocal_i",
  0xc4: "negate_i",
  0xc5: "add_i",
  0xc6: "subtract_i",
  0xc7: "multiply_i",
  0xd0: "getlocal0",
  0xd1: "getlocal1",
  0xd2: "getlocal2",
  0xd3: "getlocal3",
  0xd4: "setlocal0",
  0xd5: "setlocal1",
  0xd6: "setlocal2",
  0xd7: "setlocal3",
  0xef: "debug",
  0xf0: "debugline",
  0xf1: "debugfile",
};

function decodeInstruction(code, offset) {
  const op = code[offset];
  const name = opNames[op] || `op_${op.toString(16).padStart(2, "0")}`;

  if (op >= 0xd0 && op <= 0xd7) {
    return { offset, op, name, length: 1, operands: [] };
  }

  if (op === 0x24 || op === 0x65) {
    return { offset, op, name, length: 2, operands: [code[offset + 1]] };
  }

  if (op >= 0x0c && op <= 0x1a) {
    return { offset, op, name, length: 4, operands: [readS24(code, offset + 1)] };
  }

  if (op === 0x10) {
    return { offset, op, name, length: 4, operands: [readS24(code, offset + 1)] };
  }

  if (op === 0x1b) {
    let cursor = offset + 1;
    const defaultOffset = readS24(code, cursor);
    cursor += 3;
    const caseCount = readU30At(code, cursor);
    cursor += caseCount.length;
    const cases = [];
    for (let i = 0; i <= caseCount.value; i += 1) {
      cases.push(readS24(code, cursor));
      cursor += 3;
    }
    return { offset, op, name, length: cursor - offset, operands: [defaultOffset, ...cases] };
  }

  if ([0x04, 0x05, 0x06, 0x08, 0x25, 0x2c, 0x2d, 0x2e, 0x2f, 0x31, 0x40, 0x49, 0x53, 0x55, 0x56, 0x58, 0x59, 0x5a, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0x62, 0x63, 0x66, 0x68, 0x6a, 0x6c, 0x6d, 0x6e, 0x6f, 0x80, 0x85, 0x86, 0x92, 0x94, 0xb2, 0xc2, 0xc3].includes(op)) {
    const operand = readU30At(code, offset + 1);
    return { offset, op, name, length: 1 + operand.length, operands: [operand.value] };
  }

  if ([0x32, 0x43, 0x44, 0x45, 0x46, 0x4a, 0x4c, 0x4e, 0x4f].includes(op)) {
    const decoded = skipU30Operands(code, offset + 1, 2);
    return { offset, op, name, length: 1 + decoded.length, operands: decoded.operands };
  }

  if (op === 0xef) {
    let cursor = offset + 1;
    const debugType = code[cursor];
    cursor += 1;
    const nameIndex = readU30At(code, cursor);
    cursor += nameIndex.length;
    const register = code[cursor];
    cursor += 1;
    const extra = readU30At(code, cursor);
    cursor += extra.length;
    return { offset, op, name, length: cursor - offset, operands: [debugType, nameIndex.value, register, extra.value] };
  }

  if (op === 0xf0) {
    return { offset, op, name, length: 5, operands: [code.readUInt32LE(offset + 1)] };
  }

  if (op === 0xf2) {
    return { offset, op, name, length: 3, operands: [code.readUInt16LE(offset + 1)] };
  }

  return { offset, op, name, length: 1, operands: [] };
}

function buildMethodNames(abc) {
  const names = new Map();
  const add = (methodIndex, value) => {
    if (methodIndex == null || methodIndex < 0) {
      return;
    }
    if (!names.has(methodIndex)) {
      names.set(methodIndex, []);
    }
    if (!names.get(methodIndex).includes(value)) {
      names.get(methodIndex).push(value);
    }
  };

  for (const instance of abc.instances) {
    const className = qname(abc.multinames[instance.name]) || `(class#${instance.name})`;
    add(instance.iinit, `${className}::<init>`);
    const staticInit = abc.classes?.[abc.instances.indexOf(instance)]?.cinit;
    add(staticInit, `${className}::<static>`);
    for (const trait of instance.traits || []) {
      if (trait.method != null) {
        add(trait.method, `${className}::${qname(abc.multinames[trait.name]) || trait.name}`);
      }
    }
    const classTraits = abc.classes?.[abc.instances.indexOf(instance)]?.traits || [];
    for (const trait of classTraits) {
      if (trait.method != null) {
        add(trait.method, `${className}::static::${qname(abc.multinames[trait.name]) || trait.name}`);
      }
    }
  }

  for (let i = 0; i < (abc.scripts || []).length; i += 1) {
    const script = abc.scripts[i];
    add(script.init, `(script#${i})::<init>`);
    for (const trait of script.traits || []) {
      if (trait.method != null) {
        add(trait.method, `(script#${i})::${qname(abc.multinames[trait.name]) || trait.name}`);
      }
    }
  }

  return names;
}

function operandDescription(abc, insn) {
  const [a, b] = insn.operands;
  if (insn.name === "pushstring") {
    return JSON.stringify(abc.strings[a] || "");
  }
  if (["getlex", "getproperty", "setproperty", "initproperty", "findpropstrict", "findproperty", "constructprop", "callproperty", "callpropvoid", "callproplex", "coerce", "astype", "istype"].includes(insn.name)) {
    const first = qname(abc.multinames[a]) || String(a);
    return b == null ? first : `${first}, ${b}`;
  }
  if (["call", "construct", "newarray", "newobject", "applytype"].includes(insn.name)) {
    return String(a ?? "");
  }
  if (["callstatic"].includes(insn.name)) {
    const method = abc.methods[a];
    return `${a}:${method?.name || "(anonymous)"}, ${b}`;
  }
  if (insn.operands.length > 0) {
    return insn.operands.join(", ");
  }
  return "";
}

function disassemble(abc, body, context = 8) {
  const instructions = [];
  let cursor = 0;
  while (cursor < body.code.length) {
    let insn;
    try {
      insn = decodeInstruction(body.code, cursor);
    } catch (error) {
      instructions.push({ offset: cursor, name: `decode_error:${error.message}`, length: 1, operands: [] });
      cursor += 1;
      continue;
    }
    instructions.push(insn);
    cursor += Math.max(1, insn.length);
  }
  return instructions.map((insn) => ({
    offset: insn.offset,
    name: insn.name,
    detail: operandDescription(abc, insn),
  })).slice(0, context);
}

function instructionMatches(abc, insn, queries) {
  if (insn.name === "pushstring") {
    const value = abc.strings[insn.operands[0]] || "";
    return queries.some((query) => value.includes(query));
  }

  if (["getlex", "getproperty", "setproperty", "initproperty", "findpropstrict", "findproperty", "constructprop", "callproperty", "callpropvoid", "callproplex", "coerce", "astype", "istype"].includes(insn.name)) {
    const value = qname(abc.multinames[insn.operands[0]]) || "";
    return queries.some((query) => value.includes(query));
  }

  return false;
}

function findReferences(filePath, queries) {
  const swf = decodeSwf(filePath);
  const results = [];
  for (const tag of findDoAbcTags(swf.body)) {
    const abc = parseAbc(tag.abc);
    const methodNames = buildMethodNames(abc);
    for (const body of abc.methodBodies) {
      const instructions = [];
      let cursor = 0;
      while (cursor < body.code.length) {
        let insn;
        try {
          insn = decodeInstruction(body.code, cursor);
        } catch {
          cursor += 1;
          continue;
        }
        instructions.push(insn);
        cursor += Math.max(1, insn.length);
      }

      const hitIndexes = [];
      for (let i = 0; i < instructions.length; i += 1) {
        if (instructionMatches(abc, instructions[i], queries)) {
          hitIndexes.push(i);
        }
      }

      if (hitIndexes.length === 0) {
        continue;
      }

      const method = abc.methods[body.method];
      const windows = hitIndexes.slice(0, 8).map((hitIndex) => {
        const start = Math.max(0, hitIndex - 8);
        const end = Math.min(instructions.length, hitIndex + 9);
        return instructions.slice(start, end).map((insn) => ({
          offset: insn.offset,
          name: insn.name,
          detail: operandDescription(abc, insn),
        }));
      });

      results.push({
        tag: tag.name,
        methodIndex: body.method,
        methodName: method?.name || "(anonymous)",
        owners: methodNames.get(body.method) || [],
        hitCount: hitIndexes.length,
        windows,
      });
    }
  }
  return results;
}

function main() {
  const filePath = process.argv[2] || path.join("modified", "L4399Main_gamefile.swf");
  const queries = process.argv.slice(3);
  if (queries.length === 0) {
    queries.push(
      "open4399tools_AS3.swf",
      "flash_ctrl_version.xml",
      "游戏初始化中",
      "GameInitC",
      "init4399",
      "Api4399",
      "ApiInterface"
    );
  }
  console.log(JSON.stringify({ filePath, queries, results: findReferences(filePath, queries) }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  buildMethodNames,
  decodeInstruction,
  operandDescription,
  findReferences,
};
