/* ── History view (Phase 8d: per-item delete added on top of the Phase
   7/8a base). Only a thin per-run summary is ever persisted (Decision 3's
   {thread_id, sequence, score, activity, timestamp, status}) — there is no
   stored PDB/components/trace, so "detail" here is honestly limited to
   that summary, not a full tabbed result restore.

   Rows are keyed by thread_id (not array index) throughout, including the
   dropdown/delete flow — an index would go stale the moment one row is
   removed without a full list re-render, which the fade-out animation
   below deliberately avoids doing.

   Uses window.navigateTo (not a static import of app.js) to avoid a
   circular module dependency: app.js imports renderHistoryView() from
   this file, so this file cannot import navigateTo back from app.js.
   window.navigateTo is already set by the time any click here fires. */
import { getExperiments, getExperiment, deleteExperiment } from '../services/history.js';
import { emptyStateHtml } from '../components/EmptyState.js';

// Which experiment's summary is currently shown in #historyDetail, so a
// delete of that same item can clear the now-stale detail panel.
let openDetailThreadId = null;

export function renderHistoryView() {
  const el = document.getElementById('view-history');
  const experiments = getExperiments();
  if (experiments.length === 0) {
    el.innerHTML = emptyStateHtml('🕘', 'History', 'No experiments yet. Generate your first peptide.');
    return;
  }
  openDetailThreadId = null;
  el.innerHTML = `
    <div class="history-wrapper">
      <h2 class="history-heading">🕘 History</h2>
      <div class="experiments-list history-list" id="historyList"></div>
      <div id="historyDetail" class="history-detail"></div>
    </div>
  `;
  const list = document.getElementById('historyList');
  list.innerHTML = experiments.slice().reverse().map(renderHistoryRowHtml).join('');
}

function renderHistoryRowHtml(exp) {
  const id = exp.thread_id || '';
  return `
    <div class="experiment-item history-item" data-thread-id="${id}" onclick="showHistoryDetailByThreadId('${id}')">
      <div class="history-item-main">
        <span class="experiment-seq">${exp.sequence || '(no sequence)'}</span>
        <span class="experiment-meta">${exp.activity || '(general)'} · score ${exp.score != null ? exp.score.toFixed(4) : '–'} · ${exp.status || 'unknown'} · ${new Date(exp.timestamp).toLocaleString()}</span>
      </div>
      <div class="history-item-menu-wrap">
        <button class="history-item-menu-btn" onclick="toggleHistoryItemMenu(event, '${id}')" aria-label="Experiment actions">⋮</button>
        <div class="history-item-dropdown" id="historyMenu-${id}" style="display:none">
          <div class="history-dropdown-item" onclick="historyDropdownOpen(event, '${id}')">Open</div>
          <div class="history-dropdown-sep"></div>
          <div class="history-dropdown-item destructive" onclick="historyDropdownDelete(event, '${id}')">Delete</div>
        </div>
      </div>
    </div>`;
}

function renderDetailHtml(exp) {
  return `
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">📄</span> EXPERIMENT DETAIL</div>
      <div class="result-sequence">${exp.sequence || '(no sequence)'}</div>
      <div class="spec-grid" style="margin-top:10px">
        <div class="spec-row"><span class="spec-label">Activity</span><span class="spec-value">${exp.activity || '(general)'}</span></div>
        <div class="spec-row"><span class="spec-label">Score</span><span class="spec-value">${exp.score != null ? exp.score.toFixed(4) : '–'}</span></div>
        <div class="spec-row"><span class="spec-label">Status</span><span class="spec-value">${exp.status || 'unknown'}</span></div>
        <div class="spec-row"><span class="spec-label">Date</span><span class="spec-value">${new Date(exp.timestamp).toLocaleString()}</span></div>
      </div>
      <p class="tab-hint">Only a summary is stored for past experiments — full result detail (tabs, structure, trace) is only available for the most recently completed run this session. Fields not stored locally show "not available" above.</p>
    </div>
  `;
}

export function showHistoryDetailByThreadId(threadId) {
  const exp = getExperiment(threadId);
  const el = document.getElementById('historyDetail');
  if (!exp || !el) return;
  openDetailThreadId = threadId;
  el.innerHTML = renderDetailHtml(exp);
}

export function loadExperiment(threadId) {
  window.navigateTo('history');
  showHistoryDetailByThreadId(threadId);
}

/* ── Per-item [⋮] dropdown — Open / Delete ────────────────────────────────── */
function closeAllHistoryMenus() {
  document.querySelectorAll('.history-item-dropdown').forEach(m => { m.style.display = 'none'; });
  document.removeEventListener('click', onOutsideHistoryMenuClick);
  document.removeEventListener('keydown', onHistoryMenuKeydown);
}

function onOutsideHistoryMenuClick(e) {
  if (!e.target.closest('.history-item-menu-wrap')) closeAllHistoryMenus();
}

function onHistoryMenuKeydown(e) {
  if (e.key === 'Escape') closeAllHistoryMenus();
}

function toggleHistoryItemMenu(event, threadId) {
  event.stopPropagation();
  const menu = document.getElementById(`historyMenu-${threadId}`);
  if (!menu) return;
  const wasOpen = menu.style.display === 'block';
  closeAllHistoryMenus();
  if (!wasOpen) {
    menu.style.display = 'block';
    document.addEventListener('click', onOutsideHistoryMenuClick);
    document.addEventListener('keydown', onHistoryMenuKeydown);
  }
}

function historyDropdownOpen(event, threadId) {
  event.stopPropagation();
  closeAllHistoryMenus();
  showHistoryDetailByThreadId(threadId);
}

function historyDropdownDelete(event, threadId) {
  event.stopPropagation();
  closeAllHistoryMenus();
  showDeleteConfirm(threadId);
}

/* ── Delete confirmation dialog ───────────────────────────────────────────── */
function onConfirmDialogKeydown(e) {
  if (e.key === 'Escape') cancelHistoryDelete();
}

function showDeleteConfirm(threadId) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.id = 'historyDeleteConfirm';
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <div class="confirm-title">Delete this experiment?</div>
      <p class="confirm-body">This will remove this experiment from your PepForge history.</p>
      <div class="confirm-actions">
        <button class="btn-chip" onclick="cancelHistoryDelete()">Cancel</button>
        <button class="btn-chip btn-destructive" onclick="confirmHistoryDelete('${threadId}')">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onConfirmDialogKeydown);
}

function closeDeleteConfirm() {
  const overlay = document.getElementById('historyDeleteConfirm');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', onConfirmDialogKeydown);
}

function cancelHistoryDelete() {
  closeDeleteConfirm();
}

function confirmHistoryDelete(threadId) {
  closeDeleteConfirm();
  deleteExperiment(threadId);

  if (openDetailThreadId === threadId) {
    const detailEl = document.getElementById('historyDetail');
    if (detailEl) detailEl.innerHTML = '';
    openDetailThreadId = null;
  }

  const row = document.querySelector(`.history-item[data-thread-id="${threadId}"]`);
  if (row) {
    row.classList.add('fade-out');
    setTimeout(() => {
      row.remove();
      const list = document.getElementById('historyList');
      if (list && list.children.length === 0) renderHistoryView();
    }, 250);
  }

  showToast('Experiment deleted');
  window.renderExperimentsList && window.renderExperimentsList();
}

/* ── Toast ─────────────────────────────────────────────────────────────────── */
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 250);
  }, 2000);
}

window.showHistoryDetailByThreadId = showHistoryDetailByThreadId;
window.loadExperiment = loadExperiment;
window.toggleHistoryItemMenu = toggleHistoryItemMenu;
window.historyDropdownOpen = historyDropdownOpen;
window.historyDropdownDelete = historyDropdownDelete;
window.cancelHistoryDelete = cancelHistoryDelete;
window.confirmHistoryDelete = confirmHistoryDelete;
