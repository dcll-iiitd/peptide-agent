/* ── Backend API calls (Phase 8a extraction — logic unchanged from app.js) ── */
export const API_BASE = 'http://localhost:8000';

export async function health() {
  const r = await fetch(`${API_BASE}/health`);
  return r.json();
}

export async function generate(requestBody, isHarness) {
  return fetch(`${API_BASE}/generate${isHarness ? '?harness=true' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
}

export async function resumeHITL(threadId, decision) {
  return fetch(`${API_BASE}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId, decision }),
  });
}

export async function command(text, threadId) {
  const r = await fetch(`${API_BASE}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, thread_id: threadId }),
  });
  return r.json();
}
