---
name: ingredient-batch-enrichment
description: Verify and enrich a bounded batch of new shared ingredients in the private meals catalogue; use for pending ingredient rows, not recipe URL extraction or production data.
---

# Ingredient Batch Enrichment

Use this skill when newly created rows in the `ingredients` table need identity
verification and catalogue enrichment.

## Boundaries

- Work against local Wrangler/D1 by default. Do not use remote D1, R2, deploys,
  or publish research output unless the user explicitly asks.
- Inspect the existing ingredient creation path before changing data. Reuse the
  `ingredients` schema and the review semantics in `src/index.ts`; do not add a
  second importer or a batch endpoint for a one-off run.
- Do not delete, merge, rename recipes, or alter recipe ingredient JSON as part
  of enrichment. Flag duplicate candidates for review.
- Keep recipe content, product details, source material, reports, and logs
  household-private.

## Workflow

1. Default the target to `enrichment_status = 'pending'`. Include
   `needs_review` or `failed` only when the request names them. Capture the
   exact IDs and a pre-run snapshot before any write.
2. Verify identity and duplicates using the same normalization as the app:
   trim, lowercase, and collapse whitespace. `normalized_name` is unique;
   never silently merge two existing rows.
3. Enrich only from supplied evidence or an authoritative source. Do not infer
   storage or food-safety details from memory. Record the evidence and any
   uncertainty in the private run report; the current schema has no provenance
   column.
4. Use the existing vocabularies where applicable:
   - category: `fruit`, `vegetable`, `meat`, `poultry`, `fish`, `seafood`,
     `dairy`, `egg`, `grain`, `herb`, `spice`, `staple`, `condiment`,
     `prepared`
   - default unit: `g`, `kg`, `mL`, `L`, `whole`, `bunch`, `packet`, `cube`
   - storage location: `pantry`, `refrigerator`, `freezer`
5. Classify each row strictly:
   - `complete`: identity is unique and every populated enrichment value is
     supported; category, default unit, and storage location are verified.
   - `needs_review`: a value is unknown, conflicting, ambiguous, or a duplicate
     is possible. Preserve the row and write a short question to
     `enrichment_notes`.
   - `failed`: a fetch, parse, database, or write error prevented a reliable
     result. Do not call it complete.
   - `pending`: untouched.
6. If writes are requested, use parameterized local D1 updates keyed by exact
   `id`. Preserve `created_at`, `review_feedback`, and unrelated fields; update
   `updated_at` and set `enriched_at` only for `complete`. Keep the batch
   bounded and stop on an unexpected schema or write error.
7. Read back every targeted ID and report counts for complete, needs review,
   failed, and untouched rows. Check that names remain unique and that no
   unrelated rows changed. For unattended work, write stdout, stderr, status,
   and the final report to a private log path and print that path.

## Handoff checks

Run the relevant local checks before handoff:

```sh
node .agents/skills/recipe-import/scripts/import-recipe.cjs --self-test
npm run check
```

If the application or migrations changed, also apply migrations locally,
exercise the local Worker, and read back the affected D1 rows. Do not describe
an unverified or remote result as complete.
