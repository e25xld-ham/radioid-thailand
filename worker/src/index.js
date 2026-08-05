/**
 * Thai RadioID Downloader — Cloudflare Worker API
 *
 * Endpoints:
 *   GET  /api/status   - health check only, never touches upstream
 *   GET  /api/fetch     - fetches RadioID.net user.csv, filters Thai (520) records, caches 30 min
 *   GET  /api/download - streams the filtered dataset back as a single CSV file
 *
 * This file is written so its pure logic (CSV parsing, filtering, dedupe,
 * CSV building) can be imported and unit tested directly from Node with
 * `node --test`, in addition to running as a Cloudflare Worker.
 */

// ---------------------------------------------------------------------------
// Configuration constants (intentionally not configurable via query params —
// the upstream host and path are fixed here so this Worker can never be used
// as an open proxy to arbitrary hosts).
// ---------------------------------------------------------------------------

const UPSTREAM_HOST = 'radioid.net';
const UPSTREAM_PROTOCOL = 'https:';
const UPSTREAM_PATH = '/static/user.csv';
const UPSTREAM_URL = `${UPSTREAM_PROTOCOL}//${UPSTREAM_HOST}${UPSTREAM_PATH}`;
const FILTER_PREFIX = '520';
const SERVICE_NAME = 'Thai RadioID Downloader';

const UPSTREAM_TIMEOUT_MS = 45000; // required 45s window
const MIN_UPSTREAM_BYTES = 1024; // a real RadioID export is always far larger than this
const MAX_UPSTREAM_BYTES = 150 * 1024 * 1024; // sanity ceiling against abnormal upstream responses
const EDGE_CACHE_TTL_SECONDS = 1800; // 30 minutes, temporary only — not a database
const FETCH_COOLDOWN_MS = 20000; // isolate-local guard against rapid re-fetch bursts on a cache miss
const DEFAULT_ALLOWED_ORIGIN = 'https://e25xld-ham.github.io';
const CACHE_URL = 'https://cache.internal.radioid-thailand.invalid/latest-thai-dataset';

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180 state machine) — no split(',') anywhere.
// ---------------------------------------------------------------------------

/**
 * Parses CSV text into { headers, rows }. Handles quoted fields, commas and
 * newlines inside quoted fields, doubled-quote escaping (""), both CRLF and
 * bare LF line endings, empty fields, and a leading UTF-8 BOM.
 * @param {string} input
 * @returns {{ headers: string[], rows: string[][] }}
 */
export function parseCSV(input) {
  if (typeof input !== 'string') {
    throw new TypeError('parseCSV expects a string');
  }
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawAnyContentInRow = false;
  const len = text.length;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    records.push(row);
    row = [];
    sawAnyContentInRow = false;
  };

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawAnyContentInRow = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      sawAnyContentInRow = true;
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        endRow();
        i += 2;
        continue;
      }
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }

    sawAnyContentInRow = true;
    field += ch;
    i += 1;
  }

  // Flush trailing field/row if the input didn't end with a newline.
  if (field.length > 0 || sawAnyContentInRow) {
    endRow();
  }

  // Drop fully blank trailing lines (e.g. a single trailing newline yields ['']).
  const cleaned = records.filter((r) => !(r.length === 1 && r[0] === ''));

  const headers = cleaned.length > 0 ? cleaned[0] : [];
  const rows = cleaned.slice(1);
  return { headers, rows };
}

/** Normalizes a header name for case/whitespace-insensitive comparison. */
export function normalizeHeaderName(name) {
  return String(name == null ? '' : name).trim().toUpperCase();
}

/** Finds the index of the RADIO_ID column, tolerant of case variations. */
export function findRadioIdIndex(headers) {
  return headers.findIndex((h) => normalizeHeaderName(h) === 'RADIO_ID');
}

/**
 * True when the given RADIO_ID cell value is a Thai DMR ID: purely numeric
 * (after trimming) and starting with "520". Deliberately does NOT look at
 * any other column, and does NOT substring-search the raw line.
 */
export function isThaiRadioId(value) {
  if (value == null) return false;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return false;
  if (!/^\d+$/.test(trimmed)) return false;
  return trimmed.startsWith(FILTER_PREFIX);
}

/**
 * Filters rows to Thai RADIO_IDs, removes duplicate RADIO_IDs (keeping the
 * first occurrence), and sorts the result ascending by RADIO_ID (numeric).
 * @returns {{ rows: string[][], duplicateCount: number }}
 */
export function filterDedupeSortThai(headers, rows) {
  const radioIdIndex = findRadioIdIndex(headers);
  if (radioIdIndex === -1) {
    const err = new Error('RADIO_ID column not found in source headers');
    err.code = 'MISSING_COLUMN';
    throw err;
  }

  const seen = new Set();
  let duplicateCount = 0;
  const thaiRows = [];

  for (const row of rows) {
    const raw = row[radioIdIndex];
    if (!isThaiRadioId(raw)) continue;
    const id = String(raw).trim();
    if (seen.has(id)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(id);
    thaiRows.push(row);
  }

  thaiRows.sort((a, b) => {
    const na = Number(String(a[radioIdIndex]).trim());
    const nb = Number(String(b[radioIdIndex]).trim());
    return na - nb;
  });

  return { rows: thaiRows, duplicateCount };
}

/** Escapes a single CSV field per RFC 4180. */
function csvEscapeField(value) {
  const str = value == null ? '' : String(value);
  if (/["\r\n,]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Builds a complete CSV document (with UTF-8 BOM and CRLF line endings so it
 * opens correctly, including Thai text, in Microsoft Excel).
 */
export function buildCSV(headers, rows) {
  const lines = [headers.map(csvEscapeField).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvEscapeField).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Heuristic check for an HTML error page returned instead of CSV data. */
export function looksLikeHtml(text) {
  const head = text.slice(0, 512).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

/** Cache-busting token in the same shape RadioID.net's own site uses. */
export function buildCacheBustToken(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  const micro = pad(date.getUTCMilliseconds(), 3) + '000';
  return `${yyyy}-${mm}-${dd}_${hh}${mi}${ss}.${micro}`;
}

/** Formats a date as YYYY-MM-DD in the Asia/Bangkok timezone. */
export function formatBangkokDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

export class UpstreamError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Reads a fetch Response body as text while enforcing a byte-size ceiling. */
async function readTextWithLimit(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new UpstreamError('UPSTREAM_TOO_LARGE', 'ไฟล์ต้นฉบับมีขนาดใหญ่เกินกำหนด');
    }
    return { text: new TextDecoder('utf-8').decode(buf), byteSize: buf.byteLength };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError('UPSTREAM_TOO_LARGE', 'ไฟล์ต้นฉบับมีขนาดใหญ่เกินกำหนด');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, byteSize: total };
}

// ---------------------------------------------------------------------------
// Upstream fetch + filter pipeline
// ---------------------------------------------------------------------------

/**
 * Downloads user.csv from RadioID.net with a fresh cache-busting query,
 * validates the response, parses it, and returns only Thai (520) records.
 * Throws UpstreamError (with a Thai-language message) on any failure —
 * callers must never synthesize a CSV response when this throws.
 */
export async function fetchAndFilterThai(fetchImpl = fetch) {
  const token = buildCacheBustToken();
  const url = `${UPSTREAM_URL}?v=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.1',
        // Cloudflare Workers' server-side fetch() permits a custom User-Agent
        // (unlike browser fetch(), which forbids it) — set both this and a
        // dedicated identifying header as a defensive fallback in case a
        // future runtime restricts the former.
        'User-Agent': 'Thai-RadioID-Downloader/1.0 (E25XLD; GitHub: e25xld-ham/radioid-thailand)',
        'X-Client-Name': 'Thai-RadioID-Downloader',
      },
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new UpstreamError('UPSTREAM_TIMEOUT', 'ไม่สามารถดาวน์โหลดฐานข้อมูล RadioID ได้ภายในเวลาที่กำหนด');
    }
    throw new UpstreamError('UPSTREAM_NETWORK_ERROR', 'ไม่สามารถเชื่อมต่อไปยัง RadioID.net ได้ กรุณาลองใหม่อีกครั้งภายหลัง');
  } finally {
    clearTimeout(timer);
  }

  if (response.status !== 200) {
    throw new UpstreamError('UPSTREAM_BAD_STATUS', `RadioID.net ตอบกลับสถานะ HTTP ${response.status}`, {
      status: response.status,
    });
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    throw new UpstreamError('UPSTREAM_HTML_RESPONSE', 'RadioID.net ส่งข้อมูลกลับมาผิดรูปแบบ (คาดว่าเป็นหน้า error)');
  }

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_UPSTREAM_BYTES) {
    throw new UpstreamError('UPSTREAM_TOO_LARGE', 'ไฟล์ต้นฉบับมีขนาดใหญ่เกินกำหนด');
  }
  if (declaredLength > 0 && declaredLength < MIN_UPSTREAM_BYTES) {
    throw new UpstreamError('UPSTREAM_TOO_SMALL', 'ไฟล์ต้นฉบับมีขนาดเล็กผิดปกติ อาจไม่ใช่ข้อมูลที่ถูกต้อง');
  }

  const { text, byteSize } = await readTextWithLimit(response, MAX_UPSTREAM_BYTES);

  if (!text || text.trim().length === 0) {
    throw new UpstreamError('UPSTREAM_EMPTY_RESPONSE', 'RadioID.net ส่งข้อมูลว่างกลับมา กรุณาลองใหม่อีกครั้ง');
  }
  if (byteSize < MIN_UPSTREAM_BYTES) {
    throw new UpstreamError('UPSTREAM_TOO_SMALL', 'ไฟล์ต้นฉบับมีขนาดเล็กผิดปกติ อาจไม่ใช่ข้อมูลที่ถูกต้อง');
  }
  if (looksLikeHtml(text)) {
    throw new UpstreamError('UPSTREAM_HTML_RESPONSE', 'RadioID.net ส่งข้อมูลกลับมาผิดรูปแบบ (คาดว่าเป็นหน้า error)');
  }

  const { headers, rows } = parseCSV(text);
  if (headers.length === 0) {
    throw new UpstreamError('UPSTREAM_PARSE_ERROR', 'ไม่สามารถอ่านโครงสร้างไฟล์ CSV จาก RadioID.net ได้');
  }

  let filtered;
  try {
    filtered = filterDedupeSortThai(headers, rows);
  } catch (err) {
    if (err && err.code === 'MISSING_COLUMN') {
      throw new UpstreamError('UPSTREAM_MISSING_COLUMN', 'ไม่พบคอลัมน์ RADIO_ID ในไฟล์ต้นฉบับ');
    }
    throw new UpstreamError('UPSTREAM_PARSE_ERROR', 'ประมวลผลไฟล์ CSV จาก RadioID.net ไม่สำเร็จ');
  }

  const lastModifiedHeader = response.headers.get('last-modified');
  const sourceUpdatedAt = lastModifiedHeader ? new Date(lastModifiedHeader).toISOString() : null;

  return {
    headers,
    rows: filtered.rows,
    duplicateCount: filtered.duplicateCount,
    count: filtered.rows.length,
    fetchedAt: new Date().toISOString(),
    sourceUpdatedAt,
    byteSize,
    totalUpstreamRows: rows.length,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing: CORS, security headers, JSON helpers, logging
// ---------------------------------------------------------------------------

function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

function getConfiguredOrigins(env) {
  const raw = (env && env.ALLOWED_ORIGIN) || DEFAULT_ALLOWED_ORIGIN;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Decides which single Access-Control-Allow-Origin value to send back. */
export function resolveAllowedOrigin(requestOrigin, env) {
  const allowList = getConfiguredOrigins(env);
  if (requestOrigin && (allowList.includes(requestOrigin) || isLocalhostOrigin(requestOrigin))) {
    return requestOrigin;
  }
  return allowList[0] || DEFAULT_ALLOWED_ORIGIN;
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    // "cross-origin" (not "same-origin") is required here — GitHub Pages and
    // the Worker are different origins by design, and a stricter value would
    // let the CORS headers below pass while still having the browser block
    // the response at the CORP layer.
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
}

function corsHeaders(allowedOrigin) {
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Expose-Headers': 'Content-Disposition, X-Cache-Status',
    Vary: 'Origin',
  };
}

function jsonResponse(payload, status, allowedOrigin, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...securityHeaders(),
      ...corsHeaders(allowedOrigin),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/** Constant JSON error shape: { ok: false, error: { code, message } }. Never includes a stack trace. */
function jsonError(code, message, status, allowedOrigin, extraHeaders = {}) {
  return jsonResponse({ ok: false, error: { code, message } }, status, allowedOrigin, extraHeaders);
}

/** Only logs operational metadata — never person-identifying CSV content. */
function logEvent(fields) {
  try {
    console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
  } catch {
    // logging must never break the request
  }
}

const UPSTREAM_ERROR_STATUS = {
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_NETWORK_ERROR: 502,
  UPSTREAM_BAD_STATUS: 502,
  UPSTREAM_HTML_RESPONSE: 502,
  UPSTREAM_TOO_LARGE: 502,
  UPSTREAM_TOO_SMALL: 502,
  UPSTREAM_EMPTY_RESPONSE: 502,
  UPSTREAM_PARSE_ERROR: 502,
  UPSTREAM_MISSING_COLUMN: 502,
};

function errorResponse(err, allowedOrigin) {
  if (err instanceof UpstreamError) {
    const status = UPSTREAM_ERROR_STATUS[err.code] || 502;
    logEvent({ endpoint: 'error', status, errorClass: err.code });
    return jsonError(err.code, err.message, status, allowedOrigin);
  }
  logEvent({ endpoint: 'error', status: 500, errorClass: 'INTERNAL_ERROR' });
  return jsonError('INTERNAL_ERROR', 'เกิดข้อผิดพลาดที่ไม่คาดคิดฝั่งเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง', 500, allowedOrigin);
}

// ---------------------------------------------------------------------------
// Edge cache (Cache API) — temporary only, max 30 minutes, not a database.
// Falls back to "no cache" transparently when the Cache API isn't available
// (e.g. running under plain Node for tests). The cache key is a fixed,
// synthetic URL — never derived from the upstream cache-busting timestamp —
// so /api/fetch and /api/download always share the same prepared result.
// ---------------------------------------------------------------------------

function getEdgeCache() {
  if (typeof caches !== 'undefined' && caches && caches.default) {
    return caches.default;
  }
  return null;
}

function getCacheRequest() {
  return new Request(CACHE_URL, { method: 'GET' });
}

async function readCache() {
  const cache = getEdgeCache();
  if (!cache) return null;
  const hit = await cache.match(getCacheRequest());
  if (!hit) return null;
  try {
    return await hit.json();
  } catch {
    return null;
  }
}

function writeCache(ctx, data) {
  const cache = getEdgeCache();
  if (!cache) return;
  const cacheResponse = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `max-age=${EDGE_CACHE_TTL_SECONDS}`,
    },
  });
  const putPromise = cache.put(getCacheRequest(), cacheResponse);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(putPromise);
  }
}

// Collapses concurrent requests that land on the same warm isolate into a
// single upstream fetch, so a user double-clicking (or two tabs) while a
// request is already in flight doesn't trigger duplicate RadioID.net hits.
let inFlightFetch = null;
// Isolate-local timestamp of the last upstream fetch *start*, used only for
// the /api/fetch cooldown below — not a substitute for the edge cache.
let lastUpstreamFetchStartedAt = 0;

function fetchThaiOnce() {
  if (!inFlightFetch) {
    lastUpstreamFetchStartedAt = Date.now();
    inFlightFetch = fetchAndFilterThai().finally(() => {
      inFlightFetch = null;
    });
  }
  return inFlightFetch;
}

function withinFetchCooldown() {
  if (lastUpstreamFetchStartedAt === 0) return false;
  return Date.now() - lastUpstreamFetchStartedAt < FETCH_COOLDOWN_MS;
}

function fetchCooldownRemainingSeconds() {
  const remainingMs = FETCH_COOLDOWN_MS - (Date.now() - lastUpstreamFetchStartedAt);
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/** Fetches fresh data from upstream, writes it to the edge cache, and logs (no personal data). */
async function fetchFreshAndCache(ctx) {
  const result = await fetchThaiOnce();
  const data = {
    headers: result.headers,
    rows: result.rows,
    count: result.count,
    duplicateCount: result.duplicateCount,
    fetchedAt: result.fetchedAt,
    sourceUpdatedAt: result.sourceUpdatedAt,
  };
  writeCache(ctx, data);
  logEvent({
    endpoint: 'fetch-upstream',
    status: 200,
    byteSize: result.byteSize,
    totalUpstreamRows: result.totalUpstreamRows,
    thaiRowCount: result.count,
    duplicateCount: result.duplicateCount,
  });
  return data;
}

/** Gets the current Thai dataset from cache, or fetches+filters fresh from upstream. */
async function getThaiDataset(ctx) {
  const cached = await readCache();
  if (cached) {
    return { data: cached, cacheHit: true };
  }
  const data = await fetchFreshAndCache(ctx);
  return { data, cacheHit: false };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleStatus(allowedOrigin) {
  logEvent({ endpoint: 'status', status: 200 });
  return jsonResponse(
    {
      ok: true,
      service: SERVICE_NAME,
      source: UPSTREAM_URL,
      filterPrefix: FILTER_PREFIX,
    },
    200,
    allowedOrigin,
  );
}

function toFetchSummary(data) {
  return {
    ok: true,
    count: data.count,
    duplicateCount: data.duplicateCount,
    sourceUpdatedAt: data.sourceUpdatedAt,
    fetchedAt: data.fetchedAt,
    downloadUrl: '/api/download',
    columns: data.headers,
    sample: data.rows.slice(0, 10),
  };
}

async function handleFetch(ctx, allowedOrigin, startedAt) {
  const cached = await readCache();
  if (cached) {
    logEvent({ endpoint: 'fetch', status: 200, cacheHit: true, thaiRowCount: cached.count, elapsedMs: Date.now() - startedAt });
    return jsonResponse(toFetchSummary(cached), 200, allowedOrigin, { 'X-Cache-Status': 'HIT' });
  }

  if (!inFlightFetch && withinFetchCooldown()) {
    const retryAfterSeconds = fetchCooldownRemainingSeconds();
    logEvent({ endpoint: 'fetch', status: 429, retryAfterSeconds });
    return jsonError(
      'RATE_LIMITED',
      `กำลังดึงข้อมูลบ่อยเกินไป กรุณารอ ${retryAfterSeconds} วินาทีแล้วลองใหม่อีกครั้ง`,
      429,
      allowedOrigin,
      { 'Retry-After': String(retryAfterSeconds), 'X-Cache-Status': 'MISS' },
    );
  }

  const data = await fetchFreshAndCache(ctx);
  logEvent({ endpoint: 'fetch', status: 200, cacheHit: false, thaiRowCount: data.count, elapsedMs: Date.now() - startedAt });
  return jsonResponse(toFetchSummary(data), 200, allowedOrigin, { 'X-Cache-Status': 'MISS' });
}

async function handleDownload(ctx, allowedOrigin, startedAt) {
  const { data, cacheHit } = await getThaiDataset(ctx);
  const csv = buildCSV(data.headers, data.rows);
  const filename = `radioid_thailand_520_${formatBangkokDate()}.csv`;

  logEvent({
    endpoint: 'download',
    status: 200,
    cacheHit,
    thaiRowCount: data.count,
    byteSize: csv.length,
    elapsedMs: Date.now() - startedAt,
  });

  return new Response(csv, {
    status: 200,
    headers: {
      ...securityHeaders(),
      ...corsHeaders(allowedOrigin),
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Cache-Status': cacheHit ? 'HIT' : 'MISS',
    },
  });
}

function handleOptions(allowedOrigin) {
  return new Response(null, {
    status: 204,
    headers: {
      ...securityHeaders(),
      ...corsHeaders(allowedOrigin),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function handleNotFound(allowedOrigin) {
  return jsonError('NOT_FOUND', 'ไม่พบ endpoint ที่ร้องขอ', 404, allowedOrigin);
}

function handleMethodNotAllowed(allowedOrigin) {
  return jsonError('METHOD_NOT_ALLOWED', 'รองรับเฉพาะ GET และ OPTIONS เท่านั้น', 405, allowedOrigin);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleRequest(request, env, ctx) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowedOrigin = resolveAllowedOrigin(origin, env);

  if (request.method === 'OPTIONS') {
    return handleOptions(allowedOrigin);
  }
  if (request.method !== 'GET') {
    logEvent({ endpoint: url.pathname, status: 405, method: request.method });
    return handleMethodNotAllowed(allowedOrigin);
  }

  try {
    if (url.pathname === '/api/status') {
      return handleStatus(allowedOrigin);
    }
    if (url.pathname === '/api/fetch') {
      return await handleFetch(ctx, allowedOrigin, startedAt);
    }
    if (url.pathname === '/api/download') {
      return await handleDownload(ctx, allowedOrigin, startedAt);
    }
    return handleNotFound(allowedOrigin);
  } catch (err) {
    return errorResponse(err, allowedOrigin);
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

// Exported for tests / documentation purposes only.
/**
 * Resets isolate-local mutable state (in-flight promise, cooldown clock).
 * Test-only: production code never calls this — a real isolate's state is
 * meant to persist for its lifetime. Without this, sequential tests in the
 * same process would trip each other's /api/fetch cooldown.
 */
function resetForTests() {
  inFlightFetch = null;
  lastUpstreamFetchStartedAt = 0;
}

export const __internal = {
  UPSTREAM_HOST,
  UPSTREAM_PROTOCOL,
  UPSTREAM_PATH,
  UPSTREAM_URL,
  FILTER_PREFIX,
  MIN_UPSTREAM_BYTES,
  MAX_UPSTREAM_BYTES,
  EDGE_CACHE_TTL_SECONDS,
  FETCH_COOLDOWN_MS,
  DEFAULT_ALLOWED_ORIGIN,
  resetForTests,
};
