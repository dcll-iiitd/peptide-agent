/* ── Diagnostic violations list, used by the Trace tab (Phase 8a
   extraction, logic unchanged from Phase 5) ──────────────────────────────── */
export function renderViolationsHtml(violations) {
  if (!violations || !violations.length) {
    return '<p class="text-muted">No violations on the final candidate.</p>';
  }
  return '<div class="violations-list">' + violations.map(v => `
    <div class="violation-row">
      <span class="violation-rule">${v.rule}</span>
      <span class="violation-detail">current: ${v.current} → target: ${v.target} (excess ${v.excess})</span>
      <span class="violation-fix">${v.fix}</span>
      ${v.positions && v.positions.length ? `<span class="violation-detail">positions: ${v.positions.join(', ')}</span>` : ''}
    </div>`).join('') + '</div>';
}
