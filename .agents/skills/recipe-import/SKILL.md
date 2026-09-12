---
name: recipe-import
description: "Import a recipe from a user-supplied URL into a reviewable normalized candidate with deterministic source adapters; use when a pasted recipe URL needs extraction."
---

# Recipe Import

Run the script before using AI:

    node .agents/skills/recipe-import/scripts/import-recipe.cjs --url "<recipe-detail-url>"

Use --output <path> to save the candidate. Use --self-test for the local check.

The script validates the URL, selects the source adapter, fetches the recipe,
normalizes it, and emits JSON. It currently supports Marley Spoon Australia
recipe detail URLs under /menu/ or /archive/.

Statuses are strict:

- READY: required recipe fields were extracted.
- NEEDS_REVIEW: the candidate has missing or ambiguous fields.
- UNSUPPORTED: no adapter owns the hostname or URL shape.
- BLOCKED: the source could not be fetched.
- FAILED: the source response or schema could not be parsed.

Do not invent missing values. AI may only clean or classify evidence already
present in the candidate; it must not browse the source or fill gaps from
memory. Always show the candidate and source URL for user review before saving
to D1. The web app may use the same deterministic adapter to upload the
candidate image to its bound R2 bucket and upsert the candidate into D1; the
CLI itself remains extraction-only.

Keep future sites as adapters under scripts/sources/. Add another skill only
if a source needs a genuinely different workflow, such as authenticated
interactive browsing.
