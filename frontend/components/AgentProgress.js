/* ── Agent progress timeline (Phase 8a extraction, logic unchanged) ───────
   Labels are presentational only per frontend_phase2_decisions.md Decision
   1 — they do NOT correspond 1:1 to harness/graph.py's real node names
   (see .claude/plan/AUDIT.md's REFERENCE IMAGE OBSERVATIONS). The SSE
   stream only emits one coarse "attempt" event per full lap (at the real
   "track" node) — there is no per-node "now running X" signal — so steps
   1-6 flip to completed together on the first attempt, and "Refinement"
   stands in for the whole generate/edit loop rather than a single real
   node. */
export const PROGRESS_STEPS = [
  { key: 'input_guardrail', label: 'Input Guardrail' },
  { key: 'rag_retrieval', label: 'RAG Retrieval' },
  { key: 'reference_selection', label: 'Reference Selection' },
  { key: 'generation', label: 'Generation' },
  { key: 'scoring', label: 'Scoring' },
  { key: 'validation', label: 'Validation' },
  { key: 'refinement', label: 'Refinement' },
  { key: 'post_hoc', label: 'Post-hoc Analysis' },
  { key: 'output_guardrail', label: 'Output Guardrail' },
];

export function resetProgressTimeline() {
  document.getElementById('progressTimeline').innerHTML = PROGRESS_STEPS.map(s => `
    <div class="progress-step" data-step="${s.key}">
      <span class="progress-step-icon">○</span>
      <span class="progress-step-label">${s.label}</span>
    </div>
  `).join('');
}

export function setStepState(key, state) {
  const row = document.querySelector(`.progress-step[data-step="${key}"]`);
  if (!row) return;
  row.classList.remove('completed', 'running', 'failed');
  const icon = row.querySelector('.progress-step-icon');
  if (state === 'completed') { row.classList.add('completed'); icon.textContent = '✓'; }
  else if (state === 'running') { row.classList.add('running'); icon.textContent = '●'; }
  else if (state === 'failed') { row.classList.add('failed'); icon.textContent = '✗'; }
  else { icon.textContent = '○'; }
}
