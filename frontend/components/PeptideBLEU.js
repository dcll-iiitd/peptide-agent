/* ── PeptideBLEU 7-component bar chart (Phase 8a extraction, logic
   unchanged from Phase 5) ────────────────────────────────────────────────── */
const COMPONENT_LABELS = {
  ngram_bleu: 'N-gram BLEU',
  charge: 'Charge',
  hydrophobicity: 'Hydrophobicity',
  functional_group: 'Functional Group',
  property_distribution: 'Property Distribution',
  structural: 'Structural',
  blosum: 'BLOSUM62',
};

export function renderPeptideBleuTab(r, containerId = 'tabPeptidebleu') {
  const el = document.getElementById(containerId);
  const comp = r.components || {};
  if (Object.keys(comp).length === 0) {
    el.innerHTML = `<p class="text-muted">${r.reference_used ? 'No component breakdown available.' : 'No reference — PeptideBLEU not computed.'}</p>`;
    return;
  }
  const order = ['ngram_bleu', 'charge', 'hydrophobicity', 'functional_group', 'property_distribution', 'structural', 'blosum'];
  const bars = order.map(k => {
    const val = comp[k] ?? 0;
    return `
      <div class="comp-row">
        <span class="comp-label">${COMPONENT_LABELS[k] || k}</span>
        <div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${Math.round(val * 100)}%"></div></div>
        <span class="comp-val">${val.toFixed(4)}</span>
      </div>`;
  }).join('');
  el.innerHTML = `
    <div class="bleu-overall">Overall score <span class="bleu-overall-val">${r.score != null ? r.score.toFixed(4) : '–'}</span></div>
    <div class="component-scores">${bars}</div>
  `;
}
