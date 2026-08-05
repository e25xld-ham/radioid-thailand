import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG,
  createApp,
  formatBangkokDateTime,
  formatThaiNumber,
  extractFilenameFromContentDisposition,
} from '../assets/app.js';

const BASE_URL = 'https://worker.example';

/** Minimal DOM stand-in supporting exactly what assets/app.js touches. */
function makeFakeDoc() {
  const registry = new Map();

  function makeElement() {
    const el = {
      disabled: false,
      hidden: false,
      textContent: '',
      href: '',
      download: '',
      rel: '',
      dataset: {},
      attributes: {},
      children: [],
      _listeners: {},
      addEventListener(type, handler) {
        (el._listeners[type] = el._listeners[type] || []).push(handler);
      },
      dispatch(type) {
        (el._listeners[type] || []).forEach((fn) => fn());
      },
      appendChild(child) {
        el.children.push(child);
        return child;
      },
      remove() {},
      click() {
        el.dispatch('click');
      },
      setAttribute(name, value) {
        el.attributes[name] = value;
      },
    };
    return el;
  }

  return {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id);
    },
    createElement() {
      return makeElement();
    },
    body: makeElement(),
  };
}

function makeUrlImplStub() {
  return { createObjectURL: () => 'blob:mock-url', revokeObjectURL: () => {} };
}

function statusOkFetch() {
  return { ok: true, status: 200, json: async () => ({ ok: true, service: 'x', source: 'y', filterPrefix: '520' }) };
}

describe('page load behavior', () => {
  test('only calls /api/status on load — never /api/fetch', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return statusOkFetch();
    };
    const app = createApp({ doc: makeFakeDoc(), fetchImpl, config: { API_BASE_URL: BASE_URL }, urlImpl: makeUrlImplStub() });

    // Mirrors the real bootstrap: DOMContentLoaded -> createApp -> checkStatus().
    await app.checkStatus();

    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith(`${BASE_URL}/api/status`));
    assert.ok(!calls.some((c) => c.includes('/api/fetch')), '/api/fetch must never be called on page load');
  });
});

describe('download button gating', () => {
  test('is disabled immediately after app creation, before any fetch', () => {
    const app = createApp({ doc: makeFakeDoc(), fetchImpl: async () => statusOkFetch(), config: { API_BASE_URL: BASE_URL }, urlImpl: makeUrlImplStub() });
    assert.equal(app.els.downloadBtn.disabled, true);
  });

  test('stays disabled after a failed /api/fetch, and enables only after a success', async () => {
    let mode = 'fail';
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/api/fetch')) {
        if (mode === 'fail') {
          return { ok: false, status: 502, json: async () => ({ ok: false, error: 'BAD_STATUS', message: 'ผิดพลาด' }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            count: 3,
            duplicateCount: 0,
            fetchedAt: new Date().toISOString(),
            sourceUpdatedAt: null,
            downloadUrl: '/api/download',
            columns: ['RADIO_ID', 'CALLSIGN'],
            sample: [['5201234', 'HS1ABC']],
          }),
        };
      }
      return statusOkFetch();
    };
    const app = createApp({ doc: makeFakeDoc(), fetchImpl, config: { API_BASE_URL: BASE_URL }, urlImpl: makeUrlImplStub() });

    assert.equal(app.els.downloadBtn.disabled, true);

    await app.fetchLatest();
    assert.equal(app.els.downloadBtn.disabled, true, 'must remain disabled after a failed fetch');
    assert.equal(app.els.errorBanner.hidden, false);

    mode = 'ok';
    await app.fetchLatest();
    assert.equal(app.els.downloadBtn.disabled, false, 'must become enabled after a successful fetch');
    assert.equal(app.els.resultCount.textContent, 'พบรายชื่อ DMR ID ประเทศไทย 3 รายชื่อ');
  });
});

describe('duplicate click protection', () => {
  test('a second fetchLatest() call while one is in flight makes no extra network request', async () => {
    let fetchCalls = 0;
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/api/fetch')) {
        fetchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, count: 1, duplicateCount: 0, fetchedAt: new Date().toISOString(), sourceUpdatedAt: null, downloadUrl: '/api/download', columns: [], sample: [] }),
        };
      }
      return statusOkFetch();
    };
    const app = createApp({ doc: makeFakeDoc(), fetchImpl, config: { API_BASE_URL: BASE_URL }, urlImpl: makeUrlImplStub() });

    const first = app.fetchLatest();
    const second = app.fetchLatest();
    await Promise.all([first, second]);

    assert.equal(fetchCalls, 1, 'the in-flight guard must prevent a duplicate upstream call');
  });

  test('downloadCsv() is a no-op while the download button is not yet ready', async () => {
    let downloadCalls = 0;
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/api/download')) downloadCalls += 1;
      return statusOkFetch();
    };
    const app = createApp({ doc: makeFakeDoc(), fetchImpl, config: { API_BASE_URL: BASE_URL }, urlImpl: makeUrlImplStub() });
    await app.downloadCsv();
    assert.equal(downloadCalls, 0);
  });
});

describe('single source of truth for the Worker URL', () => {
  test('CONFIG.API_BASE_URL is the only base URL used to build both endpoint calls', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return statusOkFetch();
    };
    const app = createApp({ doc: makeFakeDoc(), fetchImpl, config: { API_BASE_URL: 'https://custom-worker.example' }, urlImpl: makeUrlImplStub() });
    await app.checkStatus();
    await app.fetchLatest();
    assert.ok(calls.every((c) => c.startsWith('https://custom-worker.example/')));
  });

  test('the exported CONFIG has a single API_BASE_URL field', () => {
    assert.equal(typeof CONFIG.API_BASE_URL, 'string');
    assert.ok(CONFIG.API_BASE_URL.startsWith('https://'));
  });
});

describe('formatThaiNumber', () => {
  test('adds thousands separators', () => {
    assert.equal(formatThaiNumber(2221), '2,221');
    assert.equal(formatThaiNumber(0), '0');
  });
});

describe('formatBangkokDateTime', () => {
  test('formats an ISO timestamp into a Thai Buddhist-era date string', () => {
    const formatted = formatBangkokDateTime('2026-08-05T14:00:00.000Z');
    assert.match(formatted, /2569/); // 2026 CE -> 2569 BE
    assert.match(formatted, /เวลาไทย/);
  });

  test('returns a placeholder for missing input', () => {
    assert.equal(formatBangkokDateTime(null), '-');
  });
});

describe('extractFilenameFromContentDisposition', () => {
  test('extracts a quoted filename', () => {
    const name = extractFilenameFromContentDisposition('attachment; filename="radioid_thailand_520_2026-08-05.csv"');
    assert.equal(name, 'radioid_thailand_520_2026-08-05.csv');
  });

  test('returns null when the header is missing', () => {
    assert.equal(extractFilenameFromContentDisposition(null), null);
  });
});
