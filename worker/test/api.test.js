import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleRequest, resolveAllowedOrigin } from '../src/index.js';

const ORIGIN = 'https://e25xld-ham.github.io';
const ENV = { ALLOWED_ORIGIN: ORIGIN };

const SAMPLE_CSV = [
  'RADIO_ID,CALLSIGN,FIRST_NAME,LAST_NAME,CITY,STATE,COUNTRY,REMARKS',
  '3101234,W1ABC,John,Smith,New York,NY,United States,',
  '5201234,HS1ABC,Somchai,Prasert,Bangkok,Bangkok,Thailand,',
  '5209999,HS9XYZ,Suda,Wongsakul,Chiang Mai,Chiang Mai,Thailand,',
  // duplicate RADIO_ID — must be deduped, first occurrence kept
  '5201234,HS1ABC-DUP,Somchai,Prasert,Bangkok,Bangkok,Thailand,',
  // COUNTRY says Thailand and LAST_NAME contains "520", but RADIO_ID does not start with 520
  '9991234,HS999,Fake,Contains520,Thailand City,Thailand,Thailand,',
].join('\r\n') + '\r\n';

function makeFakeCtx() {
  const waited = [];
  return { waitUntil: (p) => waited.push(p), _waited: waited };
}

function makeRequest(path, { method = 'GET', origin = ORIGIN } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  return new Request(`https://worker.example${path}`, { method, headers });
}

/** Replaces globalThis.fetch for the duration of `fn`, recording every call. */
async function withMockedFetch(impl, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return impl(...args);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function htmlErrorResponse() {
  return new Response('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

describe('GET /api/status', () => {
  test('returns service info without ever calling upstream fetch', async () => {
    await withMockedFetch(
      () => {
        throw new Error('upstream must not be called by /api/status');
      },
      async (calls) => {
        const res = await handleRequest(makeRequest('/api/status'), ENV, makeFakeCtx());
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.service, 'Thai RadioID Downloader');
        assert.equal(body.source, 'https://radioid.net/static/user.csv');
        assert.equal(body.filterPrefix, '520');
        assert.equal(calls.length, 0, 'expected zero upstream fetch calls');
      },
    );
  });
});

describe('method restrictions', () => {
  test('POST is rejected with 405 and upstream is never touched', async () => {
    await withMockedFetch(
      () => {
        throw new Error('upstream must not be called for a rejected method');
      },
      async (calls) => {
        const res = await handleRequest(makeRequest('/api/fetch', { method: 'POST' }), ENV, makeFakeCtx());
        assert.equal(res.status, 405);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(calls.length, 0);
      },
    );
  });

  test('DELETE is rejected with 405', async () => {
    const res = await handleRequest(makeRequest('/api/status', { method: 'DELETE' }), ENV, makeFakeCtx());
    assert.equal(res.status, 405);
  });

  test('OPTIONS returns a CORS preflight response', async () => {
    const res = await handleRequest(makeRequest('/api/fetch', { method: 'OPTIONS' }), ENV, makeFakeCtx());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.match(res.headers.get('Access-Control-Allow-Methods') || '', /GET/);
  });
});

describe('security headers', () => {
  test('every response carries the required security headers', async () => {
    const res = await handleRequest(makeRequest('/api/status'), ENV, makeFakeCtx());
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
    assert.ok(res.headers.get('Permissions-Policy'));
  });
});

describe('GET /api/fetch', () => {
  test('fetches, filters, dedupes, and returns a JSON summary', async () => {
    await withMockedFetch(
      (url) => {
        assert.ok(String(url).startsWith('https://radioid.net/static/user.csv?v='));
        return new Response(SAMPLE_CSV, { status: 200, headers: { 'content-type': 'text/csv' } });
      },
      async () => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.count, 2);
        assert.equal(body.duplicateCount, 1);
        assert.equal(body.downloadUrl, '/api/download');
        assert.ok(Array.isArray(body.columns));
        assert.ok(body.columns.includes('RADIO_ID'));
        assert.ok(body.sample.length <= 10);
      },
    );
  });

  test('never hard-codes the cache-busting version value', async () => {
    await withMockedFetch(
      (url) => {
        const versionParam = new URL(String(url)).searchParams.get('v');
        assert.ok(versionParam && versionParam.length > 0);
        assert.notEqual(versionParam, '2026-08-05_050149.031257');
        return new Response(SAMPLE_CSV, { status: 200, headers: { 'content-type': 'text/csv' } });
      },
      async () => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.equal(res.status, 200);
      },
    );
  });
});

describe('GET /api/download', () => {
  test('returns a single CSV file with correct headers, BOM, sorting, and no duplicates', async () => {
    await withMockedFetch(
      () => new Response(SAMPLE_CSV, { status: 200, headers: { 'content-type': 'text/csv' } }),
      async () => {
        const res = await handleRequest(makeRequest('/api/download'), ENV, makeFakeCtx());
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('Content-Type'), 'text/csv; charset=utf-8');
        assert.match(res.headers.get('Content-Disposition') || '', /^attachment; filename="radioid_thailand_520_\d{4}-\d{2}-\d{2}\.csv"$/);
        assert.equal(res.headers.get('Cache-Control'), 'no-store');
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
        // A cross-origin fetch() hides Content-Disposition from JS unless the
        // server explicitly exposes it — without this, the frontend's
        // filename extraction silently falls back to a generic name.
        assert.match(res.headers.get('Access-Control-Expose-Headers') || '', /Content-Disposition/);

        // Response.text() decodes as UTF-8 and, per the WHATWG spec, strips a
        // leading BOM as an encoding signature — so to confirm the BOM bytes
        // actually went out on the wire (what Excel checks), read raw bytes.
        const bytes = new Uint8Array(await res.clone().arrayBuffer());
        assert.equal(bytes[0], 0xef, 'byte 0 must be the UTF-8 BOM (EF BB BF)');
        assert.equal(bytes[1], 0xbb, 'byte 1 must be the UTF-8 BOM (EF BB BF)');
        assert.equal(bytes[2], 0xbf, 'byte 2 must be the UTF-8 BOM (EF BB BF)');

        const text = await res.text();
        const lines = text.trim().split('\r\n');
        assert.equal(lines[0], 'RADIO_ID,CALLSIGN,FIRST_NAME,LAST_NAME,CITY,STATE,COUNTRY,REMARKS');
        // header + 2 unique Thai rows, no index column, no duplicates, ascending RADIO_ID
        assert.equal(lines.length, 3);
        assert.ok(lines[1].startsWith('5201234,'));
        assert.ok(lines[2].startsWith('5209999,'));
        assert.equal(text.includes('HS1ABC-DUP'), false, 'duplicate record must not appear');
      },
    );
  });

  test('does not split output into multiple files or paginate — single response body', async () => {
    await withMockedFetch(
      () => new Response(SAMPLE_CSV, { status: 200, headers: { 'content-type': 'text/csv' } }),
      async () => {
        const res = await handleRequest(makeRequest('/api/download'), ENV, makeFakeCtx());
        const text = await res.text();
        const dataLines = text.trim().split('\r\n').slice(1);
        assert.equal(dataLines.length, 2, 'all matching Thai records must be in the one file');
      },
    );
  });
});

describe('upstream failure handling', () => {
  test('a network error on /api/fetch produces a JSON error, never a fabricated success', async () => {
    await withMockedFetch(
      () => {
        throw new Error('simulated network failure');
      },
      async () => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.notEqual(res.status, 200);
        assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.ok(body.error);
      },
    );
  });

  test('a network error on /api/download never returns an empty (or any) CSV file', async () => {
    await withMockedFetch(
      () => {
        throw new Error('simulated network failure');
      },
      async () => {
        const res = await handleRequest(makeRequest('/api/download'), ENV, makeFakeCtx());
        assert.notEqual(res.status, 200);
        assert.notEqual(res.headers.get('Content-Type'), 'text/csv; charset=utf-8');
        const body = await res.json();
        assert.equal(body.ok, false);
      },
    );
  });

  test('a non-200 upstream status is treated as failure, not an empty result', async () => {
    await withMockedFetch(
      () => new Response('Service Unavailable', { status: 503 }),
      async () => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.equal(res.status, 502);
        const body = await res.json();
        assert.equal(body.ok, false);
      },
    );
  });

  test('an HTML error page disguised as a 200 response is rejected, not parsed as data', async () => {
    await withMockedFetch(
      () => htmlErrorResponse(),
      async () => {
        const res = await handleRequest(makeRequest('/api/download'), ENV, makeFakeCtx());
        assert.notEqual(res.status, 200);
        assert.notEqual(res.headers.get('Content-Type'), 'text/csv; charset=utf-8');
      },
    );
  });

  test('an oversized Content-Length is rejected before the body is read', async () => {
    await withMockedFetch(
      () =>
        new Response(SAMPLE_CSV, {
          status: 200,
          headers: { 'content-type': 'text/csv', 'content-length': String(500 * 1024 * 1024) },
        }),
      async () => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.notEqual(res.status, 200);
        const body = await res.json();
        assert.equal(body.error, 'TOO_LARGE');
      },
    );
  });
});

describe('resolveAllowedOrigin', () => {
  test('reflects an origin that is explicitly allow-listed', () => {
    assert.equal(resolveAllowedOrigin(ORIGIN, ENV), ORIGIN);
  });

  test('always allows localhost for local development regardless of ALLOWED_ORIGIN', () => {
    assert.equal(resolveAllowedOrigin('http://localhost:8788', ENV), 'http://localhost:8788');
    assert.equal(resolveAllowedOrigin('http://127.0.0.1:8788', ENV), 'http://127.0.0.1:8788');
  });

  test('falls back to the configured default for an unrecognized origin', () => {
    assert.equal(resolveAllowedOrigin('https://evil.example.com', ENV), ORIGIN);
  });

  test('supports a comma-separated ALLOWED_ORIGIN list', () => {
    const env = { ALLOWED_ORIGIN: 'https://a.example.com, https://b.example.com' };
    assert.equal(resolveAllowedOrigin('https://b.example.com', env), 'https://b.example.com');
  });
});

describe('unknown routes', () => {
  test('returns 404 JSON for an unmapped path', async () => {
    const res = await handleRequest(makeRequest('/api/does-not-exist'), ENV, makeFakeCtx());
    assert.equal(res.status, 404);
  });
});

describe('default export', () => {
  test('worker.fetch delegates to the same request handling', async () => {
    const res = await worker.fetch(makeRequest('/api/status'), ENV, makeFakeCtx());
    assert.equal(res.status, 200);
  });
});
