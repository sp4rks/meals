# meals

Private household recipe box. Node.js 24+ and a signed-in local `codex` CLI are required for Train Smash.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

`npm run dev` starts the local Worker and a loopback-only recipe agent together. Restart it after upgrading from the old dev command. Existing `.dev.vars` values are passed through; temporary agent credentials and state are generated automatically. No API key or Cloudflare AI binding is needed. The agent uses the local Codex login and sends the entered ingredient list and dietary needs to its AI service.

For a standalone origin service, copy [ops/train-smash.env.example](ops/train-smash.env.example) to a private location, set `TRAIN_SMASH_TOKEN`, and run:

```sh
npm run agent
```

The service binds to `127.0.0.1:8792`, keeps jobs and bounded diagnostics in `TRAIN_SMASH_STATE_DIR`, recovers completed jobs for seven days, and marks unfinished jobs interrupted after restart. [ops/meals-train-smash.service](ops/meals-train-smash.service) is a user-service template for the existing tunnel route; it does not install or change the tunnel. The Worker uses `TRAIN_SMASH_URL` as the full `/generate` URL and derives `/events` and `/runs/:id` while preserving any path prefix. Remote URLs must use HTTPS. If the current Access policy requires it, set both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in the Worker secrets.

**🚂 Train Smash** turns available ingredients into a recipe suggestion. Suggestions stay outside the recipe library and are retained in your recent smashes. After trying one, a parent can choose **Add to rotation** to save it in Recipes. Saving again preserves any subsequent edits. Generation handles one request at a time and times out after 150 seconds. Leaving or refreshing the page reconnects to the same request ID/run; no second Codex process is started. Revisions create a new draft linked to the original, retain dietary constraints and up to ten bounded revision instructions, and do not mutate either earlier draft. Completed origin jobs can be finalized into D1 on the next visit if the browser disconnected during saving.

The local runner uses [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) with structured output, a read-only sandbox, and shell tools disabled. It does not load user-configured integrations. Agent failures print a private diagnostic file path; temporary files are deleted when the dev server stops. This runner is for local development; production deployment is separate.

To tune recipe behaviour, edit [the Train Smash skill](.agents/skills/train-smash/SKILL.md). The runner reads it for every generation, so skill edits take effect on the next request without restarting. Keep the output contract aligned with the existing schema and validation. This changes the current local agent instructions; it does not switch SDKs or enable production hosting.

Checks:

```sh
node scripts/train-smash.test.mjs
node scripts/train-smash-agent.test.mjs
node scripts/train-smash-interactive.test.mjs
node .agents/skills/recipe-import/scripts/import-recipe.cjs --self-test
npm run check
```

The deterministic agent tests use an injected fake process and do not spend a model call. `node scripts/train-smash.test.mjs --live` is the optional local Worker/origin acceptance path; `--live` performs real Codex generation and revision and must use isolated local D1 storage. The current model is explicitly `gpt-5.6-luna` with reasoning effort `max`. Edit `.agents/skills/train-smash/SKILL.md` to change recipe behaviour, and the exact skill content is hashed into each origin job.

For a live generation/save check, start a separate local Worker with isolated test storage:

```sh
npx wrangler d1 migrations apply meals --local --persist-to /tmp/meals-train-smash-test
npm run dev -- --port 8790 --inspector-port 9299 --persist-to /tmp/meals-train-smash-test
# In another terminal; uses one real Codex generation and creates test records:
node scripts/train-smash.test.mjs --live
```
