const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const projectRoot = path.resolve(__dirname, "..");
const outerPath = path.join(projectRoot, "modified", "xfbbv451.swf");
const innerPath = path.join(projectRoot, "modified", "L4399Main_gamefile.swf");
const localOuterPath = path.join(projectRoot, "modified", "local", "xfbbv451.swf");
const backupPath = path.join(projectRoot, "modified", "xfbbv451.before-embed-gamefile-patch.swf");
const targetBinaryId = 13;

function decodeSwf(filePath) {
  const input = fs.readFileSync(filePath);
  const signature = input.subarray(0, 3).toString("ascii");
  const version = input[3];
  const declaredLength = input.readUInt32LE(4);

  if (signature === "FWS") {
    return {
      signature,
      version,
      declaredLength,
      body: Buffer.from(input.subarray(8)),
    };
  }

  if (signature === "CWS") {
    return {
      signature,
      version,
      declaredLength,
      body: zlib.inflateSync(input.subarray(8)),
    };
  }

  throw new Error(`Unsupported SWF signature: ${signature}`);
}

function encodeSwf({ version, body }) {
  const header = Buffer.alloc(8);
  header.write("CWS", 0, "ascii");
  header[3] = version;
  header.writeUInt32LE(body.length + 8, 4);
  return Buffer.concat([header, zlib.deflateSync(body)]);
}

function firstTagOffset(body) {
  const rectBits = body[0] >> 3;
  const rectBytes = Math.ceil((5 + rectBits * 4) / 8);
  return rectBytes + 4;
}

function encodeTag(code, payload) {
  if (payload.length < 0x3f) {
    const header = Buffer.alloc(2);
    header.writeUInt16LE((code << 6) | payload.length, 0);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE((code << 6) | 0x3f, 0);
  header.writeUInt32LE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function patch() {
  const outerSourcePath = fs.existsSync(backupPath) ? backupPath : outerPath;
  const outer = decodeSwf(outerSourcePath);
  const innerBytes = fs.readFileSync(innerPath);
  const start = firstTagOffset(outer.body);
  const chunks = [outer.body.subarray(0, start)];
  const replacements = [];

  let offset = start;
  while (offset + 2 <= outer.body.length) {
    const tagStart = offset;
    const header = outer.body.readUInt16LE(offset);
    offset += 2;

    const code = header >> 6;
    let length = header & 0x3f;
    if (length === 0x3f) {
      length = outer.body.readUInt32LE(offset);
      offset += 4;
    }

    const payloadStart = offset;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > outer.body.length) {
      throw new Error(`Tag ${code} at ${tagStart} exceeds SWF body length`);
    }

    const payload = outer.body.subarray(payloadStart, payloadEnd);
    if (code === 87 && payload.length >= 6 && payload.readUInt16LE(0) === targetBinaryId) {
      const replacementPayload = Buffer.concat([payload.subarray(0, 6), innerBytes]);
      chunks.push(encodeTag(code, replacementPayload));
      replacements.push({
        id: targetBinaryId,
        oldPayloadLength: payload.length,
        newPayloadLength: replacementPayload.length,
        oldDataLength: payload.length - 6,
        newDataLength: innerBytes.length,
      });
    } else {
      chunks.push(outer.body.subarray(tagStart, payloadEnd));
    }

    offset = payloadEnd;
    if (code === 0) {
      break;
    }
  }

  if (offset < outer.body.length) {
    chunks.push(outer.body.subarray(offset));
  }

  if (replacements.length !== 1) {
    throw new Error(`Expected one DefineBinaryData replacement for id ${targetBinaryId}, found ${replacements.length}`);
  }

  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(outerPath, backupPath);
  }

  const patched = encodeSwf({ version: outer.version, body: Buffer.concat(chunks) });
  fs.writeFileSync(outerPath, patched);
  fs.mkdirSync(path.dirname(localOuterPath), { recursive: true });
  fs.copyFileSync(outerPath, localOuterPath);

  return {
    patched: true,
    outerPath,
    outerSourcePath,
    innerPath,
    localOuterPath,
    backupPath,
    replacements,
    outputSize: fs.statSync(outerPath).size,
  };
}

function main() {
  console.log(JSON.stringify(patch(), null, 2));
}

if (require.main === module) {
  main();
}
