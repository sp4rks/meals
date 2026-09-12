const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const {
  ImportError,
  extract: extractMarleySpoon,
  isMarleyHost,
  normalizeIngredient,
  parseRecipeUrl
} = require("./sources/marley-spoon.cjs");

const EXIT_CODES = {
  READY: 0,
  NEEDS_REVIEW: 3,
  UNSUPPORTED: 4,
  BLOCKED: 5,
  FAILED: 6
};

function parseArgs(argv) {
  const args = { selfTest: argv.includes("--self-test") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--url" || argv[index] === "--output") {
      args[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function normalize(candidate) {
  const recipe = candidate.recipe || {};
  const warnings = [];
  if (!recipe.title) warnings.push("title is missing");
  if (!recipe.ingredients?.length) warnings.push("no ingredients were extracted");
  if (!recipe.steps?.length) warnings.push("no steps were extracted");
  return {
    schemaVersion: 1,
    status: warnings.length ? "NEEDS_REVIEW" : "READY",
    source: candidate.source,
    recipe,
    warnings
  };
}

async function writeCandidate(candidate, outputPath) {
  const json = JSON.stringify(candidate, null, 2) + "\n";
  if (outputPath) await fs.writeFile(outputPath, json, "utf8");
  else process.stdout.write(json);
}

function selfTest() {
  const parsed = parseRecipeUrl(
    "https://marleyspoon.com.au/menu/657515-sesame-chicken-katsu?week=current#recipe"
  );
  assert.equal(parsed.recipeId, "657515");
  assert.equal(parsed.url.toString(), "https://marleyspoon.com.au/menu/657515-sesame-chicken-katsu");
  assert.equal(isMarleyHost("marleyspoon.com.au"), true);
  assert.equal(isMarleyHost("example.com"), false);

  assert.deepEqual(normalizeIngredient("(S) Japanese rice"), {
    text: "(S) Japanese rice",
    name: "Japanese rice",
    quantity: 1,
    unit: "packet",
    size: "S"
  });
  assert.deepEqual(normalizeIngredient("(S) onion"), {
    text: "(S) onion",
    name: "onion",
    quantity: 1,
    unit: "whole",
    size: "S"
  });
  assert.deepEqual(normalizeIngredient("2 x (S) sesame oil"), {
    text: "2 x (S) sesame oil",
    name: "sesame oil",
    quantity: 2,
    unit: "packet",
    size: "S"
  });
  assert.deepEqual(normalizeIngredient("1½ tbs olive oil"), {
    text: "1½ tbs olive oil",
    name: "olive oil",
    quantity: 1.5,
    unit: "tbsp",
    size: null
  });
  assert.deepEqual(normalizeIngredient("180ml (¾ cup) boiling water"), {
    text: "180ml (¾ cup) boiling water",
    name: "boiling water",
    quantity: 180,
    unit: "mL",
    size: null
  });
  assert.deepEqual(normalizeIngredient("2P chicken breast fillet"), {
    text: "2P chicken breast fillet",
    name: "chicken breast fillet",
    quantity: 2,
    unit: "portion",
    size: null
  });

  const ready = normalize({
    source: { site: "test", url: parsed.url.toString(), id: "1" },
    recipe: {
      title: "Soup",
      ingredients: [{ text: "1 carrot" }],
      steps: [{ title: "Cook", text: "Cook it" }]
    }
  });
  assert.equal(ready.status, "READY");
  assert.equal(normalize({ recipe: { title: "Soup" }, source: ready.source }).status, "NEEDS_REVIEW");
  console.log("recipe-import self-test: ok");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
  if (!args.url) throw new ImportError("FAILED", "usage: --url <recipe-detail-url> [--output <path>]");

  let parsed;
  try {
    parsed = parseRecipeUrl(args.url);
  } catch (error) {
    const candidate = { schemaVersion: 1, status: error.status || "FAILED", source: { url: args.url }, recipe: null, warnings: [error.message] };
    await writeCandidate(candidate, args.output);
    process.exitCode = EXIT_CODES[candidate.status] || 6;
    return;
  }

  let candidate;
  try {
    candidate = normalize(await extractMarleySpoon(parsed.url));
  } catch (error) {
    candidate = {
      schemaVersion: 1,
      status: error.status || "FAILED",
      source: { site: "marley-spoon", url: parsed.url.toString(), id: parsed.recipeId },
      recipe: null,
      warnings: [error.message]
    };
  }
  await writeCandidate(candidate, args.output);
  process.exitCode = EXIT_CODES[candidate.status] || 6;
}

main().catch(async (error) => {
  const candidate = { schemaVersion: 1, status: "FAILED", source: {}, recipe: null, warnings: [error.message] };
  await writeCandidate(candidate);
  process.exitCode = EXIT_CODES.FAILED;
});
