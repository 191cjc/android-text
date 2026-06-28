const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const inputPath = path.join(projectRoot, "assets", "exported", "dataxmlvav447", "binary", "42_DefineBinaryData.bin");
const outputPath = path.join(projectRoot, "public", "pet-list.js");

function textOf(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "u"));
  return match ? match[1].trim() : "";
}

function numberOf(block, tag, fallback = 0) {
  const parsed = Number.parseInt(textOf(block, tag), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractPets(xml) {
  const pets = [];
  const blocks = xml.match(/<宠物>[\s\S]*?<\/宠物>/gu) || [];

  for (const block of blocks) {
    const id = numberOf(block, "ID");
    if (!id) {
      continue;
    }

    pets.push({
      id,
      name: textOf(block, "名字") || `宠物 ${id}`,
      asset: textOf(block, "加载需求文件"),
      quality: numberOf(block, "品质"),
      aptitude: numberOf(block, "资质"),
      species: textOf(block, "品种"),
      frameCount: numberOf(block, "帧数"),
      fusionExp: numberOf(block, "融合经验"),
    });
  }

  pets.sort((a, b) => a.id - b.id);
  return pets;
}

function main() {
  const xml = fs.readFileSync(inputPath, "utf8");
  const pets = extractPets(xml);
  const source = [
    "(function () {",
    `  window.__codexPetList = ${JSON.stringify(pets, null, 2)};`,
    "}());",
    "",
  ].join("\n");

  fs.writeFileSync(outputPath, source, "utf8");
  console.log(JSON.stringify({ inputPath, outputPath, count: pets.length }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  extractPets,
};
