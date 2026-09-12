---
name: onetsp-import
description: "Import recipes from a signed-in One tsp. account export into reviewable normalized candidates; use for private onetsp.com recipe data."
---

# One tsp Import

One tsp. recipe collections are private. Use the user's signed-in browser session
only to obtain the account backup; never ask for, store, or log their password,
cookies, or session headers.

1. Have the user sign in at <https://onetsp.com/account/signin> in their browser,
   then use the account/settings page's recipe backup or export control. Keep the
   downloaded ZIP private.
2. Parse the downloaded export before using AI:

       node .agents/skills/onetsp-import/scripts/import-onetsp.cjs \
         --zip "/path/to/onetsp-recipes.zip" \
         --output "/tmp/onetsp-candidates.json"

   An extracted backup directory can be parsed with `--directory`, and a single
   exported recipe text file with `--file`.
3. Review every emitted candidate and its warnings. Do not fill missing values
   from memory or from an unauthenticated fetch. Only save candidates after the
   normal recipe review/ingest step; this skill does not write D1 or R2.

The parser uses One tsp.'s custom export format and emits the meals candidate
shape. It keeps One tsp. metadata such as source, yield, prep time, cooking
time, total time, and notes under `recipe.metadata`; One tsp. exports do not
include recipe photos. Run the local check with:

    node .agents/skills/onetsp-import/scripts/import-onetsp.cjs --self-test

Do not treat a One tsp. recipe URL as anonymously fetchable. If a user supplies
one, open it in their signed-in session and obtain an export or saved page from
that session first.
