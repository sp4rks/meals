import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile as nodeExecFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import WebSocket from 'ws';
import { startTrainSmashAgent } from './train-smash-agent.mjs';

const execFile = promisify(nodeExecFile);
const root = resolve(import.meta.dirname, '..');
const input = { ingredients: '2 eggs, zucchini', servings: 2, preferences: 'vegetarian' };
const recipe = { title: 'Zucchini eggs', description: 'A quick dinner.', servings: 2, minutes: 15, ingredients: ['2 eggs', '1 zucchini'], steps: ['Cook it.'], notes: 'Use only what you have.' };
const command = (requestId) => ({ v: 1, type: 'generate', requestId, input });

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const freePort = async () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolvePort(port));
  });
});

const fakeChild = (args, slow = false) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.killed = true;
    child.signalCode = signal;
    if (slow || signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  child.stdin.end = () => {
    if (slow) return;
    const output = args[args.indexOf('--output-last-message') + 1];
    void writeFile(output, JSON.stringify(recipe)).then(() => {
      child.stdout.emit('data', '{"type":"thread.started"}\n');
      child.exitCode = 0;
      child.emit('close', 0, null);
    });
  };
  return child;
};

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = { add() {}, remove() {} };
    this.hidden = false;
    this.textContent = '';
  }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  emit(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback({ currentTarget: this, ...event }); }
  append(...children) { this.children.push(...children); children.forEach((child) => { child.parent = this; }); }
  after(child) { this.parent?.append(child); }
  before(child) { this.parent?.append(child); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  toggleAttribute(name, force) { if (force) this.attributes.set(name, ''); else this.attributes.delete(name); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      const dataMatch = selector.match(/^\[data-([a-z-]+)\]$/);
      const dataKey = dataMatch?.[1].replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      if (dataKey && node.dataset[dataKey] !== undefined) matches.push(node);
      else if (selector === 'a' && node.tagName === 'A') matches.push(node);
      else if (selector.includes('button[type="submit"]') && node.tagName === 'BUTTON' && node.type === 'submit') matches.push(node);
      for (const child of node.children) visit(child);
    };
    visit(this);
    return matches;
  }
}

const bootClient = (savedState = null, cryptoApi = { randomUUID: () => '11111111-1111-4111-8111-111111111111' }, pathname = '/train-smash') => {
  const main = new FakeElement('main');
  main.dataset.smashUserId = '1';
  const form = new FakeElement('form');
  form.dataset.smashForm = '';
  form.elements = { ingredients: { value: 'eggs' }, servings: { value: '2' }, preferences: { value: '' } };
  const submit = new FakeElement('button');
  submit.type = 'submit';
  form.append(submit);
  main.append(form);
  const storage = new Map(savedState ? [['meals.train-smash.1', JSON.stringify(savedState)]] : []);
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor() { this.readyState = FakeWebSocket.CONNECTING; this.listeners = new Map(); this.sent = []; sockets.push(this); }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
    emit(type, event = {}) { if (type === 'open') this.readyState = FakeWebSocket.OPEN; if (type === 'close') this.readyState = FakeWebSocket.CLOSED; for (const callback of this.listeners.get(type) || []) callback(event); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = FakeWebSocket.CLOSING; }
  }
  const document = { querySelector: () => main, createElement: (tagName) => new FakeElement(tagName) };
  const location = { protocol: 'http:', host: 'meals.test', pathname, assigned: '', assign(value) { this.assigned = value; } };
  const context = {
    document,
    location,
    sessionStorage: { getItem(key) { return storage.get(key) || null; }, setItem(key, value) { storage.set(key, value); }, removeItem(key) { storage.delete(key); } },
    WebSocket: FakeWebSocket,
    crypto: cryptoApi,
    window: { setInterval: () => 1, clearTimeout() {}, setTimeout() {}, location },
    setTimeout() {},
    clearTimeout() {},
    console
  };
  const source = bootClient.source || (bootClient.source = readFile(join(root, 'design/train-smash.js'), 'utf8'));
  return source.then((script) => { vm.runInNewContext(script, context); return { form, main, sockets, storage, location }; });
};

const waitForWorker = async (base, child, logs) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    if (child.exitCode !== null) break;
    await wait(100);
  }
  throw new Error(`Worker did not start: ${logs.join('').slice(-2000)}`);
};

const workerSocket = async (base, cookie) => {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/train-smash/socket', { headers: { Cookie: cookie, Origin: base } });
  await new Promise((resolveSocket, rejectSocket) => { socket.once('open', resolveSocket); socket.once('error', rejectSocket); });
  return socket;
};

const nextMessage = (socket, predicate) => new Promise((resolveMessage, rejectMessage) => {
  const timeout = setTimeout(() => { socket.close(); rejectMessage(new Error('Timed out waiting for interactive message.')); }, 10000);
  socket.on('message', (value) => {
    const message = JSON.parse(value.toString());
    if (!predicate(message)) return;
    clearTimeout(timeout);
    resolveMessage(message);
  });
});

const runClientRegressions = async () => {
  const insecureContext = await bootClient(null, { getRandomValues(bytes) { bytes.fill(0xab); return bytes; } });
  insecureContext.form.emit('submit', { preventDefault() {} });
  assert.equal(insecureContext.sockets.length, 1);
  assert.match(JSON.parse(insecureContext.storage.get('meals.train-smash.1')).requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'HTTP fallback should generate a UUID');
  const retry = await bootClient();
  retry.form.emit('submit', { preventDefault() {} });
  retry.sockets[0].emit('open');
  retry.sockets[0].emit('message', { data: JSON.stringify({ type: 'error', code: 'cancelled' }) });
  retry.form.emit('submit', { preventDefault() {} });
  assert.equal(retry.sockets.length, 2, 'retry should create a fresh socket');
  assert.equal(retry.form.hidden, true, 'ingredient form should hide while a job is running');
  retry.sockets[1].emit('open');
  assert.equal(retry.sockets[1].sent.length, 1, 'retry command should be sent on the new socket');
  retry.sockets[1].emit('message', { data: JSON.stringify({ type: 'snapshot', runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sequence: 2, status: 'running', createdAt: new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') }) });
  assert.match(retry.main.querySelector('[data-smash-progress-log]').textContent, /Generating a recipe/);
  assert.match(retry.main.querySelector('[data-smash-elapsed]').textContent, /^\d{2} sec$/);
  retry.sockets[1].emit('message', { data: JSON.stringify({ type: 'snapshot', runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sequence: 3, status: 'running', createdAt: new Date(Date.now() - 60000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') }) });
  assert.equal(retry.main.querySelector('[data-smash-elapsed]').textContent, '01:00');
  const retained = await bootClient(null, undefined, '/train-smash/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  retained.form.emit('submit', { preventDefault() {} });
  retained.sockets[0].emit('open');
  retained.sockets[0].emit('message', { data: JSON.stringify({ type: 'snapshot', runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sequence: 4, status: 'completed', draftUrl: '/train-smash/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: new Date().toISOString() }) });
  assert.equal(retained.location.assigned, '', 'completed draft should retain its progress panel');
  assert.match(retained.main.querySelector('[data-smash-progress-log]').textContent, /Recipe ready/);
  retained.form.emit('submit', { preventDefault() {} });
  assert.doesNotMatch(retained.main.querySelector('[data-smash-progress-log]').textContent, /Recipe ready/);

  const requestId = '22222222-2222-4222-8222-222222222222';
  const pending = await bootClient({ userId: '1', kind: 'generate', requestId, input, runId: null, sequence: 0, startedAt: Date.now() });
  assert.equal(pending.sockets.length, 1);
  pending.sockets[0].emit('open');
  assert.equal(pending.sockets[0].sent[0].requestId, requestId, 'pending request should be resent after reload');
};

const runWorkerRegressions = async () => {
  const persist = await mkdtemp(join(tmpdir(), 'meals-train-smash-interactive-'));
  const stateDir = join(persist, 'agent');
  const envPath = join(persist, '.env');
  let calls = 0;
  let service;
  let worker;
  const logs = [];
  try {
    service = await startTrainSmashAgent({
      port: 0,
      token: 'interactive-test-token',
      stateDir,
      rootDir: root,
      upgradeDelayMs: 400,
      spawnProcess: (file, args) => fakeChild(args, calls++ === 1)
    });
    await writeFile(envPath, `TRAIN_SMASH_URL=${service.url}/generate\nTRAIN_SMASH_TOKEN=interactive-test-token\n`, { mode: 0o600 });
    await execFile(join(root, 'node_modules/.bin/wrangler'), ['d1', 'migrations', 'apply', 'meals', '--local', '--persist-to', persist], { cwd: root, env: { ...process.env, WRANGLER_LOG_PATH: join(persist, 'wrangler.log') }, timeout: 30000 });
    const port = await freePort();
    worker = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist, '--env-file', envPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    worker.stdout.on('data', (value) => logs.push(value.toString()));
    worker.stderr.on('data', (value) => logs.push(value.toString()));
    const base = `http://127.0.0.1:${port}`;
    await waitForWorker(base, worker, logs);
    await fetch(base + '/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Interactive test', password: 'isolated-test-password' }) });
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Interactive test', password: 'isolated-test-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const first = await workerSocket(base, cookie);
    const firstResult = nextMessage(first, (message) => message.type === 'snapshot' && message.status === 'completed' && !!message.draftUrl);
    first.send(JSON.stringify(command('33333333-3333-4333-8333-333333333333')));
    assert.equal((await firstResult).status, 'completed', 'first command must survive delayed origin connect');
    first.close();

    const slow = await workerSocket(base, cookie);
    const slowStarted = nextMessage(slow, (message) => message.type === 'snapshot' && ['accepted', 'running'].includes(message.status));
    slow.send(JSON.stringify(command('44444444-4444-4444-8444-444444444444')));
    const started = await slowStarted;
    const busy = await workerSocket(base, cookie);
    const busyResult = nextMessage(busy, (message) => message.type === 'error');
    busy.send(JSON.stringify(command('55555555-5555-4555-8555-555555555555')));
    assert.equal((await busyResult).code, 'busy', 'origin error envelope should reach the browser');
    busy.close();
    const cancelled = nextMessage(slow, (message) => message.type === 'snapshot' && message.status === 'cancelled');
    slow.send(JSON.stringify({ v: 1, type: 'cancel', runId: started.runId }));
    await cancelled;
    slow.close();
  } finally {
    if (worker && worker.exitCode === null) { worker.kill('SIGTERM'); await new Promise((resolveExit) => worker.once('exit', resolveExit)); }
    if (service) await service.stop();
    await rm(persist, { recursive: true, force: true });
  }
};

await runClientRegressions();
await runWorkerRegressions();
console.log('Interactive Train Smash regressions passed: delayed origin queue, retry, reload, error envelope, and duplicate-safe flow.');
