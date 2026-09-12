---
name: woolworths-ingredient-enrichment
description: Match local household ingredients to Woolworths Australia products and record a verified product link and purchase pack amount; use for ingredient catalogue enrichment, not recipe import or production data.
---

# Woolworths Ingredient Enrichment

Use this skill when an ingredient in the private meals catalogue needs a
Woolworths product link and the amount normally purchased, such as `1 kg`
carrots or `800 mL` passata.

## Boundaries

- Search and open product pages only on `https://www.woolworths.com.au/`.
- Store the canonical product URL, not a search URL, shopping-list URL, or
  tracking-heavy result URL. Valid product pages use the
  `/shop/productdetails/<id>` path.
- Treat Woolworths product names and pack sizes as the evidence. Do not infer
  a pack amount from the recipe quantity, and do not record price, stock, or
  promotions unless explicitly requested.
- Keep recipe cooking quantities (`default_unit` and recipe ingredient JSON)
  separate from the purchase amount (`purchase_quantity` and `purchase_unit`).
- Work against local Wrangler/D1 by default. Do not use remote D1, R2, deploys,
  or publish household data unless explicitly requested.
- Keep ingredient names, product choices, links, and reports private.

## Workflow

1. Capture the exact ingredient IDs and a pre-run snapshot. Default to rows
   with `enrichment_status = 'pending'`; include other statuses only when the
   request names them.
2. Search Woolworths with the ingredient name and inspect a canonical product
   page. Prefer a straightforward product that matches the ingredient rather
   than a flavoured, composite, or substitute product. Preserve an existing
   link unless the user asks to replace it.
3. Read the product title or pack description and record the purchased amount
   as a number plus one unit: `g`, `kg`, `mL`, `L`, `each`, `bunch`, `packet`,
   `tin`, `jar`, or `bottle`. Normalize `ml` to `mL`; do not convert units or
   guess variable-weight produce.
4. If no product is a clear match, the page has no reliable pack amount, or
   multiple products are equally reasonable, leave the product fields
   unchanged and mark the row `needs_review` with a short note naming the
   ambiguity.
5. For a confident match, update only the targeted local ingredient row with
   `woolworths_url`, `purchase_quantity`, and `purchase_unit`. Use the existing
   ingredient review path or a parameterized local D1 update; never paste
   unescaped search text into SQL. Do not change recipe quantities.
6. Read back every targeted row. Report the selected product URL and purchase
   amount, plus counts for complete, needs review, failed, and untouched rows.
   Stop on an unexpected schema or write error. For unattended work, keep
   stdout, stderr, status, and the final report in a private log and print the
   log path.

## Handoff checks

Run the local checks before handoff:

```sh
node .agents/skills/recipe-import/scripts/import-recipe.cjs --self-test
npm run check
```

If the schema or Worker changed, apply migrations locally, exercise the local
Worker, and read back the affected D1 rows. Do not describe an unverified or
remote result as complete.
