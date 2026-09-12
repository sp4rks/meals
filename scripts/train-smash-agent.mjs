import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { MAX_INTERNAL_MESSAGE_BYTES, parseOriginCommand, publicMessage, parseSnapshot } from '../src/train-smash-protocol.ts';
import { openTrainSmashJobs } from './train-smash-jobs.mjs';

const DEFAULT_PORT = 8792;
const OWNER_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
const PUBLIC_CODES = new Set(['busy', 'request_conflict', 'not_found', 'cancelled', 'timeout', 'interrupted', 'agent_unavailable', 'invalid_recipe']);

const sameSecret = (provided, expected) => {
  const left = Buffer.from(provided || '');
  const right = Buffer.from(expected || '');
  return left.length === right.length && timingSafeEqual(left, right);
};

const ownerFrom = (request) => {
  const owner = request.headers['x-meals-user-id'];
  return typeof owner === 'string' && OWNER_PATTERN.test(owner) ? owner : '';
};

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

const readBody = async (request, limit = MAX_INTERNAL_MESSAGE_BYTES) => {
  let body = '';
  for await (const chunk of request) {
    body += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('Message too large.'), { code: 'too_large' });
  }
  return JSON.parse(body || '{}');
};

const publicCode = (error) => PUBLIC_CODES.has(error?.code) ? error.code : 'agent_unavailable';

export const startTrainSmashAgent = async ({
  port = Number(process.env.TRAIN_SMASH_PORT || DEFAULT_PORT),
  token = process.env.TRAIN_SMASH_TOKEN,
  stateDir = process.env.TRAIN_SMASH_STATE_DIR,
  rootDir = resolve(import.meta.dirname, '..'),
  spawnProcess,
  upgradeDelayMs = 0,
  onLog = (message) => console.log(`[train-smash] ${message}`)
} = {}) => {
  process.umask(0o077);
  if (!token || !token.trim()) throw new Error('TRAIN_SMASH_TOKEN must be a non-empty secret.');
  if (!stateDir) throw new Error('TRAIN_SMASH_STATE_DIR must be an explicit writable private directory.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('TRAIN_SMASH_PORT must be an integer from 0 to 65535.');
  const jobs = await openTrainSmashJobs({ stateDir, rootDir, spawnProcess, onLog });
  const logDir = resolve(stateDir, 'logs');
  const sockets = new Set();
  const ownerConnections = new Map();
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_INTERNAL_MESSAGE_BYTES });

  const authorized = (request) => sameSecret(request.headers.authorization?.replace(/^Bearer\s+/i, ''), token) && !!ownerFrom(request);
  const rejectUpgrade = (socket, status, message) => {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  const send = (socket, value) => {
    if (socket.readyState !== 1) return;
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > MAX_INTERNAL_MESSAGE_BYTES || socket.bufferedAmount > 256 * 1024) return socket.close(1009, 'Slow connection');
    socket.send(payload);
  };

  const attachRun = (socket, ownerId, runId, afterSequence = 0, subscriptions) => {
    subscriptions.get(runId)?.();
    const unsubscribe = jobs.subscribe(runId, ownerId, (snapshot) => {
      send(socket, parseSnapshot(snapshot));
      if (['completed', 'cancelled', 'failed'].includes(snapshot.status)) {
        setTimeout(() => socket.readyState === 1 && socket.close(1000, 'Run finished'), 60_000).unref?.();
      }
    });
    if (!unsubscribe) {
      send(socket, { v: 1, type: 'error', code: 'not_found', message: publicMessage('not_found') });
      return;
    }
    subscriptions.set(runId, unsubscribe);
    void afterSequence;
  };

  webSockets.on('connection', (socket, request) => {
    const ownerId = ownerFrom(request);
    const subscriptions = new Map();
    const commandTimes = [];
    let heartbeat;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      sockets.delete(socket);
      const count = ownerConnections.get(ownerId) || 1;
      if (count <= 1) ownerConnections.delete(ownerId); else ownerConnections.set(ownerId, count - 1);
    };
    sockets.add(socket);
    ownerConnections.set(ownerId, (ownerConnections.get(ownerId) || 0) + 1);
    socket.on('close', close);
    socket.on('error', close);
    socket.on('pong', () => {});
    heartbeat = setInterval(() => { if (socket.readyState === 1) socket.ping(); }, 30_000);

    socket.on('message', (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data) > MAX_INTERNAL_MESSAGE_BYTES) {
        socket.close(1003, 'Invalid message');
        return;
      }
      const now = Date.now();
      while (commandTimes[0] && commandTimes[0] <= now - 10_000) commandTimes.shift();
      if (commandTimes.length >= 10) {
        send(socket, { v: 1, type: 'error', code: 'busy', message: 'Too many commands. Try again in a moment.' });
        return;
      }
      commandTimes.push(now);
      let command;
      try { command = parseOriginCommand(JSON.parse(data.toString('utf8'))); }
      catch { socket.close(1008, 'Invalid message'); return; }
      try {
        if (command.type === 'subscribe') {
          attachRun(socket, ownerId, command.runId, command.afterSequence, subscriptions);
          return;
        }
        if (command.type === 'cancel') {
          const result = jobs.cancel(command.runId, ownerId);
          if (result.kind === 'not_found') send(socket, { v: 1, type: 'error', code: 'not_found', message: publicMessage('not_found') });
          else send(socket, parseSnapshot(result.snapshot));
          return;
        }
        const result = jobs.accept(command, ownerId);
        if (result.kind === 'busy') { send(socket, { v: 1, type: 'error', code: 'busy', message: publicMessage('busy'), requestId: command.requestId }); return; }
        if (result.kind === 'conflict') { send(socket, { v: 1, type: 'error', code: 'request_conflict', message: publicMessage('request_conflict'), requestId: command.requestId }); return; }
        send(socket, parseSnapshot(result.snapshot));
        if (!['completed', 'cancelled', 'failed'].includes(result.snapshot.status)) attachRun(socket, ownerId, result.snapshot.runId, 0, subscriptions);
      } catch (error) {
        send(socket, { v: 1, type: 'error', code: publicCode(error), message: publicMessage(publicCode(error)), requestId: command?.requestId });
      }
    });
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });
    if (!authorized(request)) return json(response, 403, { error: 'forbidden', message: publicMessage('forbidden') });
    const ownerId = ownerFrom(request);
    if (request.method === 'GET' && url.pathname === '/ready') {
      try { await jobs.ready(); return json(response, 200, { ok: true }); }
      catch { return json(response, 503, { ok: false, error: 'agent_unavailable', message: publicMessage('agent_unavailable') }); }
    }
    if (request.method === 'GET' && /^\/runs\/[0-9a-f-]{36}$/i.test(url.pathname)) {
      const snapshot = jobs.getSnapshot(url.pathname.slice('/runs/'.length), ownerId);
      return snapshot ? json(response, 200, parseSnapshot(snapshot)) : json(response, 404, { error: 'not_found', message: publicMessage('not_found') });
    }
    if (request.method === 'POST' && url.pathname === '/generate') {
      let body;
      try { body = await readBody(request); }
      catch (error) { return json(response, error?.code === 'too_large' ? 413 : 400, { error: 'invalid_recipe', message: publicMessage('invalid_recipe') }); }
      let command;
      try { command = parseOriginCommand(body.v ? body : { v: 1, type: 'generate', requestId: body.requestId, input: body.input }); }
      catch { return json(response, 400, { error: 'invalid_recipe', message: publicMessage('invalid_recipe') }); }
      let result;
      try { result = jobs.accept(command, ownerId); }
      catch { return json(response, 400, { error: 'invalid_recipe', message: publicMessage('invalid_recipe') }); }
      if (result.kind === 'busy') return json(response, 429, { error: 'busy', message: publicMessage('busy') });
      if (result.kind === 'conflict') return json(response, 409, { error: 'request_conflict', message: publicMessage('request_conflict') });
      const snapshot = result.kind === 'accepted' || result.kind === 'existing' ? await jobs.waitForTerminal(result.snapshot.runId, ownerId) : result.snapshot;
      if (!snapshot) return json(response, 404, { error: 'not_found', message: publicMessage('not_found') });
      if (snapshot.status === 'completed') return json(response, 200, parseSnapshot(snapshot));
      const code = snapshot.errorCode || 'agent_unavailable';
      return json(response, 502, { error: code, message: publicMessage(code), snapshot: parseSnapshot(snapshot) });
    }
    return json(response, 404, { error: 'not_found', message: publicMessage('not_found') });
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/events') return rejectUpgrade(socket, 404, 'Not Found');
    if (!authorized(request)) return rejectUpgrade(socket, 403, 'Forbidden');
    const ownerId = ownerFrom(request);
    if ((ownerConnections.get(ownerId) || 0) >= 3) return rejectUpgrade(socket, 429, 'Too Many Connections');
    const upgrade = () => { if (!socket.destroyed) webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit('connection', client, request)); };
    if (upgradeDelayMs > 0) setTimeout(upgrade, upgradeDelayMs).unref?.(); else upgrade();
  });

  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  onLog(`listening on 127.0.0.1:${actualPort}; private logs: ${logDir}`);

  return {
    server,
    jobs,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    logDir,
    async stop() {
      for (const socket of sockets) socket.close(1001, 'Service stopping');
      await jobs.close();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
  };
};

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const service = await startTrainSmashAgent();
  const stop = async () => { await service.stop(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
