/* ── Score workflow (Phase 8g) ─────────────────────────────────────────────
   Verified harness/commands.py's handle_score() before writing any
   rendering code: {sequence, descriptors, bleu_score, components,
   rulebook_score, rulebook_valid}. No violations list (that's only in
   diagnostic_tool, used by /explain, not /score), and no pLDDT/pdb —
   confirmed the same absence already found for /score in Phase 8e.

   The doc's "reuse DiagnosticCard" line doesn't quite fit: DiagnosticCard
   only renders a violations array, and /score has none. Score's "API
   calls" section explicitly names /score alone (no /explain, unlike
   Analyze's two-call doc) — Rulebook validation here is therefore a
   simple pass/fail + score summary built locally, not a forced reuse of
   DiagnosticCard with a fabricated empty violations list. No structural
   section at all, per the doc's own note (/score never returns pdb).

   A real backend gap was found and fixed before this page was built:
   handle_score()'s --activity option passed the raw frontend activity
   name (e.g. "anti-bacterial") straight to peptide_bleu_tool, which only
   recognizes preset codes (amp/cpp/signal/immunological) — silently
   falling back to default weights for every one of the 13 dropdown
   choices. Fixed in harness/commands.py to mirror harness/graph.py's
   _preset() mapping (backend/agent.py's ACTIVITY_PRESET_MAP), verified
   live before this page assumed the dropdown actually works. */
import { slash } from '../services/commands.js';
import { renderPropertiesTab } from '../components/PropertyCard.js';
import { renderPeptideBleuTab } from '../components/PeptideBLEU.js';

const ALL_ACTIVITIES = [
  'anti-bacterial', 'anti-cancer', 'anti-fungal', 'anti-parasitic',
  'anti-viral', 'cell-cell-communication', 'drug-delivery',
  'immunological', 'inhibitor', 'metabolic', 'other-functional',
  'signal-peptide', 'toxic',
];

let scoreThreadId = null;

export function renderScoreView() {
  const el = document.getElementById('view-score');
  el.innerHTML = `
    <div class="generate-empty" id="scoreEmptyState">
      <div class="generate-empty-inner">
        <div class="empty-hero-header">
          <div class="empty-hero-icon">📊</div>
          <div class="empty-hero-tagline">Scoring existing sequence, not generating</div>
        </div>
        <h1 class="generate-title">Score Peptide</h1>
        <p class="analyze-subtitle">Evaluate an existing peptide using PepForge's scoring and validation pipeline.</p>

        <div class="generate-input-wrapper">
          <textarea id="scoreSeqInput" class="generate-textarea" rows="2" placeholder="Paste peptide sequence"></textarea>
          <label class="analyze-ref-label">Optional reference (required for PeptideBLEU):</label>
          <input id="scoreRefInput" class="ref-input" placeholder="reference sequence" />
          <label class="analyze-ref-label">Activity:</label>
          <select id="scoreActivityInput" class="ref-input"></select>
          <div class="generate-input-actions">
            <button class="btn-generate-main" onclick="startScore()">Score</button>
          </div>
        </div>
      </div>
    </div>

    <div class="generate-active" id="scoreActiveState" style="display:none">
      <div class="progress-header" id="scoreProgressHeader" style="display:none">
        <span class="spinner"></span> PepForge is scoring...
      </div>
      <div id="scoreSections"></div>
    </div>
  `;

  const sel = document.getElementById('scoreActivityInput');
  sel.innerHTML = '<option value="">(none — general)</option>' +
    ALL_ACTIVITIES.map(a => `<option value="${a}">${a}</option>`).join('');
}

async function startScore() {
  const seq = document.getElementById('scoreSeqInput').value.trim().toUpperCase();
  if (!seq) { alert('Paste a peptide sequence to score.'); return; }
  const reference = document.getElementById('scoreRefInput').value.trim().toUpperCase();
  const activity = document.getElementById('scoreActivityInput').value;

  document.getElementById('scoreEmptyState').style.display = 'none';
  document.getElementById('scoreActiveState').style.display = 'block';
  document.getElementById('scoreSections').innerHTML = '';
  document.getElementById('scoreProgressHeader').style.display = 'flex';

  if (!scoreThreadId) scoreThreadId = crypto.randomUUID();

  try {
    let cmd = `/score ${seq}`;
    if (reference) cmd += ` --ref ${reference}`;
    if (activity) cmd += ` --activity ${activity}`;
    const result = await slash(cmd, scoreThreadId);
    document.getElementById('scoreProgressHeader').style.display = 'none';
    renderScoreResults(result, reference);
  } catch (err) {
    document.getElementById('scoreProgressHeader').style.display = 'none';
    document.getElementById('scoreSections').innerHTML = `
      <div class="result-card">
        <div class="result-card-header" style="color:var(--red)"><span class="result-icon">⚠️</span> ERROR</div>
        <p class="error-message">Could not reach the PepForge server. Make sure the backend is running.</p>
      </div>`;
  }
}

function renderRulebookSummaryHtml(result) {
  const passed = result.rulebook_valid;
  const score = result.rulebook_score;
  return `
    <div class="spec-row"><span class="spec-label">Status</span><span class="spec-value">${passed === true ? '✓ Passed' : passed === false ? '✗ Failed' : '–'}</span></div>
    <div class="spec-row"><span class="spec-label">Score</span><span class="spec-value">${score != null ? score.toFixed(2) : '–'}</span></div>
    <p class="tab-hint">Per-violation detail is not available via /score — use Analyze for a full diagnostic breakdown.</p>
  `;
}

function renderScoreResults(result, reference) {
  const sectionsEl = document.getElementById('scoreSections');
  const bleuScore = result.bleu_score;

  sectionsEl.innerHTML = `
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">📊</span> PEPTIDEBLEU SCORE</div>
      <div class="score-hero-value">${bleuScore != null ? bleuScore.toFixed(4) : '–'}</div>
      <div id="scoreBleuSection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧪</span> PHYSICOCHEMICAL PROPERTIES</div>
      <div id="scorePropertiesSection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">✅</span> RULEBOOK VALIDATION</div>
      <div id="scoreRulebookSection"></div>
    </div>
  `;

  renderPeptideBleuTab({
    score: result.bleu_score,
    components: result.components,
    reference_used: reference || '',
  }, 'scoreBleuSection');

  renderPropertiesTab({
    descriptors: result.descriptors,
    descriptors_partial: false,
  }, 'scorePropertiesSection');

  document.getElementById('scoreRulebookSection').innerHTML = renderRulebookSummaryHtml(result);
}

window.startScore = startScore;
