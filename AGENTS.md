# meals

Private household recipe box. This is a small Cloudflare Worker application:
Hono serves the HTML UI, D1 stores recipe records, R2 stores imported recipe
images, and `design/` contains the static product prototype and CSS.

## Local development

Use the local Wrangler bindings by default:

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Useful checks:

```sh
node .agents/skills/recipe-import/scripts/import-recipe.cjs --self-test
npm run check
curl http://127.0.0.1:8787/health
```

`npm run check` is a Wrangler deploy dry-run; it does not publish the Worker.
Do not deploy or run remote D1/R2 commands unless explicitly requested.

## Runtime shape

- `src/index.ts` is the Worker entry point and uses Hono.
- `wrangler.jsonc` binds D1 as `DB`, R2 as `MEDIA`, and serves `design/` as
  assets.
- `GET /` lists only recipes whose status is `ready`.
- `POST /` validates and extracts a recipe URL, copies its first image to R2,
  upserts the normalized recipe into D1, and removes the copied object if the
  database save fails.
- `GET /media/*` serves stored recipe images after validating the object key.
- `GET /health` is the basic liveness check.

Keep the current simple server-rendered HTML and plain CSS approach. Reuse the
existing escaping, import, D1, and R2 helpers before adding new abstractions or
dependencies.

## Design prototype

- Treat `design/` as a dependency-free static prototype for household use;
  keep it usable by opening `design/index.html` directly and do not add a
  framework, backend, authentication, or JavaScript application for prototype
  work.
- Keep the visual direction modern and cozy, with warm restrained styling and
  only occasional subtle “chaos” accents. Prefer domestic, practical flows
  over restaurant, enterprise, or SaaS-dashboard conventions.
- Preserve reusable building blocks for the dashboard, recipe library,
  complete add/edit recipe form, meal planner, shopping list, and
  pantry/leftovers, including loading, empty, error, validation, dialog, and
  toast states.
- Keep design tokens and components in `design/tokens.css` and
  `design/components.css`, with reusable markup in `design/index.html` when a
  static design deliverable is requested.
- Treat mobile recipe consumption as a first-class requirement at 320–430px:
  use a readable single-column layout, clear ingredient quantities, comfortable
  instruction spacing, naturally reflowing images/content/actions, minimum
  44px touch targets, no unnecessary horizontal scrolling, mobile navigation,
  stacked forms, and phone-friendly meal planning and shopping lists.

## Recipe imports

The canonical import logic lives in
`.agents/skills/recipe-import/scripts/sources/`. It currently supports HTTPS
Marley Spoon Australia URLs under `/menu/` and `/archive/`.

For a manual import, run the deterministic extractor first:

```sh
node .agents/skills/recipe-import/scripts/import-recipe.cjs \
  --url "https://marleyspoon.com.au/menu/<recipe-url>"
```

Do not invent missing recipe values or bypass the adapter with ad hoc parsing.
Preserve the strict `ready` / `needs_review` distinction. Add a new source as
an adapter under `scripts/sources/` and update the adapter checks; do not add a
second import workflow unless the source genuinely needs one.

## Data and changes

- Add schema changes as a new ordered migration in `migrations/`; do not edit
  an applied migration.
- Keep source image URLs in `source_image_url`; stored media belongs under the
  existing `recipes/<source-site>/<source-id>` R2 key shape.
- Treat recipe content and imported images as household-private. Do not make
  them public or add telemetry that contains recipe data without an explicit
  request.
- Validate all user-supplied URLs and preserve HTTPS-only image fetching.
- `worker-configuration.d.ts` is Wrangler-generated; regenerate it rather than
  hand-maintaining binding types.

Before handing off a change, run the relevant import self-test and
`npm run check`; for runtime changes, also exercise the local Worker and read
back the affected D1/R2 state.
