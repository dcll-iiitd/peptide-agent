/* ── Best candidate hero card (Phase 8a extraction, logic unchanged from
   Phase 5) ────────────────────────────────────────────────────────────────── */
export function scoreClass(s) {
  if (s >= 0.35) return 'score-good';
  if (s >= 0.25) return 'score-ok';
  return 'score-bad';
}

export function renderHeroMetricsHtml(r) {
  const rows = [];
  if (r.score != null) {
    rows.push(`<div class="hero-metric-row"><span class="hero-metric-label">PeptideBLEU</span>
      <div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${Math.round(r.score * 100)}%"></div></div>
      <span class="hero-metric-val">${r.score.toFixed(4)}</span></div>`);
  }
  rows.push(`<div class="hero-metric-row"><span class="hero-metric-label">Rulebook</span>
    <span class="hero-metric-val">${r.status === 'complete' ? '✓ Passed' : '○ ' + (r.status || 'unknown')}</span></div>`);
  if (r.novelty_available && r.novelty_label) {
    rows.push(`<div class="hero-metric-row"><span class="hero-metric-label">Novelty</span>
      <span class="hero-metric-val">${r.novelty_label === 'novel' ? '✓ Novel' : r.novelty_label}</span></div>`);
  }
  if (r.plddt_score != null) {
    rows.push(`<div class="hero-metric-row"><span class="hero-metric-label">pLDDT</span>
      <span class="hero-metric-val">${r.plddt_score.toFixed(1)}${r.plddt_confidence ? ' (' + r.plddt_confidence + ')' : ''}</span></div>`);
  }
  return rows.join('');
}

export function renderHeroCard(r) {
  const seqEl = document.getElementById('resultSequence');
  seqEl.textContent = r.sequence || 'No sequence generated';
  const displayScore = r.score != null ? r.score : r.rulebook_score;
  seqEl.className = 'result-sequence' + (displayScore != null ? ' ' + scoreClass(displayScore) : '');

  const lengthAa = (r.descriptors && r.descriptors.length != null) ? r.descriptors.length : r.sequence.length;
  document.getElementById('heroSubtitle').textContent =
    `${lengthAa} amino acids${r.activity ? ' · ' + r.activity : ''}`;
  document.getElementById('heroMetrics').innerHTML = renderHeroMetricsHtml(r);
}

export function renderTraceLink(url) {
  const link = document.getElementById('traceLink');
  if (!link) return;
  if (!url) { link.style.display = 'none'; return; }
  link.href = url;
  link.style.display = 'inline-block';
}
