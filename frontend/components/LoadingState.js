/* ── Reusable loading indicator (Phase 8a) ────────────────────────────────
   Thin wrapper around the existing #progressHeader show/hide toggle (the
   "PepForge is working..." spinner row, markup already in index.html) —
   extracted so other pages can reuse the same show/hide calls once they
   grow real async workflows (Phase 8e/8f/8g). */
export function showLoading() {
  const el = document.getElementById('progressHeader');
  if (el) el.style.display = 'flex';
}

export function hideLoading() {
  const el = document.getElementById('progressHeader');
  if (el) el.style.display = 'none';
}
