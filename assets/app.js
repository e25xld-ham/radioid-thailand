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

export function createApp({ doc, fetchImpl, config = CONFIG, urlImpl }) {
  const els = {
    fetchBtn: doc.getElementById('fetch-btn'),
    downloadBtn: doc.getElementById('download-btn'),
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

  function updateButtonStates() {
    const busy = state.isFetching || state.isDownloading;
    if (els.fetchBtn) {
      els.fetchBtn.disabled = busy;
      els.fetchBtn.setAttribute('aria-busy', state.isFetching ? 'true' : 'false');
    }
    if (els.downloadBtn) {
      els.downloadBtn.disabled = busy || !state.downloadReady;
      els.downloadBtn.setAttribute('aria-busy', state.isDownloading ? 'true' : 'false');
    }
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

    if (els.downloadBtn) {
      const title = els.downloadBtn.querySelector('strong');
      if (title) title.textContent = `ดาวน์โหลด CSV (${countText})`;
    }
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
      setStatusMessage('');
    } catch (err) {
      showError((err && err.message) || 'ไม่สามารถดึงข้อมูลจาก RadioID.net ได้ กรุณาลองใหม่อีกครั้ง');
      setStatusMessage('เกิดข้อผิดพลาดระหว่างดึงข้อมูล');
    } finally {
      state.isFetching = false;
      hideProgress();
      updateButtonStates();
    }
  }

  async function downloadCsv() {
    if (state.isDownloading || state.isFetching || !state.downloadReady) return;
    state.isDownloading = true;
    updateButtonStates();
    hideError();
    setStatusMessage('กำลังเตรียมไฟล์ CSV สำหรับดาวน์โหลด...');
    try {
      const res = await fetchImpl(`${config.API_BASE_URL}/api/download`);
      if (!res.ok) {
        const body = await safeJson(res);
        throw new Error(extractErrorMessage(body) || `ดาวน์โหลดไม่สำเร็จ (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const filename = extractFilenameFromContentDisposition(res.headers.get('Content-Disposition')) || 'radioid_thailand_520.csv';
      triggerBlobDownload(doc, urlImpl, blob, filename);
      setStatusMessage('ดาวน์โหลดไฟล์ CSV สำเร็จ');
    } catch (err) {
      showError((err && err.message) || 'ดาวน์โหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      setStatusMessage('เกิดข้อผิดพลาดระหว่างดาวน์โหลด');
    } finally {
      state.isDownloading = false;
      updateButtonStates();
    }
  }

  if (els.fetchBtn) els.fetchBtn.addEventListener('click', fetchLatest);
  if (els.downloadBtn) els.downloadBtn.addEventListener('click', downloadCsv);
  if (els.retryBtn) els.retryBtn.addEventListener('click', fetchLatest);
  return { checkStatus, fetchLatest, downloadCsv, els, state };
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const app = createApp({ doc: document, fetchImpl: fetch, config: CONFIG, urlImpl: URL });
    app.checkStatus();
  });
}
