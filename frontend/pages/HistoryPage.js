/* ── History view (Phase 8a extraction, logic unchanged from Phase 7).
   Only a thin per-run summary is ever persisted (Decision 3's
   {thread_id, sequence, score, activity, timestamp, status}) — there is no
   stored PDB/components/trace, so "detail" here is honestly limited to
   that summary, not a full tabbed result restore.

   Uses window.navigateTo (not a static import of app.js) to avoid a
   circular module dependency: app.js imports renderHistoryView() from
   this file, so this file cannot import navigateTo back from app.js.
   window.navigateTo is already set by the time any click here fires. */
import { getExperiments } from '../services/history.js';
import { emptyStateHtml } from '../components/EmptyState.js';

export function renderHistoryView() {
  const el = document.getElementById('view-history');
  const experiments = getExperiments();
  if (experiments.length === 0) {
    el.innerHTML = emptyStateHtml('🕘', 'History', 'No experiments yet. Generate your first peptide.');
    return;
  }
  el.innerHTML = `
    <div class="history-wrapper">
      <h2 class="history-heading">🕘 History</h2>
      <div class="experiments-list history-list" id="historyList"></div>
      <div id="historyDetail" class="history-detail"></div>
    </div>
  `;
  const list = document.getElementById('historyList');
  list.innerHTML = experiments.slice().reverse().map((exp, i) => {
    const index = experiments.length - 1 - i;
    return `
    <div class="experiment-item history-item" onclick="showHistoryDetail(${index})">
      <span class="experiment-seq">${exp.sequence || '(no sequence)'}</span>
      <span class="experiment-meta">${exp.activity || '(general)'} · score ${exp.score != null ? exp.score.toFixed(4) : '–'} · ${exp.status || 'unknown'} · ${new Date(exp.timestamp).toLocaleString()}</span>
    </div>`;
  }).join('');
}

export function showHistoryDetail(index) {
  const experiments = getExperiments();
  const exp = experiments[index];
  const el = document.getElementById('historyDetail');
  if (!exp || !el) return;
  el.innerHTML = `
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">📄</span> EXPERIMENT DETAIL</div>
      <div class="result-sequence">${exp.sequence || '(no sequence)'}</div>
      <div class="spec-grid" style="margin-top:10px">
        <div class="spec-row"><span class="spec-label">Activity</span><span class="spec-value">${exp.activity || '(general)'}</span></div>
        <div class="spec-row"><span class="spec-label">Score</span><span class="spec-value">${exp.score != null ? exp.score.toFixed(4) : '–'}</span></div>
        <div class="spec-row"><span class="spec-label">Status</span><span class="spec-value">${exp.status || 'unknown'}</span></div>
        <div class="spec-row"><span class="spec-label">Date</span><span class="spec-value">${new Date(exp.timestamp).toLocaleString()}</span></div>
      </div>
      <p class="tab-hint">Only a summary is stored for past experiments — full result detail (tabs, structure, trace) is only available for the most recently completed run this session.</p>
    </div>
  `;
}

export function loadExperiment(threadId) {
  window.navigateTo('history');
  const experiments = getExperiments();
  const index = experiments.findIndex(e => e.thread_id === threadId);
  if (index >= 0) showHistoryDetail(index);
}

window.showHistoryDetail = showHistoryDetail;
window.loadExperiment = loadExperiment;
