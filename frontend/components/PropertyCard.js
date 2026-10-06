/* ── Properties tab (Phase 8a extraction, logic unchanged from Phase 5) ──── */
export function fmtCharge(v) { return v >= 0 ? `+${v}` : `${v}`; }

export function renderPropertiesTab(r) {
  const d = r.descriptors;
  const el = document.getElementById('tabProperties');
  if (!d) {
    el.innerHTML = `<p class="text-muted">Descriptor analysis unavailable.</p>`;
    return;
  }
  const row = (label, val) => `<div class="spec-row"><span class="spec-label">${label}</span><span class="spec-value">${val}</span></div>`;
  el.innerHTML = `
    <div class="tab-section-label">SEQUENCE / PHYSICOCHEMICAL PROPERTIES</div>
    <div class="spec-grid">
      ${row('Length', d.length != null ? d.length + ' AA' : '–')}
      ${row('Net charge', d.net_charge != null ? fmtCharge(d.net_charge) : '–')}
      ${row('Hydrophobicity', d.hydro_pct != null ? d.hydro_pct + '%' : '–')}
      ${row('GRAVY', d.gravy != null ? d.gravy : 'Not available (standard mode)')}
      ${row('Aromaticity', d.aromaticity != null ? (d.aromaticity * 100).toFixed(1) + '%' : 'Not available (standard mode)')}
      ${row('Mol. weight', d.mol_weight != null ? d.mol_weight + ' Da' : 'Not available (standard mode)')}
      ${row('Charge class', d.charge_class || '–')}
      ${row('Length class', d.length_class || '–')}
    </div>
    ${r.descriptors_partial ? '<p class="tab-hint">Full descriptor analysis available in harness mode.</p>' : ''}
  `;
}
