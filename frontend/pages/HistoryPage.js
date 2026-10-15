/* ── History view (Phase 8d: per-item delete, Phase 8 Analyze v2 Task 8:
   drawer trimmed to a quick-lookup summary). Experiments older than the
   rich-restore fix only ever got a thin per-run summary (Decision 3's
   {thread_id, sequence, score, activity, timestamp, status}); those
   still render via the honest thin-summary path below (gated on
   exp.descriptors === undefined). Newer records carry the full
   ~25-field shape.

   Task 8 split History from Analyze so neither duplicates the other:
   the drawer here is a quick-lookup summary (Experiment Detail,
   Specification, Properties, Rulebook) with a "View Full Analysis →"
   button; PeptideBLEU/Structure/Novelty/Trace are Analyze-only now —
   navigating there with this sequence hits AnalyzePage.js's Path A
   (findBySequence() match) and restores all of those from the exact
   same stored record, so nothing shown here needed its own copy of
   StructureViewer/PeptideBLEU/NoveltyCard or IndexedDB pdb loading.

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
import { toggleDropdown, closeDropdown } from '../components/Dropdown.js';
import { showToast } from '../components/Toast.js';
import { escapeHtml } from '../components/ErrorState.js';
import { renderHeroMetricsHtml, renderHeroStatsHtml } from '../components/CandidateCard.js';
import { renderPropertiesTab } from '../components/PropertyCard.js';
import { renderRulebookSectionHtml } from './AnalyzePage.js';

// Which experiment's summary is currently shown in the detail drawer, so
// a delete of that same item can close the now-stale drawer.
let openDetailThreadId = null;

// Client-side only (point 6 of the frontend spec) — no new backend
// endpoint. Re-applied on every keystroke/change against the full
// getExperiments() list, never persisted.
let historyFilters = { search: '', activity: '', status: '' };

export function renderHistoryView() {
  const el = document.getElementById('view-history');
  const experiments = getExperiments();
  if (experiments.length === 0) {
    el.innerHTML = emptyStateHtml('🕘', 'History', 'No experiments yet. Generate your first peptide.');
    return;
  }
  openDetailThreadId = null;
  historyFilters = { search: '', activity: '', status: '' };
  el.innerHTML = `
    <div class="history-wrapper">
      <h2 class="history-heading">🕘 History</h2>
      <div class="history-filters">
        <input id="historySearchInput" class="ref-input history-search-input" placeholder="Search by sequence or activity..." oninput="onHistoryFilterChange()" />
        <select id="historyActivityFilter" class="ref-input" onchange="onHistoryFilterChange()"><option value="">All activities</option></select>
        <select id="historyStatusFilter" class="ref-input" onchange="onHistoryFilterChange()"><option value="">All statuses</option></select>
      </div>
      <div class="experiments-list history-list" id="historyList"></div>
    </div>
  `;
  buildHistoryFilterOptions(experiments);
  renderHistoryRows(experiments);
}

function buildHistoryFilterOptions(experiments) {
  const activities = [...new Set(experiments.map(e => e.activity).filter(Boolean))].sort();
  const statuses = [...new Set(experiments.map(e => e.status).filter(Boolean))].sort();
  const actSel = document.getElementById('historyActivityFilter');
  if (actSel) actSel.innerHTML = '<option value="">All activities</option>' + activities.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
  const statSel = document.getElementById('historyStatusFilter');
  if (statSel) statSel.innerHTML = '<option value="">All statuses</option>' + statuses.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
}

function matchesHistoryFilters(exp) {
  if (historyFilters.search) {
    const s = historyFilters.search.toLowerCase();
    const seq = (exp.sequence || '').toLowerCase();
    const act = (exp.activity || '').toLowerCase();
    if (!seq.includes(s) && !act.includes(s)) return false;
  }
  if (historyFilters.activity && exp.activity !== historyFilters.activity) return false;
  if (historyFilters.status && exp.status !== historyFilters.status) return false;
  return true;
}

function renderHistoryRows(experiments) {
  const list = document.getElementById('historyList');
  if (!list) return;
  const filtered = experiments.slice().reverse().filter(matchesHistoryFilters);
  list.innerHTML = filtered.length
    ? filtered.map(exp => renderHistoryRowHtml(exp)).join('')
    : `<p class="text-muted" style="padding:16px">No experiments match these filters.</p>`;
}

function onHistoryFilterChange() {
  historyFilters.search = (document.getElementById('historySearchInput') || {}).value || '';
  historyFilters.activity = (document.getElementById('historyActivityFilter') || {}).value || '';
  historyFilters.status = (document.getElementById('historyStatusFilter') || {}).value || '';
  renderHistoryRows(getExperiments());
}

// Unfiltered list rendering, reused as-is by the /history slash command
// (GeneratePage.js) so both entry points — Sidebar -> History and
// Slash -> /history — render identical rows from the identical
// getExperiments() source. Only one source of truth, no second store.
export function renderHistoryListHtml(experiments) {
  if (experiments.length === 0) {
    return emptyStateHtml('🕘', 'History', 'No experiments yet. Generate your first peptide.');
  }
  return `<div class="experiments-list history-list">${experiments.slice().reverse().map(exp => renderHistoryRowHtml(exp)).join('')}</div>`;
}

export function renderHistoryRowHtml(exp) {
  const id = exp.thread_id || '';
  return `
    <div class="experiment-item history-item" data-thread-id="${id}" onclick="loadExperiment('${id}')">
      <div class="history-item-main">
        <span class="experiment-seq">${exp.sequence || '(no sequence)'}</span>
        <span class="experiment-meta">${exp.activity || '(general)'} · score ${exp.score != null ? exp.score.toFixed(4) : '–'} · ${exp.status || 'unknown'} · ${new Date(exp.timestamp).toLocaleString()}</span>
      </div>
      <div class="history-item-menu-wrap">
        <button class="history-item-menu-btn" onclick="toggleHistoryItemMenu(event, '${id}')" aria-label="Experiment actions">⋮</button>
        <div class="history-item-dropdown" id="historyMenu-${id}" style="display:none">
          <div class="history-dropdown-item" onclick="historyDropdownOpen(event, '${id}')">Open</div>
          <div class="history-dropdown-item" onclick="historyDropdownAnalyze(event, '${id}')">Analyze</div>
          <div class="history-dropdown-item" onclick="historyDropdownCompare(event, '${id}')">Compare</div>
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
      <p class="tab-hint">This experiment was saved before detailed history was available.</p>
      ${exp.sequence ? renderViewFullAnalysisButtonHtml(exp.thread_id) : ''}
    </div>
  `;
}

/* ── Rich restore (bug-investigation Fix 4, trimmed for Phase 8 Analyze
   v2 Task 8) ──────────────────────────────────────────────────────────
   Reuses the shared, container-id-parametrized PropertyCard component
   for Properties — the only tab genuinely unique to this quick-lookup
   drawer. PeptideBLEU/Structure/Novelty/Trace used to be duplicated here
   too, but Task 8 moved them to be Analyze-exclusive: the "View Full
   Analysis →" button below navigates to Analyze with this exact
   sequence, which hits AnalyzePage.js's Path A (findBySequence() match)
   and restores all of those from the same stored record — so keeping a
   second copy of StructureViewer/PeptideBLEU/NoveltyCard rendering here
   would just be duplicated logic for the same data. */
function renderSpecSectionHtml(exp) {
  if (!exp.spec) return `<p class="text-muted">No generation spec recorded for this experiment.</p>`;
  const s = exp.spec;
  return `
    <div class="spec-row"><span class="spec-label">Activity</span><span class="spec-value">${s.activity || '(general)'}</span></div>
    <div class="spec-row"><span class="spec-label">Length</span><span class="spec-value">${s.length_min}–${s.length_max} aa</span></div>
    <div class="spec-row"><span class="spec-label">Net charge</span><span class="spec-value">${s.charge_min}..${s.charge_max}</span></div>
    <div class="spec-row"><span class="spec-label">Hydrophobicity</span><span class="spec-value">${s.hydro_min}–${s.hydro_max}%</span></div>
  `;
}

function renderViewFullAnalysisButtonHtml(threadId) {
  return `<button class="btn-chip" style="margin-top:8px" onclick="viewFullAnalysis('${threadId}')">View Full Analysis →</button>`;
}

function renderFullDetailHtml(exp) {
  const heroR = {
    score: exp.score,
    rulebook_passed: exp.rulebook_passed,
    novelty_available: exp.novelty_score != null || !!exp.closest_match,
    novelty_label: exp.novelty_label,
    plddt_score: exp.plddt_score,
    plddt_confidence: exp.plddt_confidence,
    iterations: exp.iterations,
    time_seconds: exp.time_seconds,
  };

  return `
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">📄</span> EXPERIMENT DETAIL</div>
      <div class="result-sequence">${exp.sequence || '(no sequence)'}</div>
      <div class="hero-subtitle">${new Date(exp.timestamp).toLocaleString()}${exp.source === 'analyze' ? ' · via Analyze' : ''}</div>
      <div class="hero-divider"></div>
      <div class="hero-metrics">${renderHeroMetricsHtml(heroR)}</div>
      <div class="hero-divider"></div>
      <div class="hero-stats">${renderHeroStatsHtml(heroR)}</div>
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🎯</span> SPECIFICATION</div>
      ${renderSpecSectionHtml(exp)}
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧪</span> PHYSICOCHEMICAL PROPERTIES</div>
      <div id="historyPropertiesSection"></div>
    </div>

    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">✅</span> RULEBOOK VALIDATION</div>
      <div id="historyRulebookSection"></div>
      ${exp.sequence ? renderViewFullAnalysisButtonHtml(exp.thread_id) : ''}
    </div>

    <div class="result-card">
      <details class="error-technical"><summary>View raw stored record ▾</summary><pre>${escapeHtml(JSON.stringify(exp, null, 2))}</pre></details>
    </div>
  `;
}

function fillFullDetail(exp) {
  renderPropertiesTab({ descriptors: exp.descriptors, descriptors_partial: !!exp.descriptors_partial }, 'historyPropertiesSection');

  document.getElementById('historyRulebookSection').innerHTML = exp.diagnostic
    ? renderRulebookSectionHtml({ rulebook_score: exp.rulebook_score, rulebook_valid: exp.rulebook_passed }, { diagnostic: exp.diagnostic })
    : `<div class="spec-row"><span class="spec-label">Status</span><span class="spec-value">${exp.rulebook_passed === true ? '✓ Passed' : exp.rulebook_passed === false ? '✗ Failed' : '–'}</span></div>
       <div class="spec-row"><span class="spec-label">Score</span><span class="spec-value">${exp.rulebook_score != null ? exp.rulebook_score.toFixed(2) : '–'}</span></div>`;
}

/* ── Detail drawer (point 4 of the frontend spec) ─────────────────────────
   Replaces the old inline #historyDetail section stacked below the full
   list — a researcher no longer has to scroll past the whole workspace to
   inspect one experiment. A right-side overlay panel, built the same way
   as the existing delete-confirm overlay (created on open, removed on
   close) so there's no persistent DOM node to keep in sync. Its own
   scoped close handler avoids GeneratePage.js's unscoped
   switchResultTab()/.result-tab collision risk entirely — this drawer
   uses no tab markup at all, just a flat stacked list of .result-card
   sections, same as the content it's hosting. */
function onHistoryDrawerKeydown(e) {
  if (e.key === 'Escape') closeHistoryDrawer();
}

function closeHistoryDrawer() {
  const overlay = document.getElementById('historyDrawerOverlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', onHistoryDrawerKeydown);
  openDetailThreadId = null;
}

export function showHistoryDetailByThreadId(threadId) {
  const exp = getExperiment(threadId);
  if (!exp) return;
  closeHistoryDrawer();
  openDetailThreadId = threadId;

  const overlay = document.createElement('div');
  overlay.className = 'history-drawer-overlay';
  overlay.id = 'historyDrawerOverlay';
  overlay.innerHTML = `
    <div class="history-drawer-panel">
      <div class="history-drawer-header">
        <span>Experiment Detail</span>
        <button class="history-drawer-close" onclick="closeHistoryDrawer()" aria-label="Close">✕</button>
      </div>
      <div class="history-drawer-body" id="historyDrawerBody"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeHistoryDrawer(); });
  document.addEventListener('keydown', onHistoryDrawerKeydown);

  const body = document.getElementById('historyDrawerBody');
  // exp.descriptors is `undefined` only for records saved before this fix
  // (saveExperiment() now always writes the key, even as null) — old thin
  // records get the original summary view, new ones get the full restore.
  if (exp.descriptors !== undefined) {
    body.innerHTML = renderFullDetailHtml(exp);
    fillFullDetail(exp);
  } else {
    body.innerHTML = renderDetailHtml(exp);
  }
}

export function loadExperiment(threadId) {
  window.navigateTo('history');
  showHistoryDetailByThreadId(threadId);
}

function historyDropdownAnalyze(event, threadId) {
  event.stopPropagation();
  closeDropdown();
  const exp = getExperiment(threadId);
  if (!exp || !exp.sequence) { showToast('No sequence available for this experiment'); return; }
  window.navigateTo('analyze', { sequence: exp.sequence });
}

// "View Full Analysis →" button inside the open drawer — same
// destination as historyDropdownAnalyze (the row-level menu action), but
// callable from a plain button with no dropdown/event to close first.
// AnalyzePage.js's renderAnalyzeView() auto-populates the sequence and
// auto-calls startAnalyze(), which itself calls findBySequence() first —
// so this lands on Path A and restores PeptideBLEU/Structure/Novelty/
// Trace from the exact same stored record, no extra API calls.
function viewFullAnalysis(threadId) {
  const exp = getExperiment(threadId);
  if (!exp || !exp.sequence) { showToast('No sequence available for this experiment'); return; }
  window.navigateTo('analyze', { sequence: exp.sequence });
}

function historyDropdownCompare(event, threadId) {
  event.stopPropagation();
  closeDropdown();
  const exp = getExperiment(threadId);
  if (!exp || !exp.sequence) { showToast('No sequence available for this experiment'); return; }
  window.navigateTo('compare', { candidateA: exp.sequence });
}

/* ── Per-item [⋮] dropdown — Open / Delete ────────────────────────────────── */
function toggleHistoryItemMenu(event, threadId) {
  event.stopPropagation();
  toggleDropdown(`historyMenu-${threadId}`, '.history-item-menu-wrap');
}

function historyDropdownOpen(event, threadId) {
  event.stopPropagation();
  closeDropdown();
  // Routed through loadExperiment (not showHistoryDetailByThreadId
  // directly) so this menu item works identically whether it's clicked
  // from the History page itself or from the /history slash-command
  // result (GeneratePage.js), which renders the same row markup without
  // the History page's own view being active yet.
  loadExperiment(threadId);
}

function historyDropdownDelete(event, threadId) {
  event.stopPropagation();
  closeDropdown();
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
    closeHistoryDrawer();
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

window.showHistoryDetailByThreadId = showHistoryDetailByThreadId;
window.loadExperiment = loadExperiment;
window.toggleHistoryItemMenu = toggleHistoryItemMenu;
window.historyDropdownOpen = historyDropdownOpen;
window.historyDropdownAnalyze = historyDropdownAnalyze;
window.viewFullAnalysis = viewFullAnalysis;
window.historyDropdownCompare = historyDropdownCompare;
window.historyDropdownDelete = historyDropdownDelete;
window.cancelHistoryDelete = cancelHistoryDelete;
window.confirmHistoryDelete = confirmHistoryDelete;
window.closeHistoryDrawer = closeHistoryDrawer;
window.onHistoryFilterChange = onHistoryFilterChange;
