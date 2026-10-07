/* ── Novelty tab (BLAST/FAISS) — Phase 8c rewrite ─────────────────────────
   harness/graph.py's post_hoc_node now calls novelty_tool for real (Phase
   8c wired it in — previously always None, see frontend_phase8c_novelty.md).
   Messaging below distinguishes three states per that doc:
     1. No sequence at all -> "not performed in this run"
     2. Ran, found nothing on either path -> specific "BLAST not configured"
        reason (never the vague "may not be configured")
     3. Real data -> full card, with an explicit caveat when the source is
        the FAISS property-space fallback rather than true BLAST alignment. */
export const NOVELTY_COLORS = {
  novel:          { color: '#00e5c3', label: '✓ Novel' },
  low_similarity: { color: '#34d399', label: '⚠ Mostly Novel' },
  similar:        { color: '#fbbf24', label: '⚠ Similar' },
  known:          { color: '#ef4444', label: '✗ Known' },
  unknown:        { color: '#64748b', label: '– N/A' },
};

function renderClosestMatchHtml(seq) {
  if (!seq) return 'Not available';
  if (seq.length <= 30) return `<span class="mono-seq">${seq}</span>`;
  const short = seq.slice(0, 30) + '…';
  return `<span class="mono-seq expandable" onclick="toggleNoveltyMatchExpand(this)" data-full="${seq}" data-short="${short}">${short}</span>`;
}

export function toggleNoveltyMatchExpand(el) {
  const expanded = el.classList.toggle('expanded');
  el.textContent = expanded ? el.dataset.full : el.dataset.short;
}

function sourceLabel(source) {
  if (source === 'blast') return 'BLAST';
  if (source === 'faiss_fallback') return 'FAISS fallback — not sequence alignment';
  return '–';
}

export function renderNoveltyTab(r, containerId = 'tabNovelty') {
  const el = document.getElementById(containerId);

  // Whether novelty_tool/blast_novelty_tool was even attempted for this
  // result. Generate always attempts it once a candidate sequence exists
  // (so this defaults to !!r.sequence, preserving that exact behavior);
  // other callers — e.g. Analyze (Phase 8e), which only ever calls /score
  // and /explain and never touches novelty at all — set this explicitly
  // to false with a specific reason, rather than falling into the "ran but
  // found nothing" branch below and showing an inaccurate BLAST message.
  const checked = r.novelty_checked !== undefined ? r.novelty_checked : !!r.sequence;
  if (!checked) {
    el.innerHTML = `<p class="text-muted">${r.novelty_not_checked_reason || 'Novelty analysis not performed in this run.'}</p>`;
    return;
  }

  // Ran, but found nothing usable on either path. Legacy has no FAISS
  // fallback at all, so its message is narrower than the harness path's.
  if (r.novelty_score == null && !r.closest_match) {
    const fallback = r.novelty_is_legacy
      ? 'BLAST database not configured.'
      : 'BLAST database not configured. FAISS fallback also unavailable.';
    el.innerHTML = `<p class="text-muted">${r.novelty_interp || fallback}</p>`;
    return;
  }

  const style = NOVELTY_COLORS[r.novelty_label] || NOVELTY_COLORS.unknown;
  let html = `<div class="novelty-badge-row"><span class="novelty-label" style="color:${style.color}">${style.label}</span></div>`;

  if (r.novelty_score != null) {
    html += `
      <div class="comp-row">
        <span class="comp-label">Similarity</span>
        <div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${Math.round(r.novelty_score * 100)}%;background:${style.color}"></div></div>
        <span class="comp-val">${r.novelty_score.toFixed(2)}</span>
      </div>`;
  } else {
    html += `<p class="tab-hint">Similarity score not available.</p>`;
  }

  html += `<div class="spec-row"><span class="spec-label">Closest match</span><span class="spec-value">${renderClosestMatchHtml(r.closest_match)}</span></div>`;
  html += `<div class="spec-row"><span class="spec-label">Source</span><span class="spec-value">${sourceLabel(r.novelty_source)}</span></div>`;
  html += `<div class="spec-row"><span class="spec-label">Database</span><span class="spec-value">PepForge 105K peptides</span></div>`;

  if (r.novelty_source === 'faiss_fallback') {
    html += `<p class="tab-hint">This is a property-space nearest neighbor, not sequence alignment. Install BLAST for exact sequence similarity.</p>`;
  } else if (r.novelty_interp) {
    html += `<p class="tab-hint">${r.novelty_interp}</p>`;
  }

  el.innerHTML = html;
}

window.toggleNoveltyMatchExpand = toggleNoveltyMatchExpand;
