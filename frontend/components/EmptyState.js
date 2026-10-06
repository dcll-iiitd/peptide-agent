/* ── Reusable empty-state block (Phase 8a extraction) ──────────────────────
   Generate's own empty state is static markup already in index.html (not
   JS-generated), so the only current consumer is HistoryPage's "no
   experiments yet" message — centralized here so Analyze/Compare/Score
   pages can reuse the same shape once they get real empty states
   (Phase 8e/8f/8g). */
export function emptyStateHtml(icon, title, message) {
  return `<div class="view-placeholder"><h2>${icon} ${title}</h2><p>${message}</p></div>`;
}
