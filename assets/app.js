// Thai RadioID Downloader — frontend logic.
export const CONFIG = {
  API_BASE_URL: 'https://radioid-thailand-api.e25xld.workers.dev',
};

export function formatBangkokDateTime(isoString) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '-';
  const formatted = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
  return `${formatted} น. (เวลาไทย)`;
}

export function formatThaiNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('th-TH');
}

export function extractFilenameFromContentDisposition(headerValue) {
  if (!headerValue) return null;
  const quoted = /filename="([^"]+)"/i.exec(headerValue);
  if (quoted) return quoted[1];
  const bare = /filename=([^;]+)/i.exec(headerValue);
  return bare ? bare[1].trim() : null;
}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

function extractErrorMessage(body) {
  return (body && body.error && body.error.message) || null;
}

function triggerBlobDownload(doc, urlImpl, blob, filename) {
  const objectUrl = urlImpl.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.rel = 'noopener';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => urlImpl.revokeObjectURL(objectUrl), 2000);
}

function formatDashboardDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return { date: '-', time: '-' };
  return {
    date: new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric',
    }).format(date),
    time: `${new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date)} ICT`,
  };
}

function formatBangkokFileDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const map = {};
  parts.forEach((part) => { map[part.type] = part.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

/** RFC 4180-compatible CSV parser for the downloaded filtered RadioID file. */
export function parseCsvText(input) {
  let text = String(input || '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((cell) => cell !== '')) records.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some((cell) => cell !== '')) records.push(row);
  }
  return records;
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function findColumn(headers, ...names) {
  const normalized = headers.map((header) => String(header || '').trim().toUpperCase());
  for (const name of names) {
    const index = normalized.indexOf(name.toUpperCase());
    if (index !== -1) return index;
  }
  return -1;
}

/** Converts the filtered RadioID CSV into AnyTone D878UV/D578UV CPS contact format. */
export function buildAnyToneCsv(sourceCsv) {
  const records = parseCsvText(sourceCsv);
  if (records.length < 2) throw new Error('ไฟล์ RadioID ไม่มีข้อมูลสำหรับแปลงเป็น AnyTone');

  const headers = records[0];
  const rows = records.slice(1);
  const idIndex = findColumn(headers, 'RADIO_ID', 'RADIO ID');
  const callsignIndex = findColumn(headers, 'CALLSIGN');
  const firstNameIndex = findColumn(headers, 'FIRST_NAME', 'FIRST NAME');
  const lastNameIndex = findColumn(headers, 'LAST_NAME', 'LAST NAME');
  const cityIndex = findColumn(headers, 'CITY');
  const stateIndex = findColumn(headers, 'STATE', 'STATE/PROV');
  const countryIndex = findColumn(headers, 'COUNTRY');

  if (idIndex === -1 || callsignIndex === -1) {
    throw new Error('ไม่พบคอลัมน์ RADIO_ID หรือ CALLSIGN ในไฟล์ต้นทาง');
  }

  const anyToneHeaders = [
    'No.', 'TG/DMR ID', 'Call Alert', 'Name', 'City',
    'Call Type', 'Callsign', 'State/Prov', 'Country', 'Remarks',
  ];

  const outputRows = rows.map((row, index) => {
    const firstName = firstNameIndex >= 0 ? String(row[firstNameIndex] || '').trim() : '';
    const lastName = lastNameIndex >= 0 ? String(row[lastNameIndex] || '').trim() : '';
    const fullName = [firstName, lastName].filter(Boolean).join(' ');
    return [
      index + 1,
      String(row[idIndex] || '').trim(),
      'None',
      fullName,
      cityIndex >= 0 ? String(row[cityIndex] || '').trim() : '',
      'Private Call',
      String(row[callsignIndex] || '').trim().toUpperCase(),
      stateIndex >= 0 ? String(row[stateIndex] || '').trim() : '',
      countryIndex >= 0 ? String(row[countryIndex] || '').trim() : '',
      '',
    ];
  });

  const lines = [anyToneHeaders, ...outputRows].map((row) => row.map(csvEscape).join(','));
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

export function createApp({ doc, fetchImpl, config = CONFIG, urlImpl }) {
  const els = {
    fetchBtn: doc.getElementById('fetch-btn'),
    downloadBtn: doc.getElementById('download-btn'),
    anyToneDownloadBtn: doc.getElementById('anytone-download-btn'),
    connectionStatus: doc.getElementById('connection-status'),
    workerMini: doc.getElementById('worker-mini'),
    workerMiniLabel: doc.getElementById('worker-mini-label'),
    statusLive: doc.getElementById('status-live'),
    progress: doc.getElementById('progress'),
    resultSummary: doc.getElementById('result-summary'),
    resultCount: doc.getElementById('result-count'),
    resultTime: doc.getElementById('result-time'),
    statCount: doc.getElementById('stat-count'),
    statDate: doc.getElementById('stat-date'),
    statTime: doc.getElementById('stat-time'),
    errorBanner: doc.getElementById('error-banner'),
    errorMessage: doc.getElementById('error-message'),
    retryBtn: doc.getElementById('retry-btn'),
    sampleSection: doc.getElementById('sample-section'),
    sampleThead: doc.getElementById('sample-thead'),
    sampleTbody: doc.getElementById('sample-tbody'),
  };

  const state = { isFetching: false, isDownloading: false, downloadReady: false, count: null };
  if (els.downloadBtn) els.downloadBtn.disabled = true;
  if (els.anyToneDownloadBtn) els.anyToneDownloadBtn.disabled = true;

  function updateButtonStates() {
    const busy = state.isFetching || state.isDownloading;
    if (els.fetchBtn) {
      els.fetchBtn.disabled = busy;
      els.fetchBtn.setAttribute('aria-busy', state.isFetching ? 'true' : 'false');
    }
    [els.downloadBtn, els.anyToneDownloadBtn].forEach((button) => {
      if (!button) return;
      button.disabled = busy || !state.downloadReady;
      button.setAttribute('aria-busy', state.isDownloading ? 'true' : 'false');
    });
  }

  function setStatusMessage(message) {
    if (els.statusLive) els.statusLive.textContent = message;
  }

  function setConnectionStatus(kind) {
    const labels = {
      checking: 'กำลังตรวจสอบการเชื่อมต่อ Worker...',
      online: 'เชื่อมต่อ Worker สำเร็จ พร้อมใช้งาน',
      offline: 'ไม่สามารถเชื่อมต่อ Worker ได้ในขณะนี้',
    };
    if (els.connectionStatus) {
      els.connectionStatus.textContent = labels[kind] || '';
      els.connectionStatus.dataset.state = kind;
    }
    if (els.workerMini) els.workerMini.dataset.state = kind;
    if (els.workerMiniLabel) {
      els.workerMiniLabel.textContent = kind === 'online' ? 'ONLINE' : kind === 'offline' ? 'OFFLINE' : 'CHECKING';
    }
  }

  function showProgress(message) {
    if (els.progress) els.progress.hidden = false;
    setStatusMessage(message);
  }
  function hideProgress() { if (els.progress) els.progress.hidden = true; }
  function showError(message) {
    if (els.errorBanner) els.errorBanner.hidden = false;
    if (els.errorMessage) els.errorMessage.textContent = message;
  }
  function hideError() { if (els.errorBanner) els.errorBanner.hidden = true; }

  function updateDownloadTitle(button, text) {
    if (!button || typeof button.querySelector !== 'function') return;
    const title = button.querySelector('strong');
    if (title) title.textContent = text;
  }

  function renderResult(body) {
    const countText = formatThaiNumber(body.count);
    const dashboardTime = formatDashboardDate(body.fetchedAt);
    state.count = body.count;

    if (els.resultSummary) els.resultSummary.hidden = false;
    if (els.resultCount) els.resultCount.textContent = `พบรายชื่อ DMR ID ประเทศไทย ${countText} รายชื่อ`;
    if (els.resultTime) els.resultTime.textContent = `ดึงข้อมูลล่าสุดเมื่อ ${formatBangkokDateTime(body.fetchedAt)}`;
    if (els.statCount) els.statCount.textContent = countText;
    if (els.statDate) els.statDate.textContent = dashboardTime.date;
    if (els.statTime) els.statTime.textContent = dashboardTime.time;

    updateDownloadTitle(els.downloadBtn, `ดาวน์โหลด RadioID CSV (${countText})`);
    updateDownloadTitle(els.anyToneDownloadBtn, `ดาวน์โหลด AnyTone (${countText})`);
  }

  function renderSample(body) {
    if (!els.sampleSection || !els.sampleThead || !els.sampleTbody) return;
    const columns = Array.isArray(body.columns) ? body.columns : [];
    const sample = Array.isArray(body.sample) ? body.sample : [];
    if (columns.length === 0 || sample.length === 0) {
      els.sampleSection.hidden = true;
      return;
    }
    const headRow = doc.createElement('tr');
    columns.forEach((col) => {
      const th = doc.createElement('th');
      th.textContent = col;
      headRow.appendChild(th);
    });
    els.sampleThead.textContent = '';
    els.sampleThead.appendChild(headRow);
    els.sampleTbody.textContent = '';
    sample.forEach((row) => {
      const tr = doc.createElement('tr');
      row.forEach((cell) => {
        const td = doc.createElement('td');
        td.textContent = cell;
        tr.appendChild(td);
      });
      els.sampleTbody.appendChild(tr);
    });
    els.sampleSection.hidden = false;
  }

  async function checkStatus() {
    setConnectionStatus('checking');
    try {
      const res = await fetchImpl(`${config.API_BASE_URL}/api/status`);
      const body = await safeJson(res);
      if (!res.ok || !body || body.ok !== true) throw new Error('status check failed');
      setConnectionStatus('online');
    } catch {
      setConnectionStatus('offline');
    }
  }

  async function fetchLatest() {
    if (state.isFetching || state.isDownloading) return;
    state.isFetching = true;
    updateButtonStates();
    hideError();
    showProgress('กำลังดาวน์โหลดและประมวลผลฐานข้อมูล RadioID กรุณารอสักครู่...');
    try {
      const res = await fetchImpl(`${config.API_BASE_URL}/api/fetch`);
      const body = await safeJson(res);
      if (!res.ok || !body || body.ok !== true) {
        throw new Error(extractErrorMessage(body) || `ไม่สามารถดึงข้อมูลได้ (HTTP ${res.status})`);
      }
      state.downloadReady = true;
      renderResult(body);
      renderSample(body);
      setStatusMessage('เลือกรูปแบบไฟล์ที่ต้องการดาวน์โหลดได้แล้ว');
    } catch (err) {
      showError((err && err.message) || 'ไม่สามารถดึงข้อมูลจาก RadioID.net ได้ กรุณาลองใหม่อีกครั้ง');
      setStatusMessage('เกิดข้อผิดพลาดระหว่างดึงข้อมูล');
    } finally {
      state.isFetching = false;
      hideProgress();
      updateButtonStates();
    }
  }

  async function getDownloadResponse() {
    const res = await fetchImpl(`${config.API_BASE_URL}/api/download`);
    if (!res.ok) {
      const body = await safeJson(res);
      throw new Error(extractErrorMessage(body) || `ดาวน์โหลดไม่สำเร็จ (HTTP ${res.status})`);
    }
    return res;
  }

  async function downloadCsv() {
    if (state.isDownloading || state.isFetching || !state.downloadReady) return;
    state.isDownloading = true;
    updateButtonStates();
    hideError();
    setStatusMessage('กำลังเตรียมไฟล์ RadioID CSV...');
    try {
      const res = await getDownloadResponse();
      const blob = await res.blob();
      const filename = extractFilenameFromContentDisposition(res.headers.get('Content-Disposition')) || 'radioid_thailand_520.csv';
      triggerBlobDownload(doc, urlImpl, blob, filename);
      setStatusMessage('ดาวน์โหลดไฟล์ RadioID CSV สำเร็จ');
    } catch (err) {
      showError((err && err.message) || 'ดาวน์โหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      setStatusMessage('เกิดข้อผิดพลาดระหว่างดาวน์โหลด');
    } finally {
      state.isDownloading = false;
      updateButtonStates();
    }
  }

  async function downloadAnyToneCsv() {
    if (state.isDownloading || state.isFetching || !state.downloadReady) return;
    state.isDownloading = true;
    updateButtonStates();
    hideError();
    setStatusMessage('กำลังจัดคอลัมน์สำหรับ AnyTone D878UV / D578UV CPS...');
    try {
      const res = await getDownloadResponse();
      const sourceCsv = await res.text();
      const anyToneCsv = buildAnyToneCsv(sourceCsv);
      const blob = new Blob([anyToneCsv], { type: 'text/csv;charset=utf-8' });
      const filename = `anytone_d878uv_d578uv_thailand_520_${formatBangkokFileDate()}.csv`;
      triggerBlobDownload(doc, urlImpl, blob, filename);
      setStatusMessage('ดาวน์โหลดไฟล์ AnyTone CPS สำเร็จ พร้อมนำเข้า Digital Contact List');
    } catch (err) {
      showError((err && err.message) || 'สร้างไฟล์ AnyTone ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      setStatusMessage('เกิดข้อผิดพลาดระหว่างสร้างไฟล์ AnyTone');
    } finally {
      state.isDownloading = false;
      updateButtonStates();
    }
  }

  if (els.fetchBtn) els.fetchBtn.addEventListener('click', fetchLatest);
  if (els.downloadBtn) els.downloadBtn.addEventListener('click', downloadCsv);
  if (els.anyToneDownloadBtn) els.anyToneDownloadBtn.addEventListener('click', downloadAnyToneCsv);
  if (els.retryBtn) els.retryBtn.addEventListener('click', fetchLatest);
  return { checkStatus, fetchLatest, downloadCsv, downloadAnyToneCsv, els, state };
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const app = createApp({ doc: document, fetchImpl: fetch, config: CONFIG, urlImpl: URL });
    app.checkStatus();
  });
}
