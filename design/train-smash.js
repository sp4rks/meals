(() => {
  const main = document.querySelector('[data-smash-user-id]');
  if (!main) return;
  const userId = main.dataset.smashUserId;
  const storageKey = `meals.train-smash.${userId}`;
  const progressStorageKey = `${storageKey}.progress`;
  const labels = {
    accepted: 'Accepted — getting things ready…', running: 'Making something of it…', validating: 'Checking the recipe…',
    saving: 'Saving the recipe…', completed: 'Ready.', cancelled: 'Cancelled.', failed: 'The recipe agent could not finish.'
  };
  const progressMessages = {
    accepted: 'Request accepted; starting the agent…', running: 'Generating a recipe from the ingredients…', validating: 'Draft received; checking the recipe…',
    saving: 'Recipe checked; saving it…', completed: 'Recipe ready.', cancelled: 'Run cancelled.', failed: 'Run failed.',
    reconnecting: 'Connection paused; reconnecting…', offline: 'Connection offline.'
  };
  const messages = {
    busy: 'Another recipe is cooking up. Try again in a moment.', request_conflict: 'That request ID was already used for different ingredients.',
    not_found: 'That Train Smash run is no longer available.', cancelled: 'Train Smash was cancelled.', timeout: 'The recipe agent took too long. Your ingredients are still here — try again.',
    interrupted: 'The recipe agent restarted before it finished. Your ingredients are still here — try again.', agent_unavailable: 'The recipe agent is unavailable. Please try again shortly.',
    invalid_recipe: 'The recipe agent returned an incomplete recipe. Please try again.', save_failed: 'The recipe is ready, but it could not be saved yet. Try again.', forbidden: 'You cannot use this Train Smash run.'
  };
  let state = readState();
  let socket;
  let reconnectTimer;
  let reconnectAttempts = 0;
  let timer;
  let lastEvent = '';

  const existingRun = main.querySelector('[data-smash-run]');
  if (!state && existingRun?.dataset.smashRun && existingRun.dataset.smashRunStatus !== 'completed') state = { kind: 'recover', runId: existingRun.dataset.smashRun, sequence: 0, startedAt: Date.now() };

  function readState() {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      return value && value.userId === userId ? value : null;
    } catch { return null; }
  }
  function saveState() {
    try {
      if (state) sessionStorage.setItem(storageKey, JSON.stringify({ ...state, userId }));
      else sessionStorage.removeItem(storageKey);
    } catch {}
  }
  function saveProgressLog() {
    const panel = main.querySelector('[data-smash-run]');
    const log = panel?.querySelector('[data-smash-progress-log]');
    if (!panel?.dataset.smashRun || !log) return;
    try { sessionStorage.setItem(progressStorageKey, JSON.stringify({ runId: panel.dataset.smashRun, text: log.textContent })); } catch {}
  }
  function restoreProgressLog(panel) {
    const log = panel?.querySelector('[data-smash-progress-log]');
    if (!panel?.dataset.smashRun || !log) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(progressStorageKey) || 'null');
      if (!saved || saved.runId !== panel.dataset.smashRun || typeof saved.text !== 'string') return;
      log.textContent = saved.text;
      const lines = saved.text.split('\n');
      log.dataset.lastProgress = (lines[lines.length - 1] || '').replace(/^> /, '');
    } catch {}
  }
  function resetProgressLog() {
    const log = main.querySelector('[data-smash-progress-log]');
    if (log) { log.textContent = ''; delete log.dataset.lastProgress; }
    try { sessionStorage.removeItem(progressStorageKey); } catch {}
  }
  function setInputFormVisible(visible) {
    const form = main.querySelector('[data-smash-form]');
    if (form) form.hidden = !visible;
  }
  function newId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function send(value) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
  function statusText(code) { return messages[code] || messages.agent_unavailable; }
  function progressPanel() {
    let panel = main.querySelector('[data-smash-run]');
    if (panel) return panel;
    panel = document.createElement('section');
    panel.className = 'card smash-progress';
    panel.setAttribute('aria-labelledby', 'smash-progress-heading');
    const row = document.createElement('div'); row.className = 'row';
    const copy = document.createElement('div');
    const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'Train Smash';
    const heading = document.createElement('h2'); heading.id = 'smash-progress-heading'; heading.dataset.smashProgressLabel = '';
    copy.append(eyebrow, heading);
    const elapsed = document.createElement('span'); elapsed.className = 'smash-elapsed'; elapsed.dataset.smashElapsed = '';
    row.append(copy, elapsed);
    const detail = document.createElement('p'); detail.className = 'help'; detail.dataset.smashProgressDetail = ''; detail.setAttribute('role', 'status'); detail.setAttribute('aria-live', 'polite');
    const terminal = document.createElement('pre'); terminal.className = 'smash-terminal'; terminal.dataset.smashProgressLog = ''; terminal.setAttribute('role', 'log'); terminal.setAttribute('aria-label', 'Agent progress');
    const actions = document.createElement('div'); actions.className = 'actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button danger'; cancel.dataset.smashCancel = ''; cancel.textContent = 'Cancel'; cancel.addEventListener('click', cancelRun);
    const reconnect = document.createElement('a'); reconnect.className = 'button secondary'; reconnect.dataset.smashReconnect = ''; reconnect.hidden = true; reconnect.textContent = 'Reconnect';
    actions.append(cancel, reconnect); panel.append(row, detail, terminal, actions);
    const form = main.querySelector('[data-smash-form]'); form?.after(panel);
    return panel;
  }
  function setProgress(status, snapshot) {
    const panel = progressPanel();
    panel.dataset.smashRun = snapshot?.runId || state?.runId || '';
    const label = panel.querySelector('[data-smash-progress-label]'); if (label) label.textContent = labels[status] || 'Working…';
    const detail = panel.querySelector('[data-smash-progress-detail]'); if (detail) detail.textContent = status === 'reconnecting' ? 'Connection paused. Reconnecting safely…' : status === 'offline' ? 'The connection is offline. You can reconnect when ready.' : 'Reconnects safely if you leave this page.';
    const log = panel.querySelector('[data-smash-progress-log]'); const progress = progressMessages[status]; if (log && progress && log.dataset.lastProgress !== progress) { log.textContent += `${log.textContent ? '\n' : ''}> ${progress}`; log.dataset.lastProgress = progress; log.scrollTop = log.scrollHeight; saveProgressLog(); }
    const cancel = panel.querySelector('[data-smash-cancel]'); if (cancel) cancel.hidden = !['accepted', 'running', 'validating'].includes(status);
    const reconnect = panel.querySelector('[data-smash-reconnect]'); if (reconnect) { reconnect.hidden = status !== 'offline'; reconnect.href = snapshot?.runId || state?.runId ? `/train-smash/runs/${encodeURIComponent(snapshot?.runId || state.runId)}` : '#'; reconnect.onclick = status === 'offline' ? (event) => { event.preventDefault(); reconnectAttempts = 0; connect(); } : null; }
    if (['accepted', 'running', 'validating', 'saving', 'reconnecting'].includes(status)) setInputFormVisible(false);
    if (['failed', 'cancelled', 'offline'].includes(status)) setInputFormVisible(true);
    if (snapshot?.createdAt) panel.dataset.createdAt = snapshot.createdAt;
    if (!timer) timer = window.setInterval(updateElapsed, 1000);
    updateElapsed();
  }
  function updateElapsed() {
    const panel = main.querySelector('[data-smash-run]');
    if (!panel) return;
    const rawStarted = panel.dataset.createdAt || '';
    const started = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(rawStarted) ? `${rawStarted.replace(' ', 'T')}Z` : rawStarted);
    const elapsed = panel.querySelector('[data-smash-elapsed]');
    if (!elapsed || !Number.isFinite(started)) return;
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    elapsed.textContent = seconds < 60 ? `${String(seconds).padStart(2, '0')} sec` : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function setFormBusy(busy) {
    main.querySelectorAll('[data-smash-form] button[type="submit"], [data-revision-form] button[type="submit"]').forEach((button) => { button.disabled = busy; });
    const form = main.querySelector('[data-smash-form]'); if (form) form.toggleAttribute('aria-busy', busy);
  }
  function begin(command) {
    resetProgressLog();
    state = { ...command, runId: null, sequence: 0, startedAt: Date.now() };
    saveState(); setFormBusy(true); setInputFormVisible(false); setProgress('accepted'); connect();
  }
  function connect() {
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    window.clearTimeout(reconnectTimer);
    setProgress(reconnectAttempts ? 'reconnecting' : 'accepted');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const client = new WebSocket(`${scheme}//${location.host}/train-smash/socket`);
    socket = client;
    client.addEventListener('open', () => {
      if (socket !== client) return;
      reconnectAttempts = 0;
      if (state?.runId) send({ v: 1, type: 'subscribe', runId: state.runId, afterSequence: state.sequence || 0 });
      else if (state?.kind === 'revise') send({ v: 1, type: 'revise', requestId: state.requestId, draftId: state.draftId, instruction: state.instruction });
      else if (state) send({ v: 1, type: 'generate', requestId: state.requestId, input: state.input });
    });
    client.addEventListener('message', (event) => { try { receive(JSON.parse(event.data)); } catch {} });
    client.addEventListener('close', () => {
      if (socket !== client) return;
      if (!state) return;
      socket = undefined;
      if (reconnectAttempts >= 6) { setProgress('offline'); setFormBusy(false); return; }
      reconnectAttempts += 1;
      const delay = Math.min(10000, 500 * 2 ** (reconnectAttempts - 1));
      setProgress('reconnecting'); reconnectTimer = window.setTimeout(connect, delay);
    });
    client.addEventListener('error', () => {});
  }
  function closeSocket() {
    const client = socket;
    socket = undefined;
    if (client && client.readyState < WebSocket.CLOSING) client.close(1000, 'Run finished');
  }
  function receive(message) {
    if (message.type === 'error') {
      setProgress('failed'); showError(statusText(message.code));
      if (message.code !== 'save_failed') { state = null; saveState(); setFormBusy(false); closeSocket(); }
      return;
    }
    if (message.type !== 'snapshot' || !message.runId) return;
    const eventKey = [message.runId, message.sequence, message.status, message.draftId || ''].join(':');
    if (eventKey === lastEvent) return;
    lastEvent = eventKey;
    state = { ...state, runId: message.runId, sequence: message.sequence, createdAt: message.createdAt };
    saveState(); setProgress(message.status, message);
    if (message.status === 'completed' && message.draftUrl) {
      state = null; saveState();
      if (location.pathname !== message.draftUrl) window.location.assign(message.draftUrl);
      else { setFormBusy(false); closeSocket(); }
      return;
    }
    if (message.status === 'failed' || message.status === 'cancelled') {
      showError(statusText(message.errorCode || (message.status === 'cancelled' ? 'cancelled' : 'agent_unavailable')));
      if (message.errorCode === 'save_failed') { setFormBusy(false); return; }
      state = null; saveState(); setFormBusy(false); closeSocket();
    }
  }
  function showError(message) {
    let alert = main.querySelector('[data-smash-client-error]');
    if (!alert) { alert = document.createElement('p'); alert.className = 'notice warning'; alert.dataset.smashClientError = ''; alert.setAttribute('role', 'alert'); progressPanel().before(alert); }
    alert.textContent = message;
  }
  function cancelRun() {
    if (state?.runId) send({ v: 1, type: 'cancel', runId: state.runId });
  }
  function formInput(form) {
    return { ingredients: String(form.elements.ingredients.value).trim(), servings: Number(form.elements.servings.value), preferences: String(form.elements.preferences.value).trim() };
  }
  main.querySelector('[data-smash-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state) return;
    const form = event.currentTarget;
    begin({ kind: 'generate', requestId: newId(), input: formInput(form) });
  });
  main.querySelector('[data-revision-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state) return;
    const form = event.currentTarget;
    const draftId = form.action.split('/').slice(-2, -1)[0];
    begin({ kind: 'revise', requestId: newId(), draftId: decodeURIComponent(draftId), instruction: String(form.elements.instruction.value).trim() });
  });
  if (existingRun) restoreProgressLog(existingRun);
  if (existingRun && existingRun.dataset.smashRunStatus === 'completed') setInputFormVisible(false);
  if (state) { setFormBusy(true); setProgress('reconnecting'); connect(); }
})();
