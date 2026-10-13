#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const { clearTimeout, setTimeout } = require('timers');
const { URL } = require('url');
const WebSocket = require('ws');

const DEFAULT_TIMEOUT_MS = 8_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isSafeLocalCdpUrl(value, protocols = ['http:', 'ws:']) {
  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol)
      && LOOPBACK_HOSTS.has(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && Boolean(parsed.port);
  } catch {
    return false;
  }
}

function requireSafeLocalCdpUrl(value, protocols) {
  if (!isSafeLocalCdpUrl(value, protocols)) {
    throw new Error('CDP is restricted to an explicit localhost URL with a port.');
  }
  return new URL(value);
}

function requestJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const parsed = requireSafeLocalCdpUrl(url, ['http:']);
  return new Promise((resolve, reject) => {
    const request = http.get(parsed, { timeout: timeoutMs }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`CDP discovery returned HTTP ${response.statusCode}.`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('CDP discovery returned invalid JSON.'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('CDP discovery timed out.')));
    request.on('error', reject);
  });
}

async function waitForTargets(baseUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await requestJson(new URL('/json/list', requireSafeLocalCdpUrl(
        baseUrl,
        ['http:']
      )).toString(), Math.min(DEFAULT_TIMEOUT_MS, timeoutMs));
      if (
        Array.isArray(targets)
        && targets.length
        && (!options.predicate || options.predicate(targets))
      ) return targets;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Simulator CDP targets did not become ready${lastError ? `: ${lastError.message}` : '.'}`);
}

function normalizeComparablePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^file:\/\//i, '')
    .replace(/^\/+([A-Za-z]:)/, '$1')
    .toLowerCase();
}

function selectAppTarget(targets, appDirectory = null) {
  if (!Array.isArray(targets)) return null;
  const expected = appDirectory ? normalizeComparablePath(path.resolve(appDirectory)) : null;
  const pages = targets.filter(target => target && target.type === 'page');
  if (expected) {
    const exact = pages.find(target => {
      const candidate = normalizeComparablePath(decodeURIComponent(String(target.url || '')));
      return candidate.startsWith(`${expected}/`) && candidate.endsWith('/index.html');
    });
    if (exact) return exact;
    return null;
  }
  return pages.find(target => /^piggietv$/i.test(String(target.title || '').trim())) ?? null;
}

function selectRcuTarget(targets) {
  if (!Array.isArray(targets)) return null;
  return targets.find(target => target
    && target.type === 'page'
    && /\/screen\/rcu\/index\.html(?:[?#]|$)/i.test(String(target.url || ''))) ?? null;
}

function selectShellTarget(targets) {
  if (!Array.isArray(targets)) return null;
  return targets.find(target => target
    && target.type === 'page'
    && /\/screen\/main\/index\.html(?:[?#]|$)/i.test(String(target.url || ''))) ?? null;
}

class CdpSession {
  constructor(webSocketDebuggerUrl, options = {}) {
    const safeUrl = requireSafeLocalCdpUrl(webSocketDebuggerUrl, ['ws:']);
    this.url = safeUrl.toString();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Set();
  }

  async connect() {
    if (this.socket) return this;
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, { handshakeTimeout: this.timeoutMs });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('CDP WebSocket connection timed out.'));
      }, this.timeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('message', data => this.handleMessage(data));
      socket.on('close', () => this.handleClose());
    });
    return this;
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed.'));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.eventListeners) listener(message);
  }

  handleClose() {
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP WebSocket closed.'));
    }
    this.pending.clear();
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  call(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP session is not connected.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async evaluate(expression, options = {}) {
    const result = await this.call('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
      userGesture: false,
      ...options
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed.');
    }
    return result.result?.value;
  }

  close() {
    if (this.socket) this.socket.close();
  }
}

async function connectTarget(target, options = {}) {
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error('The selected CDP target has no debugger WebSocket URL.');
  }
  return new CdpSession(target.webSocketDebuggerUrl, options).connect();
}

async function readDiagnosticSnapshot(session) {
  return session.evaluate(`(() => {
    const diagnostic = window.__ptvDiagnosticHealth;
    if (!diagnostic || !Object.isFrozen(diagnostic) || typeof diagnostic.snapshot !== 'function') {
      return null;
    }
    return diagnostic.snapshot();
  })()`);
}

async function readAppSurface(session) {
  return session.evaluate(`(() => ({
    bodyOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    cardCount: document.querySelectorAll('.ptv-poster-grid .ptv-card-btn').length,
    cardWidth: document.querySelector('.ptv-poster-grid .ptv-card-btn')?.getBoundingClientRect().width ?? null,
    focusedElements: document.querySelectorAll('[data-focus-id].is-focused, [data-focus-id]:focus').length,
    focusedId: document.activeElement?.getAttribute?.('data-focus-id') || null,
    focusedCardOffset: (() => {
      const cards = Array.from(document.querySelectorAll('.ptv-poster-grid .ptv-card-btn'));
      const offset = cards.indexOf(document.activeElement);
      return offset >= 0 ? offset : null;
    })(),
    documentVisibility: document.visibilityState,
    gridOverflow: (() => {
      const grid = document.querySelector('.ptv-poster-grid');
      return grid ? Math.max(0, grid.scrollWidth - grid.clientWidth) : null;
    })(),
    gridColumns: (() => {
      const grid = document.querySelector('.ptv-poster-grid');
      return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : null;
    })(),
    gridWidth: document.querySelector('.ptv-poster-grid')?.getBoundingClientRect().width ?? null,
    longTitleOverflow: Array.from(document.querySelectorAll('.ptv-card-title')).reduce((max, node) => {
      const card = node.closest('.ptv-card-btn');
      if (!card) return max;
      const titleRect = node.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      return Math.max(max, titleRect.right - cardRect.right, cardRect.left - titleRect.left, 0);
    }, 0),
    selectedFilterId: document.querySelector('.ptv-filter-bar [aria-current="true"]')
      ?.getAttribute('data-focus-id') || null,
    showsBusy: (() => {
      const viewport = document.querySelector('.ptv-browse--shows .ptv-browse__viewport');
      return viewport ? viewport.getAttribute('aria-busy') === 'true' : null;
    })(),
    showsError: Boolean(document.querySelector('.ptv-browse--shows .ptv-shows-error')),
    readyState: document.readyState,
    routeText: document.querySelector('main')?.getAttribute('aria-label') || null,
    title: document.title,
    viewport: { height: innerHeight, width: innerWidth }
  }))()`);
}

async function findRcuButtonCenter(session, key) {
  const allowed = new Set([
    'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Enter', 'Back', 'Home',
    'Play', 'Pause', 'Stop', 'Rewind', 'FastForward'
  ]);
  if (!allowed.has(key)) throw new Error(`Unsupported virtual RCU key: ${key}`);
  const testId = `buttonRCU-${key}`;
  const point = await session.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`Virtual RCU button was not found: ${key}`);
  }
  return point;
}

async function pressRcuKey(session, key, options = {}) {
  const point = await findRcuButtonCenter(session, key);
  const holdMs = Math.max(35, Math.min(options.holdMs ?? 75, key === 'Back' ? 700 : 2_000));
  await session.call('Input.dispatchMouseEvent', {
    button: 'none',
    buttons: 0,
    type: 'mouseMoved',
    x: point.x,
    y: point.y
  });
  await session.call('Input.dispatchMouseEvent', {
    button: 'left',
    buttons: 1,
    clickCount: 1,
    type: 'mousePressed',
    x: point.x,
    y: point.y
  });
  await new Promise(resolve => setTimeout(resolve, holdMs));
  await session.call('Input.dispatchMouseEvent', {
    button: 'left',
    buttons: 0,
    clickCount: 1,
    type: 'mouseReleased',
    x: point.x,
    y: point.y
  });
  await new Promise(resolve => setTimeout(resolve, options.settleMs ?? 125));
}

async function dispatchDpadKey(session, key, options = {}) {
  const definitions = {
    ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
    ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
    Back: { code: '', key: 'Unidentified', keyCode: 461 },
    Enter: { code: 'Enter', key: 'Enter', keyCode: 13 }
  };
  const definition = definitions[key];
  if (!definition) throw new Error(`Unsupported DPAD key: ${key}`);
  const params = {
    code: definition.code,
    key: definition.key,
    nativeVirtualKeyCode: definition.keyCode,
    windowsVirtualKeyCode: definition.keyCode
  };
  await session.call('Input.dispatchKeyEvent', { ...params, type: 'rawKeyDown' });
  await new Promise(resolve => setTimeout(resolve, Math.max(20, options.holdMs ?? 45)));
  await session.call('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
  await new Promise(resolve => setTimeout(resolve, options.settleMs ?? 125));
}

async function captureScreenshot(session, outputPath) {
  const result = await session.call('Page.captureScreenshot', {
    captureBeyondViewport: false,
    format: 'png',
    fromSurface: true
  }, 20_000);
  if (!result.data) throw new Error('CDP screenshot returned no image data.');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(result.data, 'base64'));
  return outputPath;
}

module.exports = {
  CdpSession,
  captureScreenshot,
  connectTarget,
  dispatchDpadKey,
  isSafeLocalCdpUrl,
  pressRcuKey,
  readAppSurface,
  readDiagnosticSnapshot,
  requestJson,
  requireSafeLocalCdpUrl,
  selectAppTarget,
  selectRcuTarget,
  selectShellTarget,
  waitForTargets
};
