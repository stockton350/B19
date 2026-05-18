// ── Memory Provider: Google Sheets via Apps Script ────────────────────────

let _url = null;

export function setMemoryURL(url) { _url = url; }
export function isMemoryEnabled() { return !!_url; }

export async function getProfile() {
  if (!_url) return {};
  const res = await fetch(`${_url}?action=getProfile`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getConversations() {
  if (!_url) return [];
  const res = await fetch(`${_url}?action=getConversations`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveConversation(id, date, title, summary) {
  if (!_url) return;
  await fetch(_url, {
    method: 'POST',
    body: JSON.stringify({ action: 'saveConversation', id, date, title, summary }),
  });
}

export async function saveProfile(profile) {
  if (!_url) return;
  await fetch(_url, {
    method: 'POST',
    body: JSON.stringify({ action: 'saveProfile', profile }),
  });
}
