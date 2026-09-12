import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startTrainSmashAgent } from './train-smash-agent.mjs';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'meals-agent-'));
const token = randomBytes(32).toString('hex');
const agent = await startTrainSmashAgent({ port: 0, token, stateDir: join(temp, 'state'), rootDir: root });
const envFiles = [];
try { await access(join(root, '.dev.vars')); envFiles.push('--env-file', join(root, '.dev.vars')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(join(temp, '.env'), `TRAIN_SMASH_URL=${agent.url}/generate\nTRAIN_SMASH_TOKEN=${token}\n`, { mode: 0o600 });
const worker = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--local', '--ip', '0.0.0.0', ...envFiles, '--env-file', join(temp, '.env'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, WRANGLER_LOG_PATH: '/tmp/meals-wrangler.log' }
});
console.log(`Train Smash agent ready at ${agent.url}. Private logs: ${agent.logDir}`);

let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  worker.kill('SIGTERM');
  await agent.stop().catch((error) => console.error('Train Smash agent shutdown failed:', error.message));
  await rm(temp, { recursive: true, force: true });
  process.exit(code);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
worker.on('error', () => void stop(1));
worker.on('exit', (code) => void stop(code ?? 0));
