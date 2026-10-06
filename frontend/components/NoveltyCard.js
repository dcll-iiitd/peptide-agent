/* ── Novelty tab (BLAST/FAISS) (Phase 8a extraction, logic unchanged) ────── */
export const NOVELTY_COLORS = {
  novel:          { color: '#00e5c3', label: 'Novel' },
  low_similarity: { color: '#34d399', label: 'Mostly Novel' },
  similar:        { color: '#fbbf24', label: 'Similar' },
  known:          { color: '#ef4444', label: 'Known' },
  unknown:        { color: '#64748b', label: 'N/A' },
};

export function renderNoveltyTab(r) {
  const el = document.getElementById('tabNovelty');
  if (!r.novelty_available || r.novelty_score == null) {
    el.innerHTML = `<p class="text-muted">${r.novelty_interp || 'Novelty check unavailable. BLAST database may not be configured.'}</p>`;
    return;
  }
  const style = NOVELTY_COLORS[r.novelty_label] || NOVELTY_COLORS.unknown;
  el.innerHTML = `
    <div class="novelty-badge-row"><span class="novelty-label" style="color:${style.color}">${style.label}</span></div>
    <div class="comp-row">
      <span class="comp-label">Similarity score</span>
      <div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${Math.round(r.novelty_score * 100)}%;background:${style.color}"></div></div>
      <span class="comp-val">${r.novelty_score.toFixed(2)}</span>
    </div>
    ${r.closest_match ? `<div class="spec-row"><span class="spec-label">Closest match</span><span class="spec-value">${r.closest_match}</span></div>` : ''}
    <div class="spec-row"><span class="spec-label">Database</span><span class="spec-value">BLAST (IIIT-D 105K)</span></div>
    <p class="tab-hint">${r.novelty_interp || ''}</p>
  `;
}
