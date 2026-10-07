/* ── Entry point: router, sidebar, global init (Phase 8a refactor) ───────
   Everything that used to live in this one file (Phases 3-7) has moved
   into services/, components/, and pages/ — see
   .claude/plan/frontend_phase8a_modular.md. This file now owns only the
   app-shell chrome (sidebar + router) and startup wiring. */
import { health } from './services/api.js';
import { getExperiments } from './services/history.js';
import { renderHistoryView } from './pages/HistoryPage.js';
import { initGeneratePage } from './pages/GeneratePage.js';
import { renderAnalyzeView } from './pages/AnalyzePage.js';
import { renderCompareView } from './pages/ComparePage.js';

/* ── Router + sidebar ──────────────────────────────────────────────────── */
const VIEWS = ['generate', 'analyze', 'compare', 'score', 'history'];

// Minimal "router state" hand-off (frontend_phase8i_actions.md's "simple
// router state object — no URL routing needed"), built out as far as each
// page's own entry point needs: Analyze's (Phase 8e) and Compare's
// (Phase 8f) candidate-result buttons both reuse this same `state` param.
// Pass undefined for a plain nav-item click (no prefill).
function navigateTo(view, state) {
  if (!VIEWS.includes(view)) view = 'generate';
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  if (view === 'history') renderHistoryView();
  if (view === 'analyze') renderAnalyzeView((state && state.sequence) || null);
  if (view === 'compare') renderCompareView((state && state.candidateA) || null);
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('drawer-open');
  }
}

function toggleSidebarCollapse() {
  const sidebar = document.getElementById('sidebar');
  if (window.innerWidth <= 768) {
    sidebar.classList.toggle('drawer-open');
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

// Basic, non-polished responsive behavior per frontend_phase2_decisions.md
// scope note ("Full responsive mobile" deferred, desktop-first for demo):
// auto-collapse to the icon rail at tablet widths, auto-expand on desktop.
// A user's manual toggle (above) can override this until the next resize.
function handleSidebarResize() {
  const sidebar = document.getElementById('sidebar');
  const w = window.innerWidth;
  if (w <= 768) {
    sidebar.classList.remove('collapsed');
  } else if (w <= 1200) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
  }
}

/* ── Recent experiments sidebar list (frontend_phase2_decisions.md
   Decision 3) — rendering stays here since the sidebar is app-shell
   chrome visible across every page, not Generate-page-specific; the
   underlying data lives in services/history.js. */
function renderExperimentsList() {
  const list = document.getElementById('experimentsList');
  const experiments = getExperiments();
  if (experiments.length === 0) {
    list.innerHTML = '<div class="experiments-empty">No experiments yet</div>';
    return;
  }
  list.innerHTML = experiments.slice().reverse().map(exp => `
    <div class="experiment-item" onclick="loadExperiment('${exp.thread_id}')">
      <span class="experiment-seq">${exp.sequence || '(no sequence)'}</span>
      <span class="experiment-meta">${exp.activity || ''} · ${new Date(exp.timestamp).toLocaleString()}</span>
    </div>
  `).join('');
}

/* ── Health check ────────────────────────────────────────────────────────── */
async function checkHealth() {
  try {
    const data = await health();
    setStatus(data.status === 'ok');
  } catch {
    setStatus(false);
  }
}

function setStatus(ok) {
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className  = 'status-dot' + (ok ? '' : ' error');
  text.textContent = ok ? 'Ready' : 'Error';
}

/* ── Init ────────────────────────────────────────────────────────────────── */
function init() {
  initGeneratePage();
  renderExperimentsList();
  checkHealth();
  handleSidebarResize();
  window.addEventListener('resize', handleSidebarResize);
}

// GeneratePage.js and HistoryPage.js call these back via window (not a
// static import) to avoid a circular module dependency with this file.
window.navigateTo = navigateTo;
window.toggleSidebarCollapse = toggleSidebarCollapse;
window.renderExperimentsList = renderExperimentsList;

document.addEventListener('DOMContentLoaded', init);
