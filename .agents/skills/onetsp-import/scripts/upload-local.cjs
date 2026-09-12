#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DB_DIRECTORY = path.resolve(".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const REQUIRED_COLUMNS = [
  "id", "source", "source_id", "source_url", "title", "subtitle", "description",
  "cook_time_from", "cook_time_to", "cook_time_unit", "difficulty", "macros_json",
  "allergens_json", "tags_json", "image_url", "source_image_url", "ingredients_json",
  "steps_json", "status"
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--candidates") {
      args.candidates = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

async function localDatabasePath() {
  const files = (await fs.readdir(DB_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite")
    .map((entry) => path.join(DB_DIRECTORY, entry.name));
  if (files.length !== 1) throw new Error("expected exactly one local D1 database, found " + files.length);
  return files[0];
}

async function readCandidates(fileName) {
  let candidates;
  try {
    candidates = JSON.parse(await fs.readFile(fileName, "utf8"));
  } catch (error) {
    throw new Error("candidate JSON could not be read: " + error.message);
  }
  if (!Array.isArray(candidates) || !candidates.length) throw new Error("candidate JSON must be a non-empty array");

  const ids = new Set();
  const urls = new Set();
  for (const candidate of candidates) {
    if (candidate?.schemaVersion !== 1 || candidate.source?.site !== "onetsp") throw new Error("candidate is not a schemaVersion 1 One tsp. candidate");
    if (!candidate.source.id || ids.has(candidate.source.id)) throw new Error("candidate source IDs must be present and unique");
    if (!candidate.source.url || urls.has(candidate.source.url)) throw new Error("candidate source URLs must be present and unique");
    if (!["READY", "NEEDS_REVIEW"].includes(candidate.status)) throw new Error("candidate status must be READY or NEEDS_REVIEW");
    if (!candidate.recipe || !Array.isArray(candidate.recipe.ingredients) || !Array.isArray(candidate.recipe.steps)) throw new Error("candidate recipe fields are incomplete");
    ids.add(candidate.source.id);
    urls.add(candidate.source.url);
  }
  return candidates;
}

function recipeRows(db, source) {
  return db.prepare("SELECT source, status, COUNT(*) AS count FROM recipes WHERE source = ? GROUP BY source, status ORDER BY status").all(source);
}

function upload(candidates, dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const columns = db.prepare("PRAGMA table_info(recipes)").all().map((row) => row.name);
    if (!REQUIRED_COLUMNS.every((column) => columns.includes(column))) throw new Error("local recipes table does not match the current schema");

    const statement = db.prepare([
      "INSERT INTO recipes (id, source, source_id, source_url, title, subtitle, description, cook_time_from, cook_time_to, cook_time_unit, difficulty, macros_json, allergens_json, tags_json, image_url, source_image_url, ingredients_json, steps_json, status)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT(id) DO UPDATE SET source_url = excluded.source_url, title = excluded.title, subtitle = excluded.subtitle, description = excluded.description, cook_time_from = excluded.cook_time_from, cook_time_to = excluded.cook_time_to, cook_time_unit = excluded.cook_time_unit, difficulty = excluded.difficulty, macros_json = excluded.macros_json, allergens_json = excluded.allergens_json, tags_json = excluded.tags_json, image_url = excluded.image_url, source_image_url = excluded.source_image_url, ingredients_json = excluded.ingredients_json, steps_json = excluded.steps_json, status = excluded.status, updated_at = CURRENT_TIMESTAMP"
    ].join(" "));

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        const recipe = candidate.recipe;
        const duration = recipe.duration || {};
        statement.run(
          "onetsp:" + candidate.source.id,
          "onetsp",
          candidate.source.id,
          candidate.source.url,
          recipe.title || "",
          recipe.subtitle || "",
          recipe.description || "",
          recipe.duration ? duration.from : null,
          recipe.duration ? duration.to : null,
          recipe.duration?.unit || "minutes",
          recipe.difficulty || "",
          JSON.stringify(recipe.macros || { perServing: { kcal: null, protein: null, carbs: null, fat: null } }),
          JSON.stringify(recipe.allergens || []),
          JSON.stringify(recipe.tags || []),
          "",
          "",
          JSON.stringify(recipe.ingredients),
          JSON.stringify(recipe.steps),
          candidate.status === "READY" ? "ready" : "needs_review"
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return recipeRows(db, "onetsp");
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.candidates) throw new Error("usage: --candidates <candidate.json>");
  const candidates = await readCandidates(args.candidates);
  const rows = upload(candidates, await localDatabasePath());
  console.log(JSON.stringify({ uploaded: candidates.length, rows }, null, 2));
}

main().catch((error) => {
  console.error("onetsp local upload failed: " + error.message);
  process.exitCode = 1;
});
