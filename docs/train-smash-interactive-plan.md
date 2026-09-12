# Interactive Train Smash — implementation brief

## Read this first

This is a handoff for an implementation agent working in
`/home/sparks/projects/meals`. Implement the work below in order, using the
existing repository patterns. Read root `AGENTS.md` and any applicable nested
instructions first. Recheck the working tree and migration numbering: other
work may have landed since this document was written.

**The user already has a working Cloudflare Tunnel.** Do not install
cloudflared, create a tunnel, replace tunnel credentials, or redesign the
network. Reuse the existing tunnel. Only identify its route to the agent and
verify the authentication and WebSocket upgrade on that route. A working tunnel
does not by itself establish that this particular service route is configured.

This request produces a plan; it does not itself start implementation or grant
production deployment permission. Once asked to execute it, complete the local
implementation and tests autonomously. Do not pause for routine code/design
choices already settled here. Prepare the production connection configuration
and deployment steps. Apply production changes only when that execution session
explicitly authorizes them. Credentials or remote access missing at cutover must
not prevent completing the local implementation.

## 1. Product outcome and settled decisions

The user can:

1. Open 🚂 Train Smash and enter available ingredients, servings, and dietary needs.
2. Start a generation, see real progress and elapsed time, and cancel it.
3. Leave/reload the page and reconnect to the same job without paying for a second run.
4. Read a complete recipe and request a revision, such as “make it dairy-free”.
5. Revisit the original and revised suggestions independently.
6. As a parent, confirm “We tried it and liked it” and add a suggestion to rotation.

Use the following decisions; do not reopen the architecture unless a real
platform limitation makes a requirement impossible:

| Concern | Decision |
| --- | --- |
| Browser transport | Native WebSocket and a small JSON protocol; no WebRPC framework |
| Browser UI | Existing Hono-rendered HTML and plain CSS plus one small script |
| Edge | Existing Meals Worker authenticates users and mediates origin access |
| Home connectivity | Existing Cloudflare Tunnel; localhost in local development |
| Agent runtime | Existing local Codex CLI/account, streamed with `codex exec --json` |
| SDK decision | No SDK migration in this task; streaming does not require one |
| Model | Explicit `gpt-5.6-luna`, reasoning effort `max` |
| Behaviour | Read `.agents/skills/train-smash/SKILL.md` for every new run |
| Recipe validation | Reuse `src/train-smash.ts` and the existing output schema |
| Origin persistence | Node's built-in SQLite for job state and completed output |
| Recipe persistence | D1 remains authoritative for saved suggestions and rotation |
| Concurrency | One active Codex run per service process; return busy, no waiting queue |
| Permissions | All signed-in users generate; only parents add to rotation |
| Public progress | Lifecycle state and final recipe notes; no raw internal reasoning |

Do not add a framework, a general agent platform, Redis, a broker, a Durable
Object, image generation, or an API-key provider as part of this implementation.
Do not change unrelated recipe imports, household authentication, or existing
recipe edits. Do not assume the model used to execute this brief is the model
that Train Smash should invoke.

## 2. Current code map: inspect these before editing

| File | Current responsibility | Change |
| --- | --- | --- |
| `scripts/dev.mjs` | Starts a localhost HTTP runner and Wrangler; invokes Codex synchronously | Extract service; retain convenient combined dev startup |
| `src/train-smash.ts` | `SmashRecipe`, input and output validation | Reuse; add only shared validation actually needed |
| `scripts/train-smash.schema.json` | Codex final JSON schema | Preserve recipe shape |
| `.agents/skills/train-smash/SKILL.md` | Recipe instructions loaded for each generation | Keep editable; add revision guidance only if necessary |
| `src/index.ts` | Auth middleware, sidebar, `smashPage`, generation, viewing and saving routes | Add socket bridge, status/finalization routes and revised UI |
| `migrations/0012_create_train_smashes.sql` | Completed draft ID, owner, input JSON, recipe JSON, timestamp | Do not edit; add a later migration only for revision parent link |
| `scripts/train-smash.test.mjs` | Validation and real HTTP generate/save tests | Preserve fallback coverage; add interactive integration coverage |
| `design/components.css` | Existing responsive components | Reuse; add scoped progress/conversation styles |
| `design/index.html` | Static prototype | Add static interactive-flow examples, no prototype application JS |
| `README.md` | Local startup and verification instructions | Document service mode, skill reload, connection settings, recovery |
| `wrangler.jsonc` | Worker and local D1/R2 bindings | Avoid inventing remote resource IDs |

Important existing helpers in `src/index.ts`: `requireAuth`, `requireParent`,
`currentUser`, `escapeHtml`, `getSmash`, `listSmashes`, `getRecipe`, and
`saveRecipe`. Read all callers before changing their semantics. `getSmash`
currently allows parents to view other household members' completed drafts.
Preserve that behaviour; active origin jobs should be accessible only to their
owner. A parent may revise an accessible completed draft into a new draft they own.

## 3. Expected file changes

Use this layout unless an existing equivalent is discovered:

- `scripts/train-smash-agent.mjs`: standalone origin HTTP/WebSocket service and
  exported start/stop function usable by `scripts/dev.mjs` and tests.
- `scripts/train-smash-jobs.mjs`: SQLite job transitions and Codex process/event
  handling. Keep this as one concrete module, not a provider abstraction.
- `scripts/dev.mjs`: start the origin through its exported function, pass local
  URL/token to Wrangler, and shut both down cleanly.
- `src/train-smash-protocol.ts`: browser-command and origin-event validation
  shared by Worker and Node where useful. No Node imports in this file.
- `design/train-smash.js`: progressive enhancement for runtime pages only.
  Do not include it from the dependency-free prototype `design/index.html`.
- `scripts/train-smash-agent.test.mjs`: deterministic process/socket tests using
  `node:test` or the current assert style.
- `scripts/train-smash-interactive.test.mjs`: local Worker integration and optional
  real model checks. Consolidate with the existing test if clearer.
- `ops/meals-train-smash.service`: user-service template, no secrets.
- `ops/train-smash.env.example`: names and placeholders, no credentials.
- Next free ordered migration: add nullable `parent_id` referencing
  `train_smashes(id) ON DELETE SET NULL`. Existing drafts remain valid.

Node provides an HTTP server and a WebSocket client, but a complete WebSocket
server needs support. Inspect installed dependencies. If there is no declared
suitable dependency, add `ws` as a direct runtime dependency, using its maintained
server implementation. Do not rely on Wrangler's transitive package or implement
WebSocket framing yourself. Update the lockfile normally.

## 4. Origin service and configuration

The service must run without Wrangler and without a terminal staying open.
Expose `npm run agent` for standalone startup. Keep `npm run dev` working as now,
including forwarded Wrangler arguments and existing `.dev.vars` values.

Service settings:

| Setting | Behaviour |
| --- | --- |
| `TRAIN_SMASH_PORT` | Stable loopback port in standalone mode; default 8792; dev can request port 0 |
| `TRAIN_SMASH_TOKEN` | Required non-empty shared secret in standalone mode; dev generates it |
| `TRAIN_SMASH_STATE_DIR` | Required explicit writable private directory in standalone mode; separate dev directory |
| Model/effort | Explicit CLI arguments; do not silently fall back if unsupported |

Bind `127.0.0.1`, not `0.0.0.0`. The existing tunnel forwards to this loopback
address. Use `process.umask(0o077)` and a private state directory. Keep dev and
production tokens, state directories, and services separate. Use absolute paths
for the skill, schema, executable working directories and systemd configuration.

Routes on the origin, all except liveness requiring `Authorization: Bearer …`:

| Method/path | Purpose |
| --- | --- |
| `GET /health` | Minimal liveness; no local paths, credentials or user data |
| `GET /ready` | Confirm readable skill/schema, writable state, and executable availability; no paid model call |
| `GET /events` with WebSocket upgrade | Receive commands; stream safe snapshots |
| `GET /runs/:id` | Return owner-scoped latest job snapshot for recovery/finalization |
| `POST /generate` | Retain synchronous compatibility for the existing HTML form |

Worker sends `X-Meals-User-Id` from its authenticated session on origin requests
and the upgrade. Origin accepts this header only after validating the shared
secret. Reject missing/invalid owner values; never accept owner identity from
browser messages. Do not forward browser cookies to the origin.

If the existing route is protected by Cloudflare Access, also send its service
credentials from Worker secrets. Support an optional pair of
`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`; fail configuration if only one
is supplied. Send these only to the configured agent origin. Do not follow
redirects carrying credentials to another host. Reuse current Access settings;
do not provision new Access resources without confirmed need and authorization.

Worker settings: preserve `TRAIN_SMASH_URL` as the legacy full `/generate` URL;
derive `/events` and `/runs/:id` through `new URL` against its origin. Document
that agent routes live at the hostname root. If the existing tunnel uses a path
prefix, adapt one URL helper and test it rather than silently dropping the prefix.
Allow plain HTTP only to loopback in local mode; require HTTPS for remote origin.

## 5. Durable job model and transitions

Create the origin SQLite schema in the service, independently of D1 migrations.
Store:

- `id`: server-generated UUID primary key; used later as the D1 draft ID.
- `owner_id`: authenticated user's stable ID, scoped by this service deployment.
- `request_id`: browser-generated UUID; `UNIQUE(owner_id, request_id)`.
- `request_hash`: hash of the normalized command payload.
- `input_json`: original ingredients, servings, preferences and revision context.
- `parent_id`: optional completed D1 draft ID.
- `status`: accepted, running, validating, completed, cancelled, failed.
- `sequence`: increasing integer, persisted with every state transition.
- `recipe_json`: validated output only after successful completion.
- `error_code`: bounded public code; diagnostics stored separately.
- `model`, `skill_digest`, `created_at`, `updated_at`.

Transitions:

```text
accepted → running → validating → completed
accepted/running/validating → cancelled
accepted/running/validating → failed
```

Terminal states cannot transition again. Handle cancel/completion races with
conditional updates or a transaction: whichever terminal transition wins is
final. Never emit success after cancellation. Kill the owned child on timeout or
cancel, escalating to SIGKILL after a short grace period if necessary; do not
kill unrelated Codex processes. Release the busy slot only after the child exits.

On startup, mark unfinished rows failed with `interrupted`. Preserve completed
rows. Never automatically replay a run after restart. Keep terminal jobs for
7 days, document this recovery window, and prune old terminal rows at startup
and run creation; do not delete D1 drafts. Keep only the latest snapshot, not an
unbounded event transcript. That snapshot is sufficient to resume this UI.

Idempotency order matters: look up `(owner_id, request_id)` before checking busy.
If the hash matches, return the same snapshot without running Codex. If it differs,
return `request_conflict`. A new request while another run is active returns
`busy`, creates no row, and starts no child. Serialize acceptance and busy-slot
reservation so concurrent messages cannot launch two processes.

The synchronous `/generate` fallback uses the same job machinery, not a second
Codex implementation. Its internal request is `{requestId, input}` plus the
authenticated owner header, and its successful response is the completed job
snapshot including `runId`, input and recipe. Update the Worker caller and the
origin together; the current legacy response is only recipe JSON. Browser form
actions and their eventual redirect remain unchanged. Include a hidden request UUID in the server-rendered form
so form retries can reuse the accepted run. An existing completed request returns
its result; an existing active request waits for that run, without spawning again.
Give this HTTP path the current bounded timeout and retain inputs on failure.

## 6. Browser commands and safe events

Protocol version is integer `v: 1`. Accept text JSON only; reject malformed JSON,
unknown versions/types, arrays instead of objects, binary frames and oversized
messages. Browser commands are at most 16 KiB; internal messages may be up to
96 KiB to carry a validated previous recipe and bounded revision history.
Enforce limits before expensive parsing and before invoking Codex.

Browser → Worker commands:

```json
{"v":1,"type":"generate","requestId":"UUID","input":{"ingredients":"2 eggs, zucchini, oil","servings":2,"preferences":"vegetarian"}}
{"v":1,"type":"subscribe","runId":"UUID","afterSequence":2}
{"v":1,"type":"cancel","runId":"UUID"}
{"v":1,"type":"revise","requestId":"NEW_UUID","draftId":"UUID","instruction":"Make it dairy-free"}
```

Use `validateSmashInput`; ingredient length 1–4000, servings integer 1–12,
preferences at most 1000. Revision instruction is trimmed, non-empty and at most
1000 characters. Validate all IDs as UUIDs before forwarding. `afterSequence`
is a non-negative safe integer. Do not treat it as proof of authorization.

Worker resolves `draftId` in D1 and builds trusted revision context. The internal
revision command is `{v:1, type:"revise", requestId, input, parentId,
previousRecipe, revisions}`. `revisions` includes the newest instruction and is
bounded as described below. Origin accepts these enriched fields only on the
authenticated server connection; the Worker rejects them in browser messages. Browser
cannot supply prior recipe JSON, owner, parent input, model, skill, or filesystem
paths. Origin validates the enriched request as well. On subscribe, return the
current owner-scoped snapshot even when there are no newer transitions; the
client can deduplicate by sequence. No full event replay is required.

Origin → Worker safe snapshot example:

```json
{"v":1,"type":"snapshot","runId":"UUID","requestId":"UUID","sequence":3,"status":"running","createdAt":"ISO8601","updatedAt":"ISO8601"}
```

A completed origin snapshot adds `recipe`, normalized `input`, and optional
`parentId`. A failed snapshot adds a public `errorCode`. Worker validates these
before use. Worker → browser completion adds `draftId` and `draftUrl` only after
D1 persistence succeeds. The Worker may replace the origin's completed status
with `saving` until persistence finishes. `sequence` always means the origin
sequence; `saving` and browser `completed` may share it. Client deduplication
must use `(runId, sequence, status, draftId)` rather than dropping all same-sequence
messages. Use `sequence` alone only as the reconnect cursor.

Non-job errors:

```json
{"v":1,"type":"error","requestId":"UUID","code":"busy","message":"Another recipe is cooking up. Try again in a moment."}
```

Use fixed public messages for invalid input, busy, forbidden, request_conflict,
not_found, expired, cancelled, timeout, interrupted, agent_unavailable,
invalid_recipe and save_failed. Never send exception text or stderr directly.
Use HTTP statuses before upgrade and protocol errors after upgrade. Do not reveal
whether another user's job exists.

Apply a small per-connection command burst limit (10 commands per 10 seconds)
and an origin owner-connection cap (3). Close idle subscriptions to terminal runs
after 60 seconds. Use heartbeat and bounded reconnects. If buffered socket output
exceeds 256 KiB, close the slow socket; the job survives and can be resumed.
Inspect the actual WebSocket APIs available on Worker and Node rather than
assuming identical backpressure properties; bounded snapshots and closing slow
connections are sufficient for this household workload.

## 7. Codex invocation and progress policy

Read the skill just before each run; hash the exact content used. Keep stdin
prompt delivery, the output-schema path, read-only sandbox, shell tools disabled,
ignore-user-config, ephemeral sessions, and temporary working directories.
Add `--json`, an explicit model and explicit reasoning configuration after
checking the installed CLI supports them. Keep a 150-second model timeout.

Read stdout incrementally as newline-delimited JSON, handling split chunks,
multiple lines per chunk, malformed records, and a bounded partial-line buffer.
Do not wait for `execFile` to buffer all output before reporting progress. Use
`spawn` with argument arrays, never shell interpolation of recipe/user text.

Do not assume event names from memory. Inspect a small real run's documented
JSON events and map only the events needed for lifecycle status. Minimum valid
progress is: request accepted → process started/generating → validating output
→ saving → ready. It is acceptable to have no per-token recipe rendering.

Never forward raw model events, reasoning items, tool calls, system prompts,
credentials, or stderr. Recipe JSON is shown only after validation. If the model
emits user-facing explanatory text, do not treat arbitrary text as safe progress;
for this version use fixed lifecycle labels and validated final `notes`.
Do not fabricate detailed messages like “checking allergens” from elapsed time.

On successful process exit, read the final JSON file, run `validateSmashRecipe`,
and enforce matching servings. Exit success with invalid output is a failure.
Persist the terminal snapshot before publishing it. Always clean job temp files.
Store private diagnostics with run ID and status, never in web assets. Bound
stderr capture and log retention. Print the private log directory on startup.

## 8. Worker bridge, saving and recovery

Add `GET /train-smash/socket` before parameterized Train Smash GET routes.
Authenticate the session and verify exact same Origin before accepting upgrade.
Do not proxy arbitrary URLs or accept credentials in query strings. Validate
browser commands in the Worker; inject owner identity on the origin handshake.

Implement a server-side WebSocket pair/bridge using supported Worker APIs. Handle
errors and close in both directions. Session expiry must not leave indefinite
access: recheck authentication before mutating commands and close on expiry or
revocation. Reconnect authenticates again. Do not depend on one Worker isolate
remaining alive or on in-memory edge state for job ownership or completion.

Add `GET /train-smash/runs/:runId` before `/train-smash/:id`. This authenticates,
fetches the origin snapshot for the current owner, and renders a status page or
redirects to the D1 draft once finalized. It supports reload and no-JS refresh.
Use `Cache-Control: no-store`. A Retry/refresh link must inspect the same job,
not generate a new one. Consider a pending run link on the existing page.

Add `POST /train-smash/:id/revise` for the native revision-form fallback, with
the same session/Origin checks, UUID idempotency field, D1 context lookup and
revision limits as the socket command. Reuse origin job submission and the shared
finalizer; do not implement separate revision prompting in this route.

Put origin-completion → D1 persistence into one reusable helper used by the
socket bridge, the status route, and synchronous form fallback:

1. Validate owner, UUID, input, recipe and parent reference.
2. Insert into `train_smashes` using the run UUID as `id` and
   `ON CONFLICT(id) DO NOTHING`; bind owner from the authenticated session.
3. Read back the row and verify its owner before producing a browser URL.
4. Return the same draft for duplicate completion events, refresh or reconnect.
5. On D1 failure, report `save_failed`, retain the run ID and origin result,
   and allow retrying persistence without another model call.

Canonical input validation returns only ingredients, servings and preferences.
Validate/preserve the optional bounded `revisions` array separately when building
and saving revision context; do not accidentally discard it by reusing the
three-field validator's return value as the entire stored context. Build hashes
from a fixed-key normalized object and ordered arrays, excluding timestamps.

Do not attempt cross-database transactions. The persisted origin result plus
idempotent D1 insert is the recovery mechanism. With no browser connected, the
origin may complete first and D1 finalization may happen on the next visit.
Document this explicitly; do not promise background D1 persistence without a
callback or persistent edge worker.

Keep `/train-smash/:id/save` parent-only and preserve the existing
`saveRecipe(..., keepExisting = true)` behaviour. Completion itself never adds a
recipe to rotation. Double-clicking save must not create duplicates or overwrite
later recipe edits. Generated recipes do not create R2 objects.

## 9. Revision context and versioning

Worker reads the original draft and constructs a new request containing:
original ingredient input, original dietary constraints, previous validated
recipe, parent draft ID, previous revision instructions and latest instruction.
Store this context with the new draft so another revision retains earlier
requests. Use an optional `revisions` array in `input_json`, capped at 10 entries
of at most 1000 characters each. Existing three-field inputs remain valid.

At the cap, ask the user to start a new ingredient request; do not silently drop
dietary constraints. Keep servings fixed within a revision in this version;
a user who needs another serving count can start a new request.

Each revision has a fresh request/run/draft UUID, owned by its requester. Link
it through `parent_id`. Show “Revised from …” with a link, and preserve the parent.
Do not mutate the previous draft or the saved recipe. Model instructions must
retain dietary restrictions; a conflicting revision must not silently waive an
allergy constraint. Avoid endlessly appending a chat transcript: send only the
bounded structured context described here.

## 10. Browser interaction and accessibility

Enhance the existing form with `design/train-smash.js` only on runtime pages:

- Connect on demand; use `wss:` for HTTPS and `ws:` for local HTTP.
- Generate `requestId` before sending. Store request ID, submitted input and run
  ID in sessionStorage scoped to the signed-in user's ID. Do not use persistent
  localStorage for household ingredient history. Preserve pending request data
  until acceptance: if acknowledgement is lost, reconnect can resend the same
  command/request ID safely. Clear on sign-out or user mismatch.
- Disable duplicate submission while accepting/running. Display Cancel once a
  run exists. Reusing an ID retries delivery; clicking explicit “Try again” after
  terminal failure creates a new ID and clearly starts another generation.
- On reconnect, subscribe to the known run; before a run ID was received, resend
  the stored command with the same request ID. Use exponential backoff capped at
  10 seconds, stop after 6 attempts, and show a manual reconnect action.
- On `save_failed`, retry status/finalization using the current run ID, not generate.
- Display accepted, generating, validating, saving, completed, cancelled, failed,
  reconnecting, and offline states. Show elapsed time as elapsed time, not percent
  complete. A short disconnection must not be labelled agent failure.
- On ready, navigate to the existing server-rendered draft page, including its
  revision form. Prefer this to creating a second client-side recipe renderer.
- Render status using `textContent`; do not inject model text through `innerHTML`.
- Use `role="status"`/polite live regions for state changes, not each timer tick.
  Give errors `role="alert"`; retain keyboard focus and labelled controls.
- Keep the native POST form usable when JavaScript is absent. With JS enabled,
  a socket failure must not silently trigger an additional HTTP generation.
- Minimum 44px controls, readable single column at 320–430px, no horizontal scroll.

Update the prototype with matching static form, progress, error, reconnect,
recipe/revision and saved states. Preserve its ability to open directly from disk.

## 11. Test plan and evidence

Use isolated local databases and fake process fixtures for failure cases. Fakes
must be explicit test dependencies (injected spawn function or test harness),
not a remotely selectable mode or an undocumented production environment bypass.
Keep ordinary tests deterministic; optional `--live` uses the real CLI/account.

| Check | Observable pass condition |
| --- | --- |
| Input/protocol | Invalid/oversized frames launch no process; existing validators still pass |
| Idempotency | Same request ID/payload launches once, including lost acknowledgement |
| ID conflict | Same request ID with changed input is rejected |
| Concurrency | Simultaneous new requests launch at most one child; other gets busy |
| Cancellation | Child terminates, one terminal state, no draft saved as success |
| Cancel race | Completion/cancellation resolves once; busy slot eventually clears |
| Timeout/crash | Safe failure, private diagnostic, next request can run |
| JSON parsing | Split/malformed lines bounded; invalid final recipe rejected |
| Progress privacy | Reasoning/tool/stderr fixture strings never reach browser events |
| Reconnect | Same run recovered after socket drop; no second child |
| Origin restart | Completed output survives; active run becomes interrupted; no auto-rerun |
| Auth | Missing session, wrong Origin, wrong origin secret, expired/revoked session denied |
| Ownership | Another user cannot subscribe/cancel/finalize another user's active run |
| Revisions | New ID, original intact, restrictions/history preserved, cap enforced |
| D1 recovery | Simulated save failure then retry produces exactly one owned draft |
| Rotation | Parent-only, trial confirmation required, repeat save preserves edits |
| Fallback | Native HTTP form still generates a draft and retains invalid input |
| UI | Keyboard/320px/430px usable; reconnect, cancel and failure controls work |
| Real path | Real generate + revision through Worker/origin; D1 readback matches |
| R2 | No generated image object is created |

Execution sequence:

1. Run existing tests before changes to identify pre-existing failures.
2. Implement protocol + origin jobs; run deterministic lifecycle/socket tests.
3. Wire standalone/dev startup; verify authenticated health/status and shutdown.
4. Add Worker bridge/finalizer and migrations; exercise local Worker integration.
5. Add UI/revision enhancement and static prototype parity; check browser states.
6. Run skill validation if edited, recipe-import self-test, all Train Smash tests,
   `npm run check`, and `git diff --check`.
7. Run two real model calls (generation and revision), then D1/R2 readback. Capture
   the actual model selected and verify the skill digest. Do not substitute fake
   results for this acceptance check.
8. Test the existing tunnel route if reachable and permitted; report separately
   whether local, tunnel, and deployed public Meals paths were each verified.

Baseline local commands (adjust free ports/storage path as necessary):

```sh
node .agents/skills/recipe-import/scripts/import-recipe.cjs --self-test
node scripts/train-smash.test.mjs
npm run check
npx wrangler d1 migrations apply meals --local --persist-to /tmp/meals-interactive-test
npm run dev -- --port 8790 --inspector-port 9299 --persist-to /tmp/meals-interactive-test
```

Keep command stdout/stderr and test summaries in a private directory and print
its path. Do not add test households or recipes to the user's usual local DB.
Stop only the test processes you created. If browser tooling is unavailable,
report mobile/browser verification as unperformed rather than claiming it passed.

## 12. Existing tunnel integration and production handoff

Tunnel provisioning is explicitly out of scope. Do not list “install Tunnel” as
a task or blocker. Needed deployment values are narrowly:

- Existing agent hostname/route and where it forwards on the home server.
- The service user's runtime paths and durable private state location.
- Origin shared secret and, only if required by the current Access policy,
  Access service credentials.
- Actual production Worker/D1/R2 identifiers and production-change authorization.

Discover non-secret values from existing configuration when available. Never
print tokens or copy them into this plan. If a hostname or credential cannot be
found, state exactly what is missing once, finish all independent local work,
and leave configuration placeholders. Do not claim a running tunnel proves that
this service endpoint is reachable or authorized.

Ship the user-systemd service template with restart-on-failure, correct working
directory, environment-file reference, explicit Node path, and private state
permissions. Starting/installing the unit is distinct from providing a template;
verify actual service status if authorized to install it. Do not edit the user's
existing tunnel/service unit as part of routine implementation.

When production changes are explicitly authorized, use the existing route,
configure the origin/Worker secrets, apply only the new ordered migration(s),
deploy using the repository's release workflow, and verify:

1. Worker-to-origin authenticated HTTP and WebSocket upgrade both succeed.
2. Direct unauthenticated requests cannot generate or read a recipe.
3. The public Meals page generates, reconnects, revises and saves successfully.
4. Origin unavailable gives a useful Train Smash error while normal Meals pages work.
5. Restarting the origin preserves completed-job recovery.

Provide rollback: previous Worker release, stop/revert only the new agent service,
retain completed jobs and D1 drafts, and leave the existing tunnel untouched.
Do not drop tables or delete user recipes to roll back the feature.

## 13. Definition of done and final response

A local implementation is done only when all local acceptance checks above pass
or a specific environmental limitation is evidenced and disclosed. A production
implementation is done only after the actual public path passes; “ready to deploy”
is not the same as deployed. Avoid repeatedly running expensive live generations
once the relevant checks pass.

Final report must include:

- Implemented UI/service behaviour and a working local URL only while it is running.
- Model and skill source; where the user changes recipe behaviour.
- Test summary distinguishing deterministic, live local, tunnel and production checks.
- Service installation/running state, private log path, and any exact missing inputs.
- Production deployed/not deployed and rollback instructions if deployed.

Preserve unrelated edits. Do not push, merge, or publish unless requested in the
execution session. Do not update Codex memory for this task. Do not stop merely to
ask whether to use WebSocket, which SDK, where the skill lives, or whether to make
progress real: those decisions are already specified above.

## Authoritative references to consult during implementation

Check current APIs before using them; do not copy event names or SDK behaviour
from guesses. These links support implementation, not a requirement to add SDKs.

- [Worker WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Node SQLite](https://nodejs.org/api/sqlite.html)
- [ws server documentation](https://github.com/websockets/ws)
