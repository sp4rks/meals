# meals

Private household recipe box. Node.js 24+ and a signed-in local `codex` CLI are required for Train Smash.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

`npm run dev` starts the local Worker and a loopback-only recipe agent together. Restart it after upgrading from the old dev command. Existing `.dev.vars` values are passed through; temporary agent credentials are generated automatically. No API key or Cloudflare AI binding is needed. The agent uses the local Codex login and sends the entered ingredient list and dietary needs to its AI service.

**🚂 Train Smash** turns available ingredients into a recipe suggestion. Suggestions stay outside the recipe library and are retained in your recent smashes. After trying one, a parent can choose **Add to rotation** to save it in Recipes. Saving again preserves any subsequent edits. Generation handles one request at a time and times out after 150 seconds.

The local runner uses [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) with structured output, a read-only sandbox, and shell tools disabled. It does not load user-configured integrations. Agent failures print a private diagnostic file path; temporary files are deleted when the dev server stops. This runner is for local development; production deployment is separate.

To tune recipe behaviour, edit [the Train Smash skill](.agents/skills/train-smash/SKILL.md). The runner reads it for every generation, so skill edits take effect on the next request without restarting. Keep the output contract aligned with the existing schema and validation. This changes the current local agent instructions; it does not switch SDKs or enable production hosting.

Checks:

```sh
node scripts/train-smash.test.mjs
node .agents/skills/recipe-import/scripts/import-recipe.cjs --self-test
npm run check
```

For a live generation/save check, start a separate local Worker with isolated test storage:

```sh
npx wrangler d1 migrations apply meals --local --persist-to /tmp/meals-train-smash-test
npm run dev -- --port 8790 --inspector-port 9299 --persist-to /tmp/meals-train-smash-test
# In another terminal; uses one real Codex generation and creates test records:
node scripts/train-smash.test.mjs --live
```
