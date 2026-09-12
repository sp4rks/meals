#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ONETSP_URL = "https://onetsp.com";
const EXIT_CODES = { READY: 0, NEEDS_REVIEW: 3, FAILED: 6, BLOCKED: 5 };
const MOJIBAKE_REPLACEMENTS = [
  ["\u00c2\u00a0", " "], ["\u00c2\u00b0", "°"], ["\u00c2\u00ba", "º"],
  ["\u00c2\u00bc", "¼"], ["\u00c2\u00bd", "½"], ["\u00c2\u00be", "¾"],
  ["\u00c3\u00a9", "é"], ["\u00c3\u00b1", "ñ"],
  ["\u00e2\u20ac\u2122", "’"], ["\u00e2\u20ac\u201c", "–"], ["\u00e2\u20ac\u201d", "—"],
  ["\u00e2\u20ac\u00a6", "…"], ["\u00e2\u20ac\u0153", "“"], ["\u00e2\u20ac\u009d", "”"], ["\u00e2\u20ac\u00a8", " "],
  ["\u00e2\u2026\u201c", "⅓"], ["\u00e2\u2026\u201d", "⅔"], ["\u00e2\u2026\u203a", "⅛"]
];

class ImportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseArgs(argv) {
  const args = { selfTest: argv.includes("--self-test") };
  for (let index = 0; index < argv.length; index += 1) {
    if (["--zip", "--directory", "--file", "--output"].includes(argv[index])) {
      args[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function clean(value) {
  return MOJIBAKE_REPLACEMENTS.reduce((result, [from, to]) => result.split(from).join(to), value.replace(/\r/g, "")).trim();
}

function sectionName(value) {
  return clean(value).toUpperCase().replace(/[:#]/g, "");
}

function splitTags(value) {
  return clean(value)
    .split(/[,;]\s*|\s+\|\s+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function sourceUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return ONETSP_URL;
    return url.toString();
  } catch {
    return ONETSP_URL;
  }
}

function parseDuration(value) {
  const text = clean(value);
  const range = text.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*(hours?|hrs?|minutes?|mins?)/i);
  if (range) {
    const factor = /hours?|hrs?/i.test(range[3]) ? 60 : 1;
    return { from: Number(range[1]) * factor, to: Number(range[2]) * factor, unit: "minutes" };
  }
  const parts = [...text.matchAll(/(\d+(?:\s*\/\s*\d+)?(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)/gi)];
  if (!parts.length) return null;
  const minutes = parts.reduce((total, part) => {
    const amount = part[1].includes("/")
      ? (() => { const [numerator, denominator] = part[1].split("/").map((part) => Number(part.trim())); return denominator ? numerator / denominator : 0; })()
      : Number(part[1]);
    return total + amount * (/hours?|hrs?/i.test(part[2]) ? 60 : 1);
  }, 0);
  return { from: minutes, to: minutes, unit: "minutes" };
}

function stableId(fileName, text) {
  const stem = path.basename(fileName, path.extname(fileName)).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return stem || "recipe-" + crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function parseRecipeText(text, fileName = "recipe.txt") {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const header = lines.findIndex((line) => /^\s*-{5,}\s*Recipe exported from One tsp\./i.test(line));
  if (header < 0) throw new ImportError("FAILED", fileName + " is not a One tsp. export file");

  const footer = lines.findIndex((line, index) => index > header && /^\s*-{5,}\s*Recipe end/i.test(line));
  const content = lines.slice(header + 1, footer < 0 ? lines.length : footer);
  let index = 0;
  while (!clean(content[index] || "")) index += 1;
  const title = clean(content[index] || "");
  index += 1;

  const metadata = { url: "", source: "", yield: "", prepTime: "", cookingTime: "", totalTime: "", notes: [] };
  const description = [];
  const ingredients = [];
  const directions = [];
  const tags = [];
  let section = "description";
  const metadataFields = {
    "URL": "url",
    "SOURCE": "source",
    "YIELD": "yield",
    "PREP TIME": "prepTime",
    "COOKING TIME": "cookingTime",
    "TOTAL TIME": "totalTime"
  };

  for (; index < content.length; index += 1) {
    const raw = content[index];
    const line = clean(raw);
    const normalized = sectionName(raw);
    if (!line) continue;
    if (normalized === "INGREDIENTS") {
      section = "ingredients";
      continue;
    }
    if (["DIRECTIONS", "INSTRUCTIONS"].includes(normalized)) {
      section = "directions";
      continue;
    }
    if (["NOTES", "NOTE"].includes(normalized)) {
      section = "notes";
      continue;
    }
    if (["CATEGORIES", "TAGS"].includes(normalized)) {
      section = "tags";
      continue;
    }

    const field = line.match(/^(URL|Source|Yield|Prep time|Cooking time|Total time):\s*(.*)$/i);
    if (field) {
      metadata[metadataFields[field[1].toUpperCase()]] = field[2].trim();
      continue;
    }
    if (/^Categories|^Tags/i.test(line)) {
      tags.push(...splitTags(line.replace(/^(Categories|Tags):\s*/i, "")));
      continue;
    }
    const note = line.match(/^Notes?:\s*(.*)$/i);
    if (note) {
      if (note[1]) metadata.notes.push(note[1]);
      section = "notes";
      continue;
    }

    if (section === "ingredients") ingredients.push({ text: line, kind: "unknown", allergens: [] });
    else if (section === "directions") directions.push({ title: "", text: line.replace(/^(?:\d+[.)]|[-*])\s*/, "") });
    else if (section === "notes") metadata.notes.push(line);
    else if (section === "tags") tags.push(...splitTags(line));
    else description.push(line);
  }

  const warnings = [];
  if (!title) warnings.push("title is missing");
  if (!ingredients.length) warnings.push("no ingredients were extracted");
  if (!directions.length) warnings.push("no directions were extracted");

  return {
    schemaVersion: 1,
    status: warnings.length ? "NEEDS_REVIEW" : "READY",
    source: {
      site: "onetsp",
      url: sourceUrl(metadata.url),
      id: stableId(fileName, text),
      exportFile: path.basename(fileName),
      retrievedAt: new Date().toISOString()
    },
    recipe: {
      title,
      subtitle: "",
      description: description.join("\n"),
      duration: parseDuration(metadata.totalTime),
      difficulty: "",
      tags: [...new Set(tags)],
      macros: { perServing: { kcal: null, protein: null, carbs: null, fat: null } },
      allergens: [],
      ingredients,
      steps: directions,
      utensils: [],
      images: [],
      metadata
    },
    warnings
  };
}

async function readZipEntries(zipPath) {
  // ponytail: uses the host unzip binary; add a pure-JS reader only if portability requires it.
  zipPath = path.resolve(zipPath);
  let listing;
  try {
    listing = await execFileAsync("unzip", ["-Z1", zipPath], { maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw new ImportError("BLOCKED", "One tsp. export ZIP could not be read: " + error.message);
  }
  const entries = listing.stdout.split("\n").map((entry) => entry.trim()).filter((entry) => entry && !entry.endsWith("/") && /\.txt$/i.test(entry));
  if (!entries.length) throw new ImportError("FAILED", "One tsp. export ZIP contains no recipe text files");

  const candidates = [];
  for (const entry of entries) {
    let text;
    try {
      text = (await execFileAsync("unzip", ["-p", zipPath, entry], { maxBuffer: 8 * 1024 * 1024 })).stdout;
    } catch (error) {
      throw new ImportError("BLOCKED", "One tsp. export entry could not be read: " + entry + ": " + error.message);
    }
    if (/^\s*-{5,}\s*Recipe exported from One tsp\./im.test(text)) candidates.push(parseRecipeText(text, entry));
  }
  if (!candidates.length) throw new ImportError("FAILED", "One tsp. export ZIP contains no recognized recipe files");
  return candidates;
}

async function readDirectoryEntries(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new ImportError("BLOCKED", "One tsp. export directory could not be read: " + error.message);
  }
  const files = entries.filter((entry) => entry.isFile() && /\.txt$/i.test(entry.name));
  const candidates = [];
  for (const entry of files) {
    const fileName = path.join(directory, entry.name);
    const text = await fs.readFile(fileName, "utf8");
    if (/^\s*-{5,}\s*Recipe exported from One tsp\./im.test(text)) candidates.push(parseRecipeText(text, entry.name));
  }
  if (!candidates.length) throw new ImportError("FAILED", "One tsp. export directory contains no recognized recipe files");
  return candidates;
}

async function writeOutput(value, outputPath) {
  const json = JSON.stringify(value, null, 2) + "\n";
  if (outputPath) await fs.writeFile(outputPath, json, "utf8");
  else process.stdout.write(json);
}

const SAMPLE = `----- Recipe exported from One tsp. (ver 0.1)

Mom's Granola

Home-made granola, served with milk.

URL: https://southsidekitchen.com/apple-pie-cocktail/#recipe
Source: Family recipe
Yield: 7-1/2 Cups
Prep time: 20 minutes
Cooking time: 20 minutes
Total time: 50 minutes
Categories: Breakfast, Pantry
Notes: Keep in an airtight container.

INGREDIENTS

4 C quick oats
1 tsp. cinnamon

DIRECTIONS

1. Mix everything together.
2. Bake until golden.

----- Recipe end`;

function selfTest() {
  const candidate = parseRecipeText(SAMPLE, "moms-granola.txt");
  assert.equal(candidate.status, "READY");
  assert.equal(candidate.source.site, "onetsp");
  assert.equal(candidate.source.url, "https://southsidekitchen.com/apple-pie-cocktail/#recipe");
  assert.equal(candidate.recipe.title, "Mom's Granola");
  assert.equal(candidate.recipe.ingredients.length, 2);
  assert.equal(candidate.recipe.steps[0].text, "Mix everything together.");
  assert.deepEqual(candidate.recipe.duration, { from: 50, to: 50, unit: "minutes" });
  assert.deepEqual(parseDuration("1/2 hour"), { from: 30, to: 30, unit: "minutes" });
  assert.deepEqual(parseDuration("20-30 minutes"), { from: 20, to: 30, unit: "minutes" });
  assert.equal(candidate.recipe.metadata.yield, "7-1/2 Cups");
  assert.deepEqual(candidate.recipe.tags, ["Breakfast", "Pantry"]);
  assert.deepEqual(candidate.recipe.metadata.notes, ["Keep in an airtight container."]);
  assert.equal(parseRecipeText("----- Recipe exported from One tsp. (ver 0.1)\n\nTitle\n\nINGREDIENTS", "incomplete.txt").status, "NEEDS_REVIEW");
  console.log("onetsp-import self-test: ok");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
  const inputs = [args.zip, args.directory, args.file].filter(Boolean);
  if (inputs.length !== 1) throw new ImportError("FAILED", "usage: --zip <export.zip> | --directory <export-dir> | --file <recipe.txt> [--output <path>]");

  const candidates = args.zip
    ? await readZipEntries(args.zip)
    : args.directory
      ? await readDirectoryEntries(args.directory)
    : [parseRecipeText(await fs.readFile(args.file, "utf8"), args.file)];
  await writeOutput(args.file ? candidates[0] : candidates, args.output);
  process.exitCode = candidates.some((candidate) => candidate.status === "NEEDS_REVIEW") ? EXIT_CODES.NEEDS_REVIEW : EXIT_CODES.READY;
}

main().catch(async (error) => {
  await writeOutput({ schemaVersion: 1, status: error.status || "FAILED", source: { site: "onetsp", url: ONETSP_URL }, recipe: null, warnings: [error.message] });
  process.exitCode = EXIT_CODES[error.status] || EXIT_CODES.FAILED;
});

module.exports = { ImportError, parseDuration, parseRecipeText };
