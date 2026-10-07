/* ── Analyze workflow (Phase 8e) ───────────────────────────────────────────
   Analyze does NOT run the generation agent — it only calls scoring/
   analysis tools on an existing sequence via two slash commands:
     /score SEQUENCE [--ref REFERENCE]   -> descriptors, rulebook score,
                                             PeptideBLEU (only if a
                                             reference was given)
     /explain SEQUENCE                   -> descriptors again, a richer
                                             diagnostic (violations), and
                                             a plain-English explanation

   Verified against harness/commands.py's actual handle_score()/
   handle_explain() before writing any of this (frontend_phase8e_analyze.md's
   explicit "inspect before implementing" step):
     - Neither command calls esmfold_tool/dssp_tool or novelty_tool/
       blast_novelty_tool anywhere. Structure and Novelty are therefore
       NEVER available from Analyze — Sections 5/6 below always render
       their honest "not available"/"not performed" states, never a
       fabricated one. The doc's own loading-state mockup lists a
       "Novelty" step, but since no API call ever computes it here, that
       step is deliberately omitted from ANALYZE_STEPS below rather than
       showing a progress step that can never complete.
     - handle_score()'s rulebook summary is just {score, valid} — no
       per-violation detail. handle_explain()'s diagnostic_tool call does
       have full {passed, violations, fitness, n_violations} (same shape
       DiagnosticCard.js already renders for the Trace tab), so Section 3
       combines both: diagnostic.passed/violations as the primary (richer)
       validator, with /score's legacy rulebook score shown alongside for
       transparency since the two validators can, in principle, disagree. */
import { slash } from '../services/commands.js';
import { renderPropertiesTab } from '../components/PropertyCard.js';
import { renderPeptideBleuTab } from '../components/PeptideBLEU.js';
import { renderViolationsHtml } from '../components/DiagnosticCard.js';
import { renderStructureTab } from '../components/StructureViewer.js';
import { renderNoveltyTab } from '../components/NoveltyCard.js';

let analyzeThreadId = null;

export function renderAnalyzeView(prefillSequence) {
  const el = document.getElementById('view-analyze');
  el.innerHTML = `
    <div class="generate-empty" id="analyzeEmptyState">
      <div class="generate-empty-inner">
        <div class="empty-hero-header">
          <div class="empty-hero-icon">🔬</div>
          <div class="empty-hero-tagline">Analyzing existing sequence</div>
        </div>
        <h1 class="generate-title">Analyze Peptide</h1>
        <p class="analyze-subtitle">Inspect an existing peptide sequence using PepForge's scientific analysis tools.</p>

        <div class="generate-input-wrapper">
          <textarea id="analyzeSeqInput" class="generate-textarea" rows="2" placeholder="Paste peptide sequence..."></textarea>
          <label class="analyze-ref-label">Optional reference (for PeptideBLEU):</label>
          <input id="analyzeRefInput" class="ref-input" placeholder="reference sequence" />
          <div class="generate-input-actions">
            <button class="btn-generate-main" onclick="startAnalyze()">Analyze</button>
          </div>
        </div>
      </div>
    </div>

    <div class="generate-active" id="analyzeActiveState" style="display:none">
      <div class="result-card" id="analyzeProgressCard">
        <div class="result-card-header"><span class="result-icon">⚙️</span> ANALYZING EXISTING SEQUENCE</div>
        <div class="progress-header" id="analyzeProgressHeader" style="display:none">
          <span class="spinner"></span> PepForge is analyzing...
        </div>
        <div class="progress-timeline" id="analyzeProgressTimeline"></div>
      </div>
      <div id="analyzeSections"></div>
    </div>
  `;

  if (prefillSequence) {
    document.getElementById('analyzeSeqInput').value = prefillSequence;
  }
}

/* ── Loading steps — Analyze's own set, distinct from Generate's
   AgentProgress (different workflow, no shared component listed for this
   in frontend_phase8e_analyze.md). ─────────────────────────────────────── */
const ANALYZE_STEPS = [
  { key: 'validated', label: 'Sequence validated' },
  { key: 'properties', label: 'Properties calculated' },
  { key: 'scoring', label: 'Scoring' },
  { key: 'explanation', label: 'Explanation' },
];

function resetAnalyzeProgress() {
  document.getElementById('analyzeProgressTimeline').innerHTML = ANALYZE_STEPS.map(s => `
    <div class="progress-step" data-step="analyze-${s.key}">
      <span class="progress-step-icon">○</span>
      <span class="progress-step-label">${s.label}</span>
    </div>
  `).join('');
}

function setAnalyzeStep(key, state) {
  // "analyze-" prefix keeps this selector from ever matching Generate's
  // own (hidden, but still-in-DOM) progress-step rows, which use plain
  // unprefixed keys like "input_guardrail".
  const row = document.querySelector(`.progress-step[data-step="analyze-${key}"]`);
  if (!row) return;
  row.classList.remove('completed', 'running', 'failed');
  const icon = row.querySelector('.progress-step-icon');
  if (state === 'completed') { row.classList.add('completed'); icon.textContent = '✓'; }
  else if (state === 'running') { row.classList.add('running'); icon.textContent = '●'; }
  else if (state === 'failed') { row.classList.add('failed'); icon.textContent = '✗'; }
  else { icon.textContent = '○'; }
}

/* ── Run the analysis ──────────────────────────────────────────────────────── */
async function startAnalyze() {
  const seq = document.getElementById('analyzeSeqInput').value.trim().toUpperCase();
  if (!seq) { alert('Paste a peptide sequence to analyze.'); return; }
  const reference = document.getElementById('analyzeRefInput').value.trim().toUpperCase();

  document.getElementById('analyzeEmptyState').style.display = 'none';
  document.getElementById('analyzeActiveState').style.display = 'block';
  document.getElementById('analyzeSections').innerHTML = '';
  document.getElementById('analyzeProgressHeader').style.display = 'flex';
  resetAnalyzeProgress();
  setAnalyzeStep('validated', 'running');

  if (!analyzeThreadId) analyzeThreadId = crypto.randomUUID();

  try {
    const scoreArgs = reference ? `/score ${seq} --ref ${reference}` : `/score ${seq}`;
    const scoreResult = await slash(scoreArgs, analyzeThreadId);
    setAnalyzeStep('validated', 'completed');
    setAnalyzeStep('properties', 'completed');
    setAnalyzeStep('scoring', 'completed');

    const explainResult = await slash(`/explain ${seq}`, analyzeThreadId);
    setAnalyzeStep('explanation', 'completed');

    document.getElementById('analyzeProgressHeader').style.display = 'none';
    renderAnalyzeResults(seq, reference, scoreResult, explainResult);
  } catch (err) {
    document.getElementById('analyzeProgressHeader').style.display = 'none';
    setAnalyzeStep('validated', 'failed');
    document.getElementById('analyzeSections').innerHTML = `
      <div class="result-card">
        <div class="result-card-header" style="color:var(--red)"><span class="result-icon">⚠️</span> ERROR</div>
        <p class="error-message">Could not reach the PepForge server. Make sure the backend is running.</p>
      </div>`;
  }
}

/* ── Results — 7 sections, each degrading gracefully on its own ──────────── */
function renderSequenceSectionHtml(seq, descriptors) {
  const d = descriptors || {};
  const lengthAa = d.length != null ? d.length : seq.length;
  const chargeClass = d.charge_class ? ' · ' + d.charge_class.replace(/_/g, ' ') : '';
  return `
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧬</span> SEQUENCE</div>
      <div class="result-sequence">${seq}</div>
      <div class="hero-subtitle">${lengthAa} amino acids${chargeClass}</div>
    </div>
  `;
}

function renderRulebookSectionHtml(scoreResult, explainResult) {
  const diag = explainResult && explainResult.diagnostic;
  const passed = diag ? diag.passed : null;
  const violationsHtml = diag && !diag.error
    ? renderViolationsHtml(diag.violations)
    : '<p class="text-muted">Validation not available.</p>';
  const rulebookScore = scoreResult && scoreResult.rulebook_score;
  const rulebookValid = scoreResult && scoreResult.rulebook_valid;
  return `
    <div class="spec-row"><span class="spec-label">Status</span><span class="spec-value">${passed === true ? '✓ Passed' : passed === false ? '✗ Failed' : '–'}</span></div>
    ${diag && diag.fitness != null ? `<div class="spec-row"><span class="spec-label">Fitness</span><span class="spec-value">${diag.fitness.toFixed(2)}</span></div>` : ''}
    ${violationsHtml}
    ${rulebookScore != null ? `<p class="tab-hint">Legacy rulebook score: ${rulebookScore.toFixed(2)} (${rulebookValid ? 'valid' : 'invalid'})</p>` : ''}
  `;
}

function renderExplanationSectionHtml(explainResult) {
  const text = explainResult && explainResult.explanation;
  return `<p class="tab-hint" style="font-size:13px">${text || 'Explanation not available.'}</p>`;
}

function renderAnalyzeResults(seq, reference, scoreResult, explainResult) {
  const sectionsEl = document.getElementById('analyzeSections');
  const descriptors = (scoreResult && scoreResult.descriptors) || null;

  sectionsEl.innerHTML = `
    <div id="analyzeSeqSection"></div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧪</span> PHYSICOCHEMICAL PROPERTIES</div>
      <div id="analyzePropertiesSection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">✅</span> RULEBOOK VALIDATION</div>
      <div id="analyzeRulebookSection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">📊</span> PEPTIDEBLEU</div>
      <div id="analyzeBleuSection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🧬</span> STRUCTURE</div>
      <div id="analyzeStructureSection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">🔎</span> NOVELTY</div>
      <div id="analyzeNoveltySection"></div>
    </div>
    <div class="result-card">
      <div class="result-card-header"><span class="result-icon">💬</span> EXPLANATION</div>
      <div id="analyzeExplanationSection"></div>
    </div>
  `;

  document.getElementById('analyzeSeqSection').innerHTML = renderSequenceSectionHtml(seq, descriptors);

  renderPropertiesTab({ descriptors, descriptors_partial: false }, 'analyzePropertiesSection');

  document.getElementById('analyzeRulebookSection').innerHTML = renderRulebookSectionHtml(scoreResult, explainResult);

  renderPeptideBleuTab({
    score: scoreResult.bleu_score,
    components: scoreResult.components,
    reference_used: reference || '',
  }, 'analyzeBleuSection');

  renderStructureTab({
    pdb_string: null,
    plddt_interp: 'Structural analysis is not available for the Analyze workflow — ESMFold only runs as part of a full generation.',
    sequence: seq,
  }, 'analyzeStructureSection');

  renderNoveltyTab({
    sequence: seq,
    novelty_checked: false,
    novelty_not_checked_reason: 'Novelty check is not performed in the Analyze workflow — only /score and /explain are used.',
  }, 'analyzeNoveltySection');

  document.getElementById('analyzeExplanationSection').innerHTML = renderExplanationSectionHtml(explainResult);
}

window.startAnalyze = startAnalyze;
