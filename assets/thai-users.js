export function thaiUsers(data, fields = {}) {
  if (!Array.isArray(data?.users)) throw new Error('ไฟล์ต้องมีรายการ users');
  const users = data.users.filter(row => /^520\d{4}$/.test(String(row?.radio_id ?? row?.id)));
  const { id = '', callsign = '', name = '', city = '', state = '' } = fields;
  if (id || callsign || name || city || state) {
    if (!/^520\d{4}$/.test(id) || !/^[A-Z0-9]{3,12}$/.test(callsign) || !name) {
      throw new Error('กรอก DMR ID ไทย, callsign และชื่อให้ครบ');
    }
    const radioId = Number(id);
    const existing = users.find(row => Number(row.radio_id ?? row.id) === radioId);
    if (existing && String(existing.callsign).trim().toUpperCase() !== callsign) {
      throw new Error(`DMR ID นี้เป็นของ ${existing.callsign}`);
    }
    if (!existing) {
      users.push({ id: radioId, radio_id: radioId, callsign, name, fname: name,
        surname: '', city, state, country: 'Thailand' });
    }
  }
  if (!users.length) throw new Error('ไม่พบ DMR ID ประเทศไทยในไฟล์');
  return { users };
}

const form = globalThis.document?.querySelector('#json-form');
form?.addEventListener('submit', async event => {
  event.preventDefault();
  const status = document.querySelector('#json-status');
  const button = form.querySelector('button[type=submit]');
  const fields = Object.fromEntries(new FormData(form));
  button.disabled = true;
  status.textContent = 'กำลังอ่านไฟล์…';
  try {
    const data = thaiUsers(JSON.parse(await fields.source.text()), {
      id: fields.id.trim(), callsign: fields.callsign.trim().toUpperCase(),
      name: fields.name.trim(), city: fields.city.trim(), state: fields.state.trim(),
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'users.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    status.textContent = `พร้อมดาวน์โหลด ${data.users.length.toLocaleString('th-TH')} รายการ`;
  } catch (error) {
    status.textContent = error instanceof SyntaxError ? 'ไฟล์นี้ไม่ใช่ JSON ที่อ่านได้' : error.message;
  } finally {
    button.disabled = false;
  }
});
