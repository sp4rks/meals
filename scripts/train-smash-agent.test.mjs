import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startTrainSmashAgent } from './train-smash-agent.mjs';
import { consumeJsonLines, openTrainSmashJobs } from './train-smash-jobs.mjs';

const input = { ingredients: '2 eggs, zucchini', servings: 2, preferences: 'vegetarian' };
const command = (requestId, overrides = {}) => ({ v: 1, type: 'generate', requestId, input: { ...input, ...overrides } });
const recipe = { title: 'Zucchini eggs', description: 'A quick dinner.', servings: 2, minutes: 15, ingredients: ['2 eggs', '1 zucchini'], steps: ['Cook it.'], notes: 'Use only what you have.' };
const waitFor = async (check) => { for (let i = 0; i < 100; i += 1) { if (check()) return; await new Promise((resolveWait) => setTimeout(resolveWait, 10)); } throw new Error('Timed out waiting for test state.'); };

const makeChild = (args, { slow = false, delay = 0 } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() {} };
  child.killed = false; child.exitCode = null; child.signalCode = null;
  child.kill = (signal) => {
    child.killed = true; child.signalCode = signal;
    if (signal === 'SIGKILL' || slow) queueMicrotask(() => { child.exitCode = null; child.emit('close', null, signal); });
    return true;
  };
  child.stdin.end = () => {
    if (slow) return;
    const output = args[args.indexOf('--output-last-message') + 1];
    const finish = async () => writeFile(output, JSON.stringify(recipe)).then(() => {
      child.stdout.emit('data', '{"type":"thread.started"}\n{"type":"turn');
      child.stdout.emit('data', '.completed"}\n');
      child.exitCode = 0; child.emit('close', 0, null);
    });
    if (delay) setTimeout(() => void finish(), delay); else void finish();
  };
  return child;
};

const stateDir = await mkdtemp(join(tmpdir(), 'meals-train-smash-test-'));
try {
  const spawned = [];
  const jobs = await openTrainSmashJobs({ stateDir, rootDir: resolve(import.meta.dirname, '..'), spawnProcess: (file, args) => { const child = makeChild(args); spawned.push(child); return child; } });
  const first = jobs.accept(command(crypto.randomUUID()), '1');
  assert.equal(first.kind, 'accepted');
  const duplicate = jobs.accept(command(first.snapshot.requestId), '1');
  assert.equal(duplicate.kind, 'existing');
  const conflict = jobs.accept(command(first.snapshot.requestId, { ingredients: 'one carrot' }), '1');
  assert.equal(conflict.kind, 'conflict');
  const busy = jobs.accept(command(crypto.randomUUID()), '1');
  assert.equal(busy.kind, 'busy');
  const completed = await jobs.waitForTerminal(first.snapshot.runId, '1');
  assert.equal(completed.status, 'completed');
  assert.equal(spawned.length, 1);
  assert.equal(jobs.db.prepare('SELECT model FROM train_smash_jobs WHERE id = ?').get(first.snapshot.runId).model, 'gpt-5.6-luna');
  assert.match(jobs.db.prepare('SELECT skill_digest FROM train_smash_jobs WHERE id = ?').get(first.snapshot.runId).skill_digest, /^[a-f0-9]{64}$/);
  await jobs.close();

  const slowStateDir = await mkdtemp(join(tmpdir(), 'meals-train-smash-cancel-'));
  const slowJobs = await openTrainSmashJobs({ stateDir: slowStateDir, rootDir: resolve(import.meta.dirname, '..'), spawnProcess: (file, args) => makeChild(args, { slow: true }) });
  const slow = slowJobs.accept(command(crypto.randomUUID()), '1');
  await waitFor(() => slowJobs.children.size === 1);
  assert.equal(slowJobs.cancel(slow.snapshot.runId, '1').snapshot.status, 'cancelled');
  assert.equal((await slowJobs.waitForTerminal(slow.snapshot.runId, '1')).status, 'cancelled');
  await slowJobs.close();
  await rm(slowStateDir, { recursive: true, force: true });

  const dbPath = join(stateDir, 'jobs.sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO train_smash_jobs (id, owner_id, request_id, request_hash, input_json, status, sequence, model, skill_digest) VALUES (?, ?, ?, ?, ?, 'running', 1, 'gpt-5.6-luna', '')").run(crypto.randomUUID(), '1', crypto.randomUUID(), 'hash', JSON.stringify(input));
  db.close();
  const restarted = await openTrainSmashJobs({ stateDir, rootDir: resolve(import.meta.dirname, '..'), spawnProcess: (file, args) => makeChild(args) });
  assert.equal(restarted.db.prepare("SELECT error_code FROM train_smash_jobs WHERE status = 'failed'").get().error_code, 'interrupted');
  await restarted.close();
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

const serviceStateDir = await mkdtemp(join(tmpdir(), 'meals-train-smash-service-test-'));
try {
  const service = await startTrainSmashAgent({ port: 0, token: 'test-token', stateDir: serviceStateDir, rootDir: resolve(import.meta.dirname, '..'), spawnProcess: (file, args) => makeChild(args, { delay: 100 }) });
  assert.deepEqual(await (await fetch(service.url + '/health')).json(), { ok: true });
  assert.equal((await fetch(service.url + '/ready', { headers: { Authorization: 'Bearer test-token', 'X-Meals-User-Id': '1' } })).status, 200);
  assert.equal((await fetch(service.url + '/generate', { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const duplicateRequestId = crypto.randomUUID();
  const duplicateBody = JSON.stringify({ v: 1, type: 'generate', requestId: duplicateRequestId, input });
  const duplicatePost = () => fetch(service.url + '/generate', { method: 'POST', headers: { Authorization: 'Bearer test-token', 'X-Meals-User-Id': '1', 'Content-Type': 'application/json' }, body: duplicateBody });
  const firstHttp = duplicatePost();
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  const secondHttp = duplicatePost();
  const [firstResponse, secondResponse] = await Promise.all([firstHttp, secondHttp]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal((await firstResponse.json()).runId, (await secondResponse.json()).runId);
  await waitFor(() => service.jobs.activeRunId === null);
  const socketRun = await new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(service.url.replace('http:', 'ws:') + '/events', { headers: { Authorization: 'Bearer test-token', 'X-Meals-User-Id': '1' } });
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => { socket.close(); rejectSocket(new Error('Origin WebSocket test timed out.')); }, 10000);
    socket.on('open', () => socket.send(JSON.stringify(command(requestId))));
    socket.on('message', (value) => {
      const message = JSON.parse(value.toString());
      if (message.type === 'snapshot' && message.status === 'completed') { clearTimeout(timeout); socket.close(); resolveSocket(message); }
    });
    socket.on('error', rejectSocket);
  });
  assert.equal(socketRun.input.ingredients, input.ingredients);
  await service.stop();
} finally {
  await rm(serviceStateDir, { recursive: true, force: true });
}

const lineState = { buffer: '', malformed: 0 };
const lines = [];
consumeJsonLines(lineState, '{"one":', (value) => lines.push(value));
consumeJsonLines(lineState, '1}\nnot-json\n{"two":2}\n', (value) => lines.push(value));
assert.deepEqual(lines, [{ one: 1 }, { two: 2 }]);
assert.equal(lineState.malformed, 1);
console.log('Train Smash agent lifecycle, idempotency, cancellation, restart, and JSONL checks passed.');
