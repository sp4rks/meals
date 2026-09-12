import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateSmashInput, validateSmashRecipe } from '../src/train-smash.ts';

const root = resolve(import.meta.dirname, '..');
const token = randomBytes(32).toString('hex');
const temp = await mkdtemp(join(tmpdir(), 'meals-agent-'));
// ponytail: one household generation at a time; add a queue if concurrent use matters.
let busy = false;
let activeAgent;
const server = createServer(async (req, res) => {
  const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (req.method !== 'POST' || req.url !== '/generate' || req.headers.authorization !== 'Bearer ' + token) return reply(403, { error: 'Forbidden' });
  if (busy) return reply(429, { error: 'Another recipe is cooking up. Try again in a moment.' });
  busy = true;
  let job;
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 24000) { reply(413, { error: 'Too much text.' }); return; }
    }
    let input;
    try { input = validateSmashInput(JSON.parse(body)); }
    catch { reply(400, { error: 'Please check your ingredients and servings.' }); return; }
    job = await mkdtemp(join(temp, 'recipe-'));
    const skill = await readFile(join(root, '.agents/skills/train-smash/SKILL.md'), 'utf8');
    const prompt = `${skill}\n\nIngredient data (JSON):\n${JSON.stringify(input)}`;
    await new Promise((resolve, reject) => {
      activeAgent = execFile('codex', ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'features.shell_tool=false', '--output-schema', join(root, 'scripts/train-smash.schema.json'), '--output-last-message', join(job, 'recipe.json'), '-'], { cwd: job, timeout: 150000, maxBuffer: 1024 * 1024 }, (error) => error ? reject(error) : resolve());
      activeAgent.stdin.end(prompt);
    });
    const recipe = validateSmashRecipe(JSON.parse(await readFile(join(job, 'recipe.json'), 'utf8')));
    if (recipe.servings !== input.servings) throw new Error('Servings mismatch');
    reply(200, recipe);
  } catch (error) {
    await writeFile(join(temp, 'agent-error.log'), error.stderr || error.message, { mode: 0o600 });
    console.error('Train Smash failed. Private diagnostic:', join(temp, 'agent-error.log'));
    reply(502, { error: 'The recipe agent could not finish. Please try again.' });
  }
  finally {
    activeAgent = undefined;
    busy = false;
    if (job) await rm(job, { recursive: true, force: true });
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const url = `http://127.0.0.1:${server.address().port}/generate`;
const envFiles = [];
try { await access(join(root, '.dev.vars')); envFiles.push('--env-file', join(root, '.dev.vars')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(join(temp, '.env'), `TRAIN_SMASH_URL=${url}\nTRAIN_SMASH_TOKEN=${token}\n`, { mode: 0o600 });
const worker = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--local', '--ip', '0.0.0.0', ...envFiles, '--env-file', join(temp, '.env'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_LOG_PATH: '/tmp/meals-wrangler.log' } });
console.log('Train Smash agent ready on loopback. Uses the local Codex login.');
const stop = () => { activeAgent?.kill('SIGTERM'); worker.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
worker.on('error', async () => { await rm(temp, { recursive: true, force: true }); process.exit(1); });
worker.on('exit', async (code) => { activeAgent?.kill('SIGTERM'); server.closeAllConnections(); server.close(); await rm(temp, { recursive: true, force: true }); process.exit(code ?? 0); });
