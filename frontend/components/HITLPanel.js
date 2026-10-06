/* ── HITL approval panel (Week 4 task 5, reused as-is; Phase 8a extraction)
   Pure DOM rendering — thread-id state stays in GeneratePage.js, which
   sets it itself around calling showHitlPanel()/hitlDecide(). */
export function showHitlPanel(data) {
  document.getElementById('hitlSequence').textContent = data.sequence || '';
  const rb = data.rulebook;
  const scoreStr = data.score != null ? data.score.toFixed(4) : '–';
  const rbStr = rb ? `${rb.passed ? 'PASS' : 'FAIL'} (${rb.n_violations} violation(s))` : '–';
  document.getElementById('hitlMeta').textContent =
    `Iteration ${data.iteration} · Score ${scoreStr} · Rulebook ${rbStr}`;
  document.getElementById('hitlModifyRow').style.display = 'none';
  document.getElementById('hitlModifySequence').value = '';
  document.getElementById('hitlPanel').style.display = 'block';
}

export function hideHitlPanel() {
  document.getElementById('hitlPanel').style.display = 'none';
}

export function hitlShowModify() {
  document.getElementById('hitlModifyRow').style.display = 'flex';
}

window.hitlShowModify = hitlShowModify;
