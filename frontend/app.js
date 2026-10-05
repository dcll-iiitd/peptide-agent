/* ── Config ──────────────────────────────────────────────────────────────── */
const API_BASE = 'http://localhost:8000';

const ALL_ACTIVITIES = [
  'anti-bacterial', 'anti-cancer', 'anti-fungal', 'anti-parasitic',
  'anti-viral', 'cell-cell-communication', 'drug-delivery',
  'immunological', 'inhibitor', 'metabolic', 'other-functional',
  'signal-peptide', 'toxic',
];

const COMPONENT_LABELS = {
  ngram_bleu: 'N-gram BLEU',
  charge: 'Charge',
  hydrophobicity: 'Hydrophobicity',
  functional_group: 'Functional Group',
  property_distribution: 'Property Distribution',
  structural: 'Structural',
  blosum: 'BLOSUM62',
};

/* ── State ───────────────────────────────────────────────────────────────── */
let currentPdb = null;    // raw PDB text for the last successful structure prediction (Phase 5)
let structureViewer = null;
let currentHitlThreadId = null;  // thread_id of the generation currently paused for approval
let commandThreadId = null;      // stable thread_id reused across /command calls this session
let isGenerating = false;
let currentSpec = null;          // last parsed/advanced-panel spec used for the active run
let lastRunningStepKey = null;   // which progress step was "running" when an error arrived

/* ── Init ────────────────────────────────────────────────────────────────── */
function init() {
  buildActivityDropdown();
  renderExperimentsList();
  checkHealth();
  handleSidebarResize();
  window.addEventListener('resize', handleSidebarResize);
}

/* ── Router + sidebar (Phase 3) ───────────────────────────────────────────── */
const VIEWS = ['generate', 'analyze', 'compare', 'score', 'history'];

function navigateTo(view) {
  if (!VIEWS.includes(view)) view = 'generate';
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('drawer-open');
  }
}

function newExperiment() {
  navigateTo('generate');
  if (isGenerating) return;
  document.getElementById('generateActive').style.display = 'none';
  document.getElementById('generateEmpty').style.display = '';
  document.getElementById('genInput').value = '';
  document.getElementById('advancedPanel').style.display = 'none';
  document.querySelector('.view-placeholder-template')?.remove();
  hideHitlPanel();
  currentSpec = null;
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

/* ── Templates (Phase 4) ───────────────────────────────────────────────────
   Pre-fills both the free-text input and the Advanced panel fields so
   either path (NL parse or Advanced) produces the same spec. */
const TEMPLATE_PRESETS = {
  amp: {
    activity: 'anti-bacterial', length_min: 15, length_max: 20, charge_min: 2, charge_max: 5,
    hydro_min: 35, hydro_max: 55,
    text: 'Generate an antimicrobial peptide with 15–20 residues, charge +2 to +5, hydrophobicity 35–55%.',
  },
  cpp: {
    activity: 'drug-delivery', length_min: 12, length_max: 16, charge_min: 4, charge_max: 8,
    hydro_min: 30, hydro_max: 50,
    text: 'Generate a cell-penetrating peptide with 12–16 residues, charge +4 to +8, hydrophobicity 30–50%.',
  },
  antifungal: {
    activity: 'anti-fungal', length_min: 15, length_max: 25, charge_min: 2, charge_max: 6,
    hydro_min: 35, hydro_max: 55,
    text: 'Generate an antifungal peptide with 15–25 residues, charge +2 to +6, hydrophobicity 35–55%.',
  },
  antiviral: {
    activity: 'anti-viral', length_min: 15, length_max: 25, charge_min: 2, charge_max: 6,
    hydro_min: 30, hydro_max: 50,
    text: 'Generate an antiviral peptide with 15–25 residues, charge +2 to +6, hydrophobicity 30–50%.',
  },
  immunological: {
    activity: 'immunological', length_min: 10, length_max: 20, charge_min: 0, charge_max: 4,
    hydro_min: 30, hydro_max: 50,
    text: 'Generate an immunological/epitope peptide with 10–20 residues, charge 0 to +4, hydrophobicity 30–50%.',
  },
};

function applyTemplate(name) {
  navigateTo('generate');
  const preset = TEMPLATE_PRESETS[name];
  if (!preset) {
    // "Custom" — just focus the free-text input, no prefill.
    document.getElementById('genInput').focus();
    return;
  }
  document.getElementById('genInput').value = preset.text;
  document.getElementById('advLenMin').value = preset.length_min;
  document.getElementById('advLenMax').value = preset.length_max;
  document.getElementById('advChargeMin').value = preset.charge_min;
  document.getElementById('advChargeMax').value = preset.charge_max;
  document.getElementById('advHydroMin').value = preset.hydro_min;
  document.getElementById('advHydroMax').value = preset.hydro_max;
  document.getElementById('advActivity').value = preset.activity;
}

/* ── Recent experiments (frontend_phase2_decisions.md Decision 3) ────────── */
const EXPERIMENTS_KEY = 'pepforge_experiments';

function loadExperiments() {
  try {
    return JSON.parse(localStorage.getItem(EXPERIMENTS_KEY)) || [];
  } catch {
    return [];
  }
}

function recordExperiment(result, spec) {
  const entry = {
    thread_id: result.thread_id || null,
    sequence: result.sequence || '',
    score: result.score != null ? result.score : null,
    activity: (spec && spec.activity) || '',
    timestamp: Date.now(),
    status: result.status || 'unknown',
  };
  const experiments = loadExperiments();
  experiments.push(entry);
  while (experiments.length > 20) experiments.shift();
  try { localStorage.setItem(EXPERIMENTS_KEY, JSON.stringify(experiments)); } catch { /* storage unavailable */ }
  try { sessionStorage.setItem('pepforge_current_experiment', JSON.stringify(entry)); } catch { /* storage unavailable */ }
  renderExperimentsList();
}

function renderExperimentsList() {
  const list = document.getElementById('experimentsList');
  const experiments = loadExperiments();
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

function loadExperiment(threadId) {
  // Phase 5 loads the full stored result for this thread_id into the
  // result view. For now just surfaces the History placeholder.
  navigateTo('history');
}

/* ── Health check ────────────────────────────────────────────────────────── */
async function checkHealth() {
  try {
    const r = await fetch(`${API_BASE}/health`);
    const data = await r.json();
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

/* ── Advanced panel (Phase 4) ─────────────────────────────────────────────── */
function buildActivityDropdown() {
  const sel = document.getElementById('advActivity');
  sel.innerHTML = '<option value="">(none — general)</option>' +
    ALL_ACTIVITIES.map(a => `<option value="${a}">${a}</option>`).join('');
}

function toggleAdvancedPanel() {
  const panel = document.getElementById('advancedPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function openAdvancedPanel() {
  document.getElementById('advancedPanel').style.display = 'block';
}

function readAdvancedPanel() {
  return {
    activity: document.getElementById('advActivity').value,
    length_min: parseInt(document.getElementById('advLenMin').value) || 10,
    length_max: parseInt(document.getElementById('advLenMax').value) || 50,
    charge_min: parseFloat(document.getElementById('advChargeMin').value) || 0,
    charge_max: parseFloat(document.getElementById('advChargeMax').value) || 5,
    hydro_min: parseFloat(document.getElementById('advHydroMin').value) || 0,
    hydro_max: parseFloat(document.getElementById('advHydroMax').value) || 100,
    max_retries: parseInt(document.getElementById('advMaxRetries').value) || 6,
    threshold: parseFloat(document.getElementById('advThreshold').value) || 0.35,
    hitl_enabled: document.getElementById('advHitlEnabled').checked,
    use_legacy: document.getElementById('advUseLegacy').checked,
  };
}

/* ── Slash command menu (Phase 4) ─────────────────────────────────────────── */
const COMMAND_MENU_ITEMS = [
  { cmd: '/generate', desc: 'Generate peptide' },
  { cmd: '/score', desc: 'Score sequence' },
  { cmd: '/edit', desc: 'Refine sequence' },
  { cmd: '/compare', desc: 'Compare candidates' },
  { cmd: '/explain', desc: 'Explain sequence' },
  { cmd: '/history', desc: 'Previous experiments' },
];

function toggleCommandMenu() {
  const menu = document.getElementById('commandMenu');
  if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
  menu.innerHTML = COMMAND_MENU_ITEMS.map(c =>
    `<div class="command-menu-item" onclick="insertCommand('${c.cmd}')"><b>${c.cmd}</b>${c.desc}</div>`
  ).join('');
  menu.style.display = 'block';
}

function insertCommand(cmd) {
  const input = document.getElementById('genInput');
  input.value = `${cmd} `;
  input.focus();
  document.getElementById('commandMenu').style.display = 'none';
}

function onGenInputChange() {
  const input = document.getElementById('genInput');
  const menu = document.getElementById('commandMenu');
  if (input.value.startsWith('/') && !input.value.includes(' ')) {
    if (menu.style.display === 'none') toggleCommandMenu();
  } else {
    menu.style.display = 'none';
  }
}

/* ── Natural-language spec parsing (frontend_phase2_decisions.md Decision 6)
   Simple keyword/number extraction, frontend-only — no backend NLP
   endpoint. Falls back to showing the Advanced panel when nothing
   meaningful was parsed, rather than silently guessing defaults. */
const ACTIVITY_KEYWORDS = {
  'anti-bacterial': ['antibacterial', 'antimicrobial', 'amp'],
  'anti-fungal': ['antifungal'],
  'anti-viral': ['antiviral'],
  'anti-cancer': ['anticancer', 'antitumor', 'anti-cancer'],
  'anti-parasitic': ['antiparasitic'],
  'drug-delivery': ['cell-penetrating', 'cell penetrating', 'cpp', 'drug delivery', 'drug-delivery'],
  'signal-peptide': ['signal peptide', 'signal-peptide'],
  'immunological': ['immunological', 'immune', 'epitope'],
  'toxic': ['toxic', 'toxin'],
  'cell-cell-communication': ['cell-cell', 'cell to cell signal'],
  'inhibitor': ['inhibitor', 'inhibitory'],
  'metabolic': ['metabolic'],
};

function parseNaturalLanguage(text) {
  const lower = text.toLowerCase();
  const spec = {
    activity: '', length_min: null, length_max: null,
    charge_min: null, charge_max: null, hydro_min: null, hydro_max: null,
    max_retries: 6, threshold: 0.35, hitl_enabled: false, use_legacy: false,
  };
  let matched = 0;

  for (const [act, keywords] of Object.entries(ACTIVITY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) { spec.activity = act; matched++; break; }
  }

  let m = lower.match(/(\d+)\s*(?:-|to|–)\s*(\d+)\s*(?:residues|amino acids|aa)/);
  if (m) {
    spec.length_min = parseInt(m[1]); spec.length_max = parseInt(m[2]); matched++;
  } else {
    m = lower.match(/(\d+)\s*(?:residues|amino acids|aa)\b/);
    if (m) { spec.length_min = spec.length_max = parseInt(m[1]); matched++; }
  }

  m = lower.match(/charge[^+\-\d]*([+-]?\d+)\s*(?:to|and|–|-)\s*([+-]?\d+)/);
  if (m) { spec.charge_min = parseInt(m[1]); spec.charge_max = parseInt(m[2]); matched++; }

  m = lower.match(/(?:hydrophobicity|hydrophobic|hydro)[^%\d]*(\d+)\s*%?\s*(?:to|and|–|-)\s*(\d+)\s*%/);
  if (m) { spec.hydro_min = parseFloat(m[1]); spec.hydro_max = parseFloat(m[2]); matched++; }

  spec.confidence = matched === 0 ? 'low' : matched === 1 ? 'medium' : 'high';

  if (spec.length_min == null) { spec.length_min = 10; spec.length_max = 50; }
  if (spec.charge_min == null) { spec.charge_min = 2; spec.charge_max = 5; }
  if (spec.hydro_min == null) { spec.hydro_min = 30; spec.hydro_max = 50; }

  return spec;
}

/* ── Generation (Phase 4) ─────────────────────────────────────────────────── */
function startGeneration() {
  if (isGenerating) return;

  const text = document.getElementById('genInput').value.trim();
  if (text.startsWith('/')) {
    runSlashCommand(text);
    return;
  }

  const advancedOpen = document.getElementById('advancedPanel').style.display !== 'none';
  let spec;
  if (advancedOpen) {
    spec = readAdvancedPanel();
  } else {
    if (!text) {
      alert('Describe your peptide objective, or open Advanced to set fields directly.');
      return;
    }
    const parsed = parseNaturalLanguage(text);
    if (parsed.confidence === 'low') {
      openAdvancedPanel();
      alert("Couldn't confidently parse that — set the fields in Advanced and click Generate again.");
      return;
    }
    spec = parsed;
  }

  currentSpec = spec;
  showParsedSpecCard(spec);
  runGeneration(spec);
}

function fmtCharge(v) { return v >= 0 ? `+${v}` : `${v}`; }

function showParsedSpecCard(spec) {
  document.getElementById('specCard').style.display = 'block';
  document.getElementById('progressCard').style.display = 'block';
  document.getElementById('specGrid').innerHTML = `
    <div class="spec-row"><span class="spec-label">Activity</span><span class="spec-value">${spec.activity || '(none — general)'}</span></div>
    <div class="spec-row"><span class="spec-label">Length</span><span class="spec-value">${spec.length_min}–${spec.length_max} aa</span></div>
    <div class="spec-row"><span class="spec-label">Net charge</span><span class="spec-value">${fmtCharge(spec.charge_min)} to ${fmtCharge(spec.charge_max)}</span></div>
    <div class="spec-row"><span class="spec-label">Hydrophobicity</span><span class="spec-value">${spec.hydro_min}–${spec.hydro_max}%</span></div>
    <div class="spec-row"><span class="spec-label">Max rounds</span><span class="spec-value">${spec.max_retries}</span></div>
  `;
}

async function runGeneration(spec) {
  isGenerating = true;
  document.getElementById('generateEmpty').style.display = 'none';
  document.getElementById('generateActive').style.display = 'block';
  document.getElementById('commandResultCard').style.display = 'none';
  document.getElementById('bestCandidateCard').style.display = 'none';
  document.getElementById('errorCard').style.display = 'none';
  hideHitlPanel();
  resetProgressTimeline();
  setStepState('input_guardrail', 'running');
  lastRunningStepKey = 'input_guardrail';

  const useHarness = !spec.use_legacy;
  const body = {
    activities: spec.activity ? [spec.activity] : [],
    length_min: spec.length_min,
    length_max: spec.length_max,
    charge_min: spec.charge_min,
    charge_max: spec.charge_max,
    hydro_min: spec.hydro_min,
    hydro_max: spec.hydro_max,
    max_retries: spec.max_retries,
    threshold: spec.threshold,
  };
  if (useHarness) body.hitl_enabled = !!spec.hitl_enabled;

  let attemptCount = 0;

  try {
    const response = await fetch(`${API_BASE}/generate${useHarness ? '?harness=true' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            attemptCount = handleGenerationEvent(evt, attemptCount);
          } catch { /* skip malformed */ }
        }
      }
    }
  } catch (err) {
    setStepState(lastRunningStepKey || 'input_guardrail', 'failed');
    showErrorCard(String(err));
  } finally {
    isGenerating = false;
  }
}

function handleGenerationEvent(evt, attemptCount) {
  if (evt.type === 'attempt') {
    attemptCount++;
    if (attemptCount === 1) {
      ['input_guardrail', 'rag_retrieval', 'reference_selection', 'generation', 'scoring', 'validation']
        .forEach(k => setStepState(k, 'completed'));
      setStepState('refinement', 'running');
      lastRunningStepKey = 'refinement';
    }
  } else if (evt.type === 'hitl') {
    showHitlPanel(evt.data);
  } else if (evt.type === 'final') {
    hideHitlPanel();
    setStepState('refinement', 'completed');
    setStepState('post_hoc', 'completed');
    setStepState('output_guardrail', 'completed');
    showBestCandidate(evt.result);
    recordExperiment(evt.result, currentSpec);
  } else if (evt.type === 'error') {
    setStepState(lastRunningStepKey || 'generation', 'failed');
    showErrorCard(evt.message || 'Generation failed.');
  }
  return attemptCount;
}

async function runSlashCommand(text) {
  if (!commandThreadId) commandThreadId = crypto.randomUUID();

  document.getElementById('generateEmpty').style.display = 'none';
  document.getElementById('generateActive').style.display = 'block';
  document.getElementById('specCard').style.display = 'none';
  document.getElementById('progressCard').style.display = 'none';
  document.getElementById('bestCandidateCard').style.display = 'none';
  document.getElementById('errorCard').style.display = 'none';

  const out = document.getElementById('commandResultOutput');
  const card = document.getElementById('commandResultCard');
  out.textContent = 'Running…';
  card.style.display = 'block';

  try {
    const r = await fetch(`${API_BASE}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, thread_id: commandThreadId }),
    });
    const data = await r.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = `Error: ${err}`;
  }
}

/* ── Agent progress timeline (Phase 4) ────────────────────────────────────
   Labels are presentational only per frontend_phase2_decisions.md Decision
   1 — they do NOT correspond 1:1 to harness/graph.py's real node names
   (see frontend/AUDIT.md's REFERENCE IMAGE OBSERVATIONS). The SSE stream
   only emits one coarse "attempt" event per full lap (at the real "track"
   node) — there is no per-node "now running X" signal — so steps 1-6 flip
   to completed together on the first attempt, and "Refinement" stands in
   for the whole generate/edit loop rather than a single real node. */
const PROGRESS_STEPS = [
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

function resetProgressTimeline() {
  document.getElementById('progressTimeline').innerHTML = PROGRESS_STEPS.map(s => `
    <div class="progress-step" data-step="${s.key}">
      <span class="progress-step-icon">○</span>
      <span class="progress-step-label">${s.label}</span>
    </div>
  `).join('');
}

function setStepState(key, state) {
  const row = document.querySelector(`.progress-step[data-step="${key}"]`);
  if (!row) return;
  row.classList.remove('completed', 'running', 'failed');
  const icon = row.querySelector('.progress-step-icon');
  if (state === 'completed') { row.classList.add('completed'); icon.textContent = '✓'; }
  else if (state === 'running') { row.classList.add('running'); icon.textContent = '●'; }
  else if (state === 'failed') { row.classList.add('failed'); icon.textContent = '✗'; }
  else { icon.textContent = '○'; }
}

/* ── Best candidate card (Phase 4 — minimal; full tabs are Phase 5) ──────── */
function showBestCandidate(result) {
  const card = document.getElementById('bestCandidateCard');
  const seqEl = document.getElementById('resultSequence');
  const metaEl = document.getElementById('bestCandidateMeta');

  seqEl.textContent = result.sequence || 'No sequence generated';
  const displayScore = result.score != null ? result.score : result.rulebook_score;
  seqEl.className = 'result-sequence' + (displayScore != null ? ' ' + scoreClass(displayScore) : '');

  const parts = [];
  if (result.score != null) parts.push(`PeptideBLEU <b>${result.score.toFixed(4)}</b>`);
  if (result.rulebook_score != null) parts.push(`Rulebook <b>${result.rulebook_score.toFixed(2)}</b>`);
  parts.push(`Status <b>${result.status === 'complete' ? 'Passed' : (result.status || 'unknown')}</b>`);
  if (result.iterations != null) parts.push(`Iterations <b>${result.iterations}</b>`);
  if (result.time_seconds != null) parts.push(`Time <b>${result.time_seconds.toFixed(1)}s</b>`);
  metaEl.innerHTML = parts.map(p => `<span>${p}</span>`).join('');

  renderTraceLink(result.trace_url);
  card.style.display = 'block';
}

function showErrorCard(message) {
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('errorCard').style.display = 'block';
}

function copySequence() {
  const seq = document.getElementById('resultSequence').textContent.trim();
  if (!seq) return;
  navigator.clipboard?.writeText(seq).catch(() => {});
}

function exportFasta() {
  const seq = document.getElementById('resultSequence').textContent.trim();
  if (!seq) return;
  const fasta = `>PepForge_candidate\n${seq}\n`;
  const blob = new Blob([fasta], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${seq.slice(0, 20)}.fasta`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── HITL approval panel (Week 4 task 5, reused as-is in Phase 4) ────────── */
function showHitlPanel(data) {
  currentHitlThreadId = data.thread_id;
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

function hideHitlPanel() {
  document.getElementById('hitlPanel').style.display = 'none';
  currentHitlThreadId = null;
}

function hitlShowModify() {
  document.getElementById('hitlModifyRow').style.display = 'flex';
}

async function hitlDecide(action) {
  if (!currentHitlThreadId) return;
  const decision = { action };
  if (action === 'modify') {
    const seq = document.getElementById('hitlModifySequence').value.trim().toUpperCase();
    if (!seq) { alert('Enter a replacement sequence first.'); return; }
    decision.sequence = seq;
  }

  const threadId = currentHitlThreadId;
  document.getElementById('hitlPanel').style.display = 'none';
  // The paused /generate request stays open on its own connection — resuming
  // just unblocks it server-side, after which the same stream keeps yielding
  // attempt/hitl/final events with no further action needed here.
  try {
    await fetch(`${API_BASE}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId, decision }),
    });
  } catch (err) {
    console.error('resume failed:', err);
  }
}

/* ── Diagnostic violations (dormant — Phase 5's Trace/Properties tab) ────── */
function renderViolations(violations) {
  const card = document.getElementById('violationsCard');
  const list = document.getElementById('violationsList');
  if (!card || !list) return;
  if (!violations || violations.length === 0) {
    card.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  list.innerHTML = violations.map(v => `
    <div class="violation-row">
      <span class="violation-rule">${v.rule}</span>
      <span class="violation-detail">current: ${v.current} → target: ${v.target}</span>
      <span class="violation-fix">${v.fix}</span>
    </div>
  `).join('');
  card.style.display = 'block';
}

/* ── Edit statistics (dormant — Phase 5's Trace tab) ──────────────────────── */
function renderEditStats(stats) {
  const card = document.getElementById('editStatsCard');
  const list = document.getElementById('editStatsList');
  if (!card || !list) return;
  list.innerHTML = '';
  if (!stats || Object.keys(stats).length === 0) {
    card.style.display = 'none';
    return;
  }
  Object.entries(stats).forEach(([op, s]) => {
    const deltaStr = s.avg_delta >= 0 ? `+${s.avg_delta.toFixed(4)}` : s.avg_delta.toFixed(4);
    const row = document.createElement('div');
    row.className = 'comp-row';
    row.innerHTML = `
      <span class="comp-label">${op}</span>
      <span class="comp-val" style="width:auto">${s.count} used · ${s.improvements} improved · avg Δ ${deltaStr}</span>
    `;
    list.appendChild(row);
  });
  card.style.display = 'block';
}

/* ── LangSmith trace link (actively used by showBestCandidate) ───────────── */
function renderTraceLink(url) {
  const link = document.getElementById('traceLink');
  if (!link) return;
  if (!url) { link.style.display = 'none'; return; }
  link.href = url;
  link.style.display = 'inline-block';
}

/* pLDDT (ESMFold) structural confidence — dormant, Phase 5's Structure tab */
const PLDDT_COLORS = {
  very_high: { color: '#00e5c3', label: 'Very High' },
  high:      { color: '#3b82f6', label: 'Confident' },
  low:       { color: '#fbbf24', label: 'Low' },
  very_low:  { color: '#ef4444', label: 'Very Low' },
  unknown:   { color: '#64748b', label: 'N/A' },
};

function renderPlddt(score, confidence) {
  const badge = document.getElementById('metricPlddt');
  const valueEl = document.getElementById('plddtValue');
  if (!badge || !valueEl) return;
  if (score == null) {
    badge.style.display = 'none';
    return;
  }
  const style = PLDDT_COLORS[confidence] || PLDDT_COLORS.unknown;
  valueEl.textContent = `${score.toFixed(1)}  ${style.label}`;
  valueEl.style.color = style.color;
  badge.style.display = '';
}

/* BLAST novelty assessment — dormant, Phase 5's Novelty tab */
const NOVELTY_COLORS = {
  novel:          { color: '#00e5c3', label: 'Novel' },
  low_similarity: { color: '#34d399', label: 'Mostly Novel' },
  similar:        { color: '#fbbf24', label: 'Similar' },
  known:          { color: '#ef4444', label: 'Known' },
  unknown:        { color: '#64748b', label: 'N/A' },
};

function renderNovelty(blast) {
  const badge = document.getElementById('metricNovelty');
  const valueEl = document.getElementById('noveltyValue');
  const card = document.getElementById('noveltyCard');
  const barsEl = document.getElementById('noveltyBars');
  const interpEl = document.getElementById('noveltyInterp');
  if (!badge || !card) return;

  if (!blast) {
    badge.style.display = 'none';
    card.style.display = 'none';
    return;
  }

  const style = NOVELTY_COLORS[blast.novelty_label] || NOVELTY_COLORS.unknown;

  if (!blast.blast_available) {
    badge.style.display = 'none';
    barsEl.innerHTML = '';
    interpEl.textContent = 'BLAST not installed (sudo apt-get install ncbi-blast+)';
    card.style.display = 'block';
    return;
  }

  if (!blast.db_exists) {
    badge.style.display = 'none';
    barsEl.innerHTML = '';
    interpEl.textContent = 'Building database... (first run only)';
    card.style.display = 'block';
    return;
  }

  valueEl.textContent = style.label;
  valueEl.style.color = style.color;
  badge.style.display = '';

  barsEl.innerHTML = '';
  if (blast.similarity_score != null) {
    const row = document.createElement('div');
    row.className = 'comp-row';
    row.innerHTML = `
      <span class="comp-label">Similarity to Database</span>
      <div class="comp-bar-bg">
        <div class="comp-bar-fill" style="width:${Math.round(blast.similarity_score * 100)}%;background:${style.color}"></div>
      </div>
      <span class="comp-val">${blast.similarity_score.toFixed(2)}</span>
    `;
    barsEl.appendChild(row);
  }

  interpEl.textContent = blast.interpretation || '';
  card.style.display = 'block';
}

/* 3D structure (ESMFold PDB) — dormant, Phase 5's Structure tab */
function renderStructure(pdbText) {
  const card = document.getElementById('structureCard');
  if (!card) return;
  currentPdb = pdbText || null;

  if (!pdbText) {
    card.style.display = 'none';
    return;
  }

  const container = document.getElementById('structureViewer');
  container.innerHTML = '';

  if (typeof $3Dmol === 'undefined') {
    container.innerHTML = '<div class="trace-empty">3Dmol.js failed to load (check network/CDN access)</div>';
    card.style.display = 'block';
    return;
  }

  structureViewer = $3Dmol.createViewer(container, { backgroundColor: '#000000' });
  structureViewer.addModel(pdbText, 'pdb');
  // Color by pLDDT (stored in the B-factor column by ESMFold), same bands as the badge.
  structureViewer.setStyle({}, {
    cartoon: {
      colorfunc: (atom) => {
        const b = atom.b;
        if (b >= 90) return '#00e5c3';
        if (b >= 70) return '#3b82f6';
        if (b >= 50) return '#fbbf24';
        return '#ef4444';
      },
    },
  });
  structureViewer.zoomTo();
  structureViewer.render();

  card.style.display = 'block';
}

function downloadPdb() {
  if (!currentPdb) return;
  const blob = new Blob([currentPdb], { type: 'chemical/x-pdb' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const seq = document.getElementById('resultSequence')?.textContent.trim();
  a.download = `${seq || 'structure'}.pdb`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* Structural graph analysis — dormant, Phase 5 (if re-enabled) */
function graphScoreStyle(score) {
  if (score >= 3.0) return { color: '#00e5c3', label: 'Highly Structured' };
  if (score >= 1.5) return { color: '#3b82f6', label: 'Moderately Structured' };
  if (score >= 0.5) return { color: '#fbbf24', label: 'Loosely Structured' };
  return { color: '#64748b', label: 'Flexible / Disordered' };
}

function renderGraphFeatures(graph) {
  const card = document.getElementById('graphCard');
  if (!card) return;
  if (!graph || graph.structure_score == null) {
    card.style.display = 'none';
    return;
  }

  const style = graphScoreStyle(graph.structure_score);
  const bar = document.getElementById('graphScoreBar');
  const val = document.getElementById('graphScoreVal');
  bar.style.width = `${Math.min(100, graph.structure_score / 5 * 100)}%`;
  bar.style.background = style.color;
  val.textContent = `${graph.structure_score.toFixed(2)}`;
  val.style.color = style.color;

  const counts = document.getElementById('graphCounts');
  counts.innerHTML = `
    <span>H-bonds: <span class="count-val">${graph.n_hbonds ?? '–'}</span></span>
    <span>Ionic: <span class="count-val">${graph.n_ionic ?? '–'}</span></span>
    <span>Pi-Pi Stacking: <span class="count-val">${graph.n_pi_pi ?? '–'}</span></span>
  `;

  document.getElementById('graphInterp').textContent = graph.interpretation || '';
  card.style.display = 'block';
}

/* Secondary structure (DSSP) — dormant, Phase 5's Structure tab */
const SS_BAR_COLORS = {
  helix_pct: '#00e5c3',
  sheet_pct: '#3b82f6',
  turn_pct: '#fbbf24',
  coil_pct: '#64748b',
};
const SS_BAR_LABELS = {
  helix_pct: 'Alpha Helix',
  sheet_pct: 'Beta Sheet',
  turn_pct: 'Turn',
  coil_pct: 'Coil',
};

function renderDssp(ss) {
  const card = document.getElementById('dsspCard');
  if (!card) return;
  if (!ss) {
    card.style.display = 'none';
    return;
  }

  const ssStringEl = document.getElementById('dsspSsString');
  const barsEl = document.getElementById('dsspBars');
  const simEl = document.getElementById('dsspSimilarity');
  const interpEl = document.getElementById('dsspInterp');
  ssStringEl.innerHTML = '';
  barsEl.innerHTML = '';
  simEl.innerHTML = '';
  interpEl.textContent = '';

  if (!ss.dssp_available) {
    interpEl.textContent = 'DSSP binary not installed on server. Install with: sudo apt-get install dssp';
    card.style.display = 'block';
    return;
  }

  if (ss.error || ss.helix_pct == null) {
    interpEl.textContent = 'Secondary structure: unavailable';
    card.style.display = 'block';
    return;
  }

  ssStringEl.textContent = ss.ss_string || '';

  ['helix_pct', 'sheet_pct', 'turn_pct', 'coil_pct'].forEach(key => {
    const val = ss[key] ?? 0;
    const row = document.createElement('div');
    row.className = 'comp-row';
    row.innerHTML = `
      <span class="comp-label">${SS_BAR_LABELS[key]}</span>
      <div class="comp-bar-bg">
        <div class="comp-bar-fill" style="width:${Math.round(val)}%;background:${SS_BAR_COLORS[key]}"></div>
      </div>
      <span class="comp-val">${val.toFixed(1)}%</span>
    `;
    barsEl.appendChild(row);
  });

  if (ss.ss_similarity) {
    const sim = ss.ss_similarity;
    const simRow = document.createElement('div');
    simRow.className = 'comp-row';
    simRow.innerHTML = `
      <span class="comp-label">SS Similarity vs Ref</span>
      <div class="comp-bar-bg">
        <div class="comp-bar-fill" style="width:${Math.round((sim.overall_ss_similarity ?? 0) * 100)}%"></div>
      </div>
      <span class="comp-val">${(sim.overall_ss_similarity ?? 0).toFixed(3)}</span>
    `;
    simEl.appendChild(simRow);
  }

  interpEl.textContent = ss.interpretation || '';
  card.style.display = 'block';
}

/* 2D residue-interaction graph (D3 force layout) — dormant, Phase 5 (if re-enabled) */
const RESIDUE_COLORS = {
  K: '#3b82f6', R: '#3b82f6', H: '#60a5fa',
  D: '#ef4444', E: '#f87171',
  L: '#00e5c3', I: '#00e5c3', V: '#00e5c3',
  F: '#00e5c3', W: '#00e5c3', M: '#00e5c3',
  A: '#34d399', P: '#34d399',
  S: '#fbbf24', T: '#fbbf24', N: '#fbbf24',
  Q: '#fbbf24', Y: '#f59e0b', C: '#d97706',
  G: '#9ca3af',
};

const EDGE_COLORS = {
  hbond: '#fbbf24',
  ionic: '#3b82f6',
  pi_pi: '#a855f7',
  hydro: '#34d399',
  ca_dist: 'rgba(255,255,255,0.05)',
};

function renderProteinGraph(graphData) {
  const container = document.getElementById('protein-graph-container');
  if (!container) return;
  if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
    container.style.display = 'none';
    return;
  }
  if (typeof d3 === 'undefined') {
    container.style.display = 'none';
    return;
  }

  const svg = d3.select('#protein-graph');
  container.style.display = 'block';
  svg.selectAll('*').remove();

  const width = svg.node().getBoundingClientRect().width || 600;
  const height = 320;
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  const nodes = graphData.nodes.map(n => ({ ...n }));

  const backbone = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    backbone.push({ source: i, target: i + 1, weight: 0.05, type: 'backbone' });
  }

  const edges = [
    ...(graphData.edges.hbonds || []),
    ...(graphData.edges.ionic || []),
    ...(graphData.edges.pi_pi || []),
    ...(graphData.edges.hydro || []),
  ].filter(e => e.weight > 0.005).map(e => ({ ...e }));

  const simulation = d3.forceSimulation(nodes)
    .force('backbone', d3.forceLink(backbone)
      .id(d => d.id)
      .distance(30)
      .strength(0.6))
    .force('interactions', d3.forceLink(edges)
      .id(d => d.id)
      .distance(d => 40 / (d.weight + 0.01))
      .strength(0.3))
    .force('charge', d3.forceManyBody().strength(-80))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide(18))
    .stop();

  const margin = 20;
  for (let i = 0; i < 200; i++) {
    simulation.tick();
    for (const n of nodes) {
      n.x = Math.max(margin, Math.min(width - margin, n.x));
      n.y = Math.max(margin, Math.min(height - margin, n.y));
    }
  }

  svg.append('g').attr('class', 'backbone')
    .selectAll('line')
    .data(backbone)
    .join('line')
    .attr('x1', d => d.source.x)
    .attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x)
    .attr('y2', d => d.target.y)
    .attr('stroke', 'rgba(255,255,255,0.25)')
    .attr('stroke-width', 1.5);

  svg.append('g').attr('class', 'edges')
    .selectAll('line')
    .data(edges)
    .join('line')
    .attr('x1', d => d.source.x)
    .attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x)
    .attr('y2', d => d.target.y)
    .attr('stroke', d => EDGE_COLORS[d.type] || '#ffffff')
    .attr('stroke-width', d => Math.min(d.weight * 20 + 0.5, 2.5))
    .attr('stroke-opacity', 0.6);

  const nodeGroup = svg.append('g').attr('class', 'nodes')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('transform', d => `translate(${d.x},${d.y})`);

  nodeGroup.append('circle')
    .attr('r', 10)
    .attr('fill', d => RESIDUE_COLORS[d.residue] || '#64748b')
    .attr('fill-opacity', 0.85)
    .attr('stroke', 'rgba(255,255,255,0.2)')
    .attr('stroke-width', 1);

  nodeGroup.append('text')
    .attr('class', 'node-label')
    .text(d => d.residue);

  nodeGroup.append('title')
    .text(d => `${d.residue} (pos ${d.id + 1})`);
}

/* PeptideBLEU component bars — dormant, Phase 5's PeptideBLEU tab */
function renderComponents(comp, plddtScore, helixPct) {
  const card = document.getElementById('componentCard');
  const container = document.getElementById('componentScores');
  if (!card || !container) return;
  container.innerHTML = '';

  const order = ['ngram_bleu', 'charge', 'hydrophobicity', 'functional_group',
                  'property_distribution', 'structural', 'blosum'];

  order.forEach(key => {
    const val = comp[key] ?? 0;
    const label = COMPONENT_LABELS[key] || key;
    const pct = Math.round(val * 100);

    const row = document.createElement('div');
    row.className = 'comp-row';
    row.innerHTML = `
      <span class="comp-label">${label}</span>
      <div class="comp-bar-bg">
        <div class="comp-bar-fill" style="width:${pct}%"></div>
      </div>
      <span class="comp-val">${val.toFixed(4)}</span>
    `;
    container.appendChild(row);
  });

  if (plddtScore != null) {
    const row = document.createElement('div');
    row.className = 'comp-row';
    row.innerHTML = `
      <span class="comp-label">pLDDT (ESMFold)</span>
      <div class="comp-bar-bg">
        <div class="comp-bar-fill" style="width:${Math.round(plddtScore)}%"></div>
      </div>
      <span class="comp-val">${plddtScore.toFixed(1)}</span>
    `;
    container.appendChild(row);
  }

  if (helixPct != null) {
    const row = document.createElement('div');
    row.className = 'comp-row';
    row.innerHTML = `
      <span class="comp-label">Helix % (DSSP)</span>
      <div class="comp-bar-bg">
        <div class="comp-bar-fill" style="width:${Math.round(helixPct)}%;background:#00e5c3"></div>
      </div>
      <span class="comp-val">${helixPct.toFixed(1)}%</span>
    `;
    container.appendChild(row);
  }

  card.style.display = 'block';
}

function scoreClass(s) {
  if (s >= 0.35) return 'score-good';
  if (s >= 0.25) return 'score-ok';
  return 'score-bad';
}

/* ── Boot ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
