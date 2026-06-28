const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const file = process.argv[2] || path.join("original", "xfbbv451.swf");
const input = fs.readFileSync(file);
const signature = input.subarray(0, 3).toString("ascii");
const version = input[3];
const declaredLength = input.readUInt32LE(4);

let body = input.subarray(8);
if (signature === "CWS") {
  body = zlib.inflateSync(body);
}

const combined = Buffer.concat([input.subarray(0, 8), body]);
const text = combined.toString("latin1").replace(/[^\x20-\x7e]+/g, "\n");
const patterns = [
  /https?:\/\/[^\s"'<>]+/gi,
  /[A-Za-z0-9_./:-]+\.(?:swf|xml|json|txt|amf|php|asp|aspx|jpg|jpeg|png|gif|mp3|dat|bin)/gi,
  /[A-Za-z0-9_./:-]*(?:item|prop|equip|goods|shop|bag|role|login|4399|server|api)[A-Za-z0-9_./:-]*/gi,
];
const hits = new Set();
for (const pattern of patterns) {
  for (const match of text.matchAll(pattern)) {
    hits.add(match[0]);
  }
}

console.log({
  file,
  signature,
  version,
  compressedSize: input.length,
  declaredLength,
  inflatedSize: combined.length,
  hitCount: hits.size,
});

for (const hit of [...hits].slice(0, 300)) {
  console.log(hit);
}
