import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleRequest, resolveAllowedOrigin, __internal } from '../src/index.js';

const ORIGIN = 'https://e25xld-ham.github.io';
const ENV = { ALLOWED_ORIGIN: ORIGIN };

// Padded well past __internal.MIN_UPSTREAM_BYTES (1024) so the new abnormal-
// -small-file guard doesn't reject this fixture — a real RadioID export is
// always far larger than that floor.
const PADDING_REMARKS = 'x'.repeat(1200);
const SAMPLE_CSV = [
  'RADIO_ID,CALLSIGN,FIRST_NAME,LAST_NAME,CITY,STATE,COUNTRY,REMARKS',
  '3101234,W1ABC,John,Smith,New York,NY,United States,',
  '5201234,HS1ABC,Somchai,Prasert,Bangkok,Bangkok,Thailand,',
  '5209999,HS9XYZ,Suda,Wongsakul,Chiang Mai,Chiang Mai,Thailand,',
  // duplicate RADIO_ID — must be deduped, first occurrence kept
  '5201234,HS1ABC-DUP,Somchai,Prasert,Bangkok,Bangkok,Thailand,',
  // COUNTRY says Thailand and LAST_NAME contains "520", but RADIO_ID does not start with 520
  `9991234,HS999,Fake,Contains520,Thailand City,Thailand,Thailand,${PADDING_REMARKS}`,
].join('\r\n') + '\r\n';

// beforeEach at file scope applies to every test below, regardless of which
// describe() it's nested in — required because the in-flight-collapse and
// /api/fetch cooldown state live at module scope in src/index.js and would
// otherwise leak between tests that run milliseconds apart.
beforeEach(() => {
  __internal.resetForTests();
});

function makeFakeCtx() {
  const waited = [];
  return { waitUntil: (p) => waited.push(p), _waited: waited };
}

function makeRequest(path, { method = 'GET', origin = ORIGIN } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  return new Request(`https://worker.example${path}`, { method, headers });
}

/** Replaces globalThis.fetch for the duration of `fn`, recording every call (url, init). */
async function withMockedFetch(impl, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Minimal in-memory Cache API stand-in, scoped to the duration of `fn`. */
async function withFakeEdgeCache(fn) {
  const original = globalThis.caches;
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(request) {
        return store.get(request.url);
      },
      async put(request, response) {
        store.set(request.url, response.clone());
      },
    },
  };
  try {
    return await fn();
  } finally {
    if (original === undefined) delete globalThis.caches;
    else globalThis.caches = original;
  }
}

function htmlErrorResponse() {
  return new Response('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

function sampleCsvResponse(extraHeaders = {}) {
  return new Response(SAMPLE_CSV, { status: 200, headers: { 'content-type': 'text/csv', ...extraHeaders } });
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
        assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
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
    // "cross-origin" (not "same-origin"/"same-site") is required — GitHub
    // Pages and the Worker are different origins by design.
    assert.equal(res.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  });

  test('CORS exposes Content-Disposition and X-Cache-Status to cross-origin JS', async () => {
    const res = await handleRequest(makeRequest('/api/status'), ENV, makeFakeCtx());
    const exposed = res.headers.get('Access-Control-Expose-Headers') || '';
    assert.match(exposed, /Content-Disposition/);
    assert.match(exposed, /X-Cache-Status/);
  });
});

describe('upstream request shape', () => {
  test('only ever fetches https://radioid.net/static/user.csv — never the API host or path', () => {
    assert.equal(__internal.UPSTREAM_PROTOCOL, 'https:');
    assert.equal(__internal.UPSTREAM_HOST, 'radioid.net');
    assert.equal(__internal.UPSTREAM_PATH, '/static/user.csv');
    assert.equal(__internal.UPSTREAM_URL, 'https://radioid.net/static/user.csv');
    assert.ok(!__internal.UPSTREAM_URL.includes('/api/'));
  });

  test('sends Accept, a descriptive User-Agent, and a fallback X-Client-Name header, and follows redirects', async () => {
    await withMockedFetch(
      () => sampleCsvResponse(),
      async (calls) => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.equal(res.status, 200);
        assert.equal(calls.length, 1);
        const { init } = calls[0];
        assert.equal(init.redirect, 'follow');
        const headers = new Headers(init.headers);
        assert.match(headers.get('Accept') || '', /text\/csv/);
        assert.match(headers.get('User-Agent') || '', /Thai-RadioID-Downloader/);
        assert.equal(headers.get('X-Client-Name'), 'Thai-RadioID-Downloader');
      },
    );
  });
});

describe('GET /api/fetch', () => {
  test('fetches, filters, dedupes, and returns a JSON summary with X-Cache-Status: MISS', async () => {
    await withMockedFetch(
      (url) => {
        assert.ok(String(url).startsWith('https://radioid.net/static/user.csv?v='));
        return sampleCsvResponse();
      },
      async () => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('X-Cache-Status'), 'MISS');
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
        return sampleCsvResponse();
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
      () => sampleCsvResponse(),
      async () => {
        const res = await handleRequest(makeRequest('/api/download'), ENV, makeFakeCtx());
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('Content-Type'), 'text/csv; charset=utf-8');
        assert.match(res.headers.get('Content-Disposition') || '', /^attachment; filename="radioid_thailand_520_\d{4}-\d{2}-\d{2}\.csv"$/);
        assert.equal(res.headers.get('Cache-Control'), 'no-store');
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
        assert.equal(res.headers.get('X-Cache-Status'), 'MISS');
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
      () => sampleCsvResponse(),
      async () => {
        const res = await handleRequest(makeRequest('/api/download'), ENV, makeFakeCtx());
        const text = await res.text();
        const dataLines = text.trim().split('\r\n').slice(1);
        assert.equal(dataLines.length, 2, 'all matching Thai records must be in the one file');
      },
    );
  });
});

describe('edge cache (Cache API)', () => {
  test('constant TTL is 30 minutes, and the cache key never embeds the upstream cache-busting timestamp', () => {
    assert.equal(__internal.EDGE_CACHE_TTL_SECONDS, 1800);
  });

  test('first /api/fetch is a cache MISS that hits upstream; a second is a cache HIT that does not', async () => {
    await withFakeEdgeCache(async () => {
      await withMockedFetch(
        () => sampleCsvResponse(),
        async (calls) => {
          const first = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
          assert.equal(first.headers.get('X-Cache-Status'), 'MISS');
          const firstBody = await first.json();
          assert.equal(firstBody.count, 2);
          assert.equal(calls.length, 1, 'first call must hit upstream');

          const second = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
          assert.equal(second.headers.get('X-Cache-Status'), 'HIT');
          const secondBody = await second.json();
          assert.equal(secondBody.count, 2);
          assert.equal(calls.length, 1, 'second call must be served from cache, not hit upstream again');
        },
      );
    });
  });

  test('/api/download reuses the same prepared cache /api/fetch populated', async () => {
    await withFakeEdgeCache(async () => {
      await withMockedFetch(
        () => sampleCsvResponse(),
        async (calls) => {
          await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
          assert.equal(calls.length, 1);

          const downloadRes = await handleRequest(makeRequest('/api/download'), ENV, makeFakeCtx());
          assert.equal(downloadRes.headers.get('X-Cache-Status'), 'HIT');
          assert.equal(calls.length, 1, '/api/download must not trigger a second upstream fetch');
        },
      );
    });
  });
});

describe('concurrent request collapse', () => {
  test('two simultaneous /api/fetch calls on the same isolate trigger exactly one upstream fetch', async () => {
    await withMockedFetch(
      async () => {
        // Yield a tick so both requests are genuinely in flight together
        // before either upstream call resolves.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return sampleCsvResponse();
      },
      async (calls) => {
        const [a, b] = await Promise.all([
          handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx()),
          handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx()),
        ]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(calls.length, 1, 'concurrent requests must collapse into a single upstream fetch');
      },
    );
  });
});

describe('/api/fetch cooldown (light rate limiting)', () => {
  test('a rapid second /api/fetch after a failure gets 429 with Retry-After, without a second upstream hit', async () => {
    await withMockedFetch(
      () => new Response('Service Unavailable', { status: 503 }),
      async (calls) => {
        const first = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.equal(first.status, 502);
        assert.equal(calls.length, 1);

        const second = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.equal(second.status, 429);
        const retryAfter = Number(second.headers.get('Retry-After'));
        assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);
        const body = await second.json();
        assert.equal(body.ok, false);
        assert.equal(body.error.code, 'RATE_LIMITED');
        assert.equal(calls.length, 1, 'the cooldown must prevent a second upstream hit');
      },
    );
  });

  test('/api/status is never subject to the /api/fetch cooldown', async () => {
    await withMockedFetch(
      () => new Response('Service Unavailable', { status: 503 }),
      async () => {
        await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        const statusRes = await handleRequest(makeRequest('/api/status'), ENV, makeFakeCtx());
        assert.equal(statusRes.status, 200);
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
        assert.equal(body.error.code, 'UPSTREAM_NETWORK_ERROR');
        assert.ok(body.error.message);
      },
    );
  });

  test('an AbortError (timeout) maps to UPSTREAM_TIMEOUT with a 504', async () => {
    await withMockedFetch(
      () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
      async () => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.equal(res.status, 504);
        const body = await res.json();
        assert.equal(body.error.code, 'UPSTREAM_TIMEOUT');
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
        assert.equal(body.error.code, 'UPSTREAM_BAD_STATUS');
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
      () => sampleCsvResponse({ 'content-length': String(500 * 1024 * 1024) }),
      async () => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.notEqual(res.status, 200);
        const body = await res.json();
        assert.equal(body.error.code, 'UPSTREAM_TOO_LARGE');
      },
    );
  });

  test('an abnormally small body is rejected rather than treated as valid (near-empty) data', async () => {
    await withMockedFetch(
      () => new Response('RADIO_ID\r\n1\r\n', { status: 200, headers: { 'content-type': 'text/csv' } }),
      async () => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.notEqual(res.status, 200);
        const body = await res.json();
        assert.equal(body.error.code, 'UPSTREAM_TOO_SMALL');
      },
    );
  });

  test('a JSON error body (e.g. an API error page) is rejected, not parsed as CSV', async () => {
    await withMockedFetch(
      () => new Response(JSON.stringify({ error: 'not found' }).padEnd(1200, ' '), { status: 200, headers: { 'content-type': 'application/json' } }),
      async () => {
        const res = await handleRequest(makeRequest('/api/fetch'), ENV, makeFakeCtx());
        assert.notEqual(res.status, 200);
        const body = await res.json();
        assert.equal(body.error.code, 'UPSTREAM_HTML_RESPONSE');
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

  test('falls back to the configured default for an unrecognized origin (never a wildcard)', () => {
    assert.equal(resolveAllowedOrigin('https://evil.example.com', ENV), ORIGIN);
    assert.notEqual(resolveAllowedOrigin('https://evil.example.com', ENV), '*');
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
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

describe('default export', () => {
  test('worker.fetch delegates to the same request handling', async () => {
    const res = await worker.fetch(makeRequest('/api/status'), ENV, makeFakeCtx());
    assert.equal(res.status, 200);
  });
});
