/* ── Recent experiments store (Phase 8a extraction, logic from old app.js
   "Recent experiments" section — frontend_phase2_decisions.md Decision 3).
   Pure data/localStorage — no DOM here; callers re-render their own UI
   after calling saveExperiment(). */
const EXPERIMENTS_KEY = 'pepforge_experiments';
const MAX_EXPERIMENTS = 50; // frontend_phase8a_modular.md services spec (was 20 pre-Phase-8)

export function getExperiments() {
  try {
    return JSON.parse(localStorage.getItem(EXPERIMENTS_KEY)) || [];
  } catch {
    return [];
  }
}

export function saveExperiment(result, spec) {
  const entry = {
    thread_id: result.thread_id || null,
    sequence: result.sequence || '',
    score: result.score != null ? result.score : null,
    activity: (spec && spec.activity) || '',
    timestamp: Date.now(),
    status: result.status || 'unknown',
  };
  const experiments = getExperiments();
  experiments.push(entry);
  while (experiments.length > MAX_EXPERIMENTS) experiments.shift();
  try { localStorage.setItem(EXPERIMENTS_KEY, JSON.stringify(experiments)); } catch { /* storage unavailable */ }
  try { sessionStorage.setItem('pepforge_current_experiment', JSON.stringify(entry)); } catch { /* storage unavailable */ }
  return entry;
}

export function getExperiment(threadId) {
  return getExperiments().find(e => e.thread_id === threadId) || null;
}

export function deleteExperiment(threadId) {
  const experiments = getExperiments().filter(e => e.thread_id !== threadId);
  try { localStorage.setItem(EXPERIMENTS_KEY, JSON.stringify(experiments)); } catch { /* storage unavailable */ }
  return experiments;
}
