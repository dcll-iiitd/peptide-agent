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
let attemptHistory = [];         // all attempt events for the active run (Trace tab)
let currentResult = null;        // last normalize Result() output (tab renderers + residue inspection)

const AA_NAMES = {
  A: 'Alanine', R: 'Arginine', N: 'Asparagine', D: 'Aspartate', C: 'Cysteine',
  E: 'Glutamate', Q: 'Glutamine', G: 'Glycine', H: 'Histidine', I: 'Isoleucine',
  L: 'Leucine', K: 'Lysine', M: 'Methionine', F: 'Phenylalanine', P: 'Proline',
  S: 'Serine', T: 'Threonine', W: 'Tryptophan', Y: 'Tyrosine', V: 'Valine',
};

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
  if (view === 'history') renderHistoryView();
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
  document.getElementById('resultTabsCard').style.display = 'none';
  document.querySelector('.view-placeholder-template')?.remove();
  hideHitlPanel();
  currentSpec = null;
  currentResult = null;
  attemptHistory = [];
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
  navigateTo('history');
  const experiments = loadExperiments();
  const index = experiments.findIndex(e => e.thread_id === threadId);
  if (index >= 0) showHistoryDetail(index);
}

/* ── History view (Phase 7) ────────────────────────────────────────────────
   Only a thin per-run summary is ever persisted (Decision 3's
   {thread_id, sequence, score, activity, timestamp, status}) — there is no
   stored PDB/components/trace, so "detail" here is honestly limited to
   that summary, not a full tabbed result restore. */
function renderHistoryView() {
  const el = document.getElementById('view-history');
  const experiments = loadExperiments();
  if (experiments.length === 0) {
    el.innerHTML = `<div class="view-placeholder"><h2>🕘 History</h2><p>No experiments yet. Generate your first peptide.</p></div>`;
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

function showHistoryDetail(index) {
  const experiments = loadExperiments();
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

/* ── Client-side input validation (Phase 7) ───────────────────────────────
   Mirrors harness/guardrails.py's input_guardrail() rules exactly, so a
   malformed spec shows the specific violation message immediately rather
   than round-tripping to the backend — which currently has no way to
   surface that message anyway (input_guardrail's "error" string never
   reaches the SSE final event; adding it would mean touching
   harness/sse_bridge.py, out of scope for this frontend-only phase). */
function validateSpecClientSide(spec) {
  const errors = [];
  if (spec.activity && !ALL_ACTIVITIES.includes(spec.activity)) {
    errors.push(`activity '${spec.activity}' is not one of the 13 valid classes`);
  }
  if (!(spec.length_min < spec.length_max)) errors.push(`length_min (${spec.length_min}) must be < length_max (${spec.length_max})`);
  if (!(spec.charge_min <= spec.charge_max)) errors.push(`charge_min (${spec.charge_min}) must be <= charge_max (${spec.charge_max})`);
  if (!(spec.hydro_min < spec.hydro_max)) errors.push(`hydro_min (${spec.hydro_min}) must be < hydro_max (${spec.hydro_max})`);
  if (!(spec.length_min >= 1)) errors.push(`length_min (${spec.length_min}) must be >= 1`);
  if (!(spec.length_max <= 200)) errors.push(`length_max (${spec.length_max}) must be <= 200`);
  if (!(spec.charge_min >= -20)) errors.push(`charge_min (${spec.charge_min}) must be >= -20`);
  if (!(spec.charge_max <= 20)) errors.push(`charge_max (${spec.charge_max}) must be <= 20`);
  if (!(spec.hydro_min >= 0)) errors.push(`hydro_min (${spec.hydro_min}) must be >= 0`);
  if (!(spec.hydro_max <= 100)) errors.push(`hydro_max (${spec.hydro_max}) must be <= 100`);
  if (!(spec.threshold >= 0.0 && spec.threshold <= 1.0)) errors.push(`threshold (${spec.threshold}) must be between 0.0 and 1.0`);
  if (!(spec.max_retries >= 1 && spec.max_retries <= 10)) errors.push(`max_retries (${spec.max_retries}) must be between 1 and 10`);
  return errors;
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

  const violations = validateSpecClientSide(spec);
  if (violations.length > 0) {
    openAdvancedPanel();
    alert('Please fix the following before generating:\n\n' + violations.join('\n'));
    return;
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
  document.getElementById('resultTabsCard').style.display = 'none';
  document.getElementById('errorCard').style.display = 'none';
  hideHitlPanel();
  attemptHistory = [];
  currentResult = null;
  document.getElementById('progressHeader').style.display = 'flex';
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
    document.getElementById('progressHeader').style.display = 'none';
    setStepState(lastRunningStepKey || 'input_guardrail', 'failed');
    showErrorCard('Could not reach the PepForge server. Make sure the backend is running.', {
      technical: String((err && err.stack) || err),
      retry: true,
    });
  } finally {
    isGenerating = false;
  }
}

function handleGenerationEvent(evt, attemptCount) {
  if (evt.type === 'attempt') {
    attemptCount++;
    attemptHistory.push(evt);
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
    document.getElementById('progressHeader').style.display = 'none';
    setStepState('refinement', 'completed');
    setStepState('post_hoc', 'completed');
    setStepState('output_guardrail', 'completed');
    showBestCandidate(evt.result);
    recordExperiment(evt.result, currentSpec);
  } else if (evt.type === 'error') {
    // The overwhelmingly common real-world cause of a harness "error" SSE
    // event in this project is the LLM gateway tunnel dying mid-run (see
    // CLAUDE.md's failure-modes table) — using that as the primary
    // user-facing message rather than the raw exception, which goes under
    // "Technical details" instead (never shown raw in the primary UI).
    document.getElementById('progressHeader').style.display = 'none';
    setStepState(lastRunningStepKey || 'generation', 'failed');
    showErrorCard('PepForge could not reach the model. Your experiment settings are preserved.', {
      technical: `${evt.message || ''}\n\n${evt.traceback || ''}`.trim(),
      retry: true,
    });
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

/* ── Result normalization (Phase 5) ───────────────────────────────────────
   Legacy and harness final events have genuinely different shapes
   (frontend/AUDIT.md Q17-19, Decisions 2/7/8/9) — legacy nests
   secondary_structure/blast_similarity dicts and names the PDB field
   "plddt_pdb"; harness has flat sheet_pct/coil_pct/ss_string/pdb_string
   fields and a possibly-partial `descriptors` (full on harness, rulebook-
   derived partial on legacy, per Decision 9). This normalizes both into one
   shape so the tab renderers below never branch on which path produced
   the result. */
function normalizeResult(result) {
  const ss = result.secondary_structure || null;      // legacy only
  const blast = result.blast_similarity || null;       // legacy only

  let descriptors = result.descriptors || null;        // harness, Decision 9
  let descriptorsPartial = false;
  if (!descriptors && result.rulebook) {
    descriptors = {
      length: result.rulebook.length,
      net_charge: result.rulebook.net_charge,
      hydro_pct: result.rulebook.hydro_percent ?? result.rulebook.hydrophobicity,
      charge_class: result.rulebook.charge_class,
      length_class: result.rulebook.length_class,
      gravy: null, aromaticity: null, mol_weight: null,
    };
    descriptorsPartial = true;
  }

  return {
    sequence: result.sequence || '',
    score: result.score,
    rulebook_score: result.rulebook_score,
    reference_used: result.reference_used,
    components: result.components || {},
    iterations: result.iterations,
    time_seconds: result.time_seconds,
    rag_examples_used: result.rag_examples_used,
    rag_sequences: result.rag_sequences || [],
    status: result.status,
    thread_id: result.thread_id,
    edit_stats: result.edit_stats || {},
    trace_url: result.trace_url || null,

    descriptors,
    descriptors_partial: descriptorsPartial,

    plddt_score: result.plddt_score,
    plddt_confidence: result.plddt_confidence || null,
    plddt_interp: result.plddt_interp || null,
    pdb_string: result.plddt_pdb || result.pdb_string || null,

    helix_pct: ss ? ss.helix_pct : result.helix_pct,
    sheet_pct: ss ? ss.sheet_pct : result.sheet_pct,
    coil_pct: ss ? ss.coil_pct : result.coil_pct,
    ss_string: ss ? ss.ss_string : result.ss_string,
    dssp_available: ss ? ss.dssp_available : (result.helix_pct != null),
    dssp_interp: ss ? ss.interpretation : null,

    novelty_score: blast ? blast.similarity_score : result.novelty_score,
    novelty_label: blast ? blast.novelty_label : result.novelty_label,
    novelty_interp: blast ? blast.interpretation : null,
    novelty_available: blast ? !!blast.blast_available : (result.novelty_score != null),
    closest_match: result.closest_match || null,

    activity: (currentSpec && currentSpec.activity) || '',
  };
}

/* ── Best candidate hero card + result tabs (Phase 5) ─────────────────────── */
function showBestCandidate(result) {
  const r = normalizeResult(result);
  currentResult = r;

  const seqEl = document.getElementById('resultSequence');
  seqEl.textContent = r.sequence || 'No sequence generated';
  const displayScore = r.score != null ? r.score : r.rulebook_score;
  seqEl.className = 'result-sequence' + (displayScore != null ? ' ' + scoreClass(displayScore) : '');

  const lengthAa = (r.descriptors && r.descriptors.length != null) ? r.descriptors.length : r.sequence.length;
  document.getElementById('heroSubtitle').textContent =
    `${lengthAa} amino acids${r.activity ? ' · ' + r.activity : ''}`;
  document.getElementById('heroMetrics').innerHTML = renderHeroMetricsHtml(r);
  renderTraceLink(r.trace_url);

  renderOverviewTab(r);
  renderPropertiesTab(r);
  renderPeptideBleuTab(r);
  renderStructureTab(r);
  renderNoveltyTab(r);
  renderTraceTab(r);

  switchResultTab('overview');
  document.getElementById('bestCandidateCard').style.display = 'block';
  document.getElementById('resultTabsCard').style.display = 'block';
}

function renderHeroMetricsHtml(r) {
  const rows = [];
  if (r.score != null) {
    rows.push(`<div class="hero-metric-row"><span class="hero-metric-label">PeptideBLEU</span>
      <div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${Math.round(r.score * 100)}%"></div></div>
      <span class="hero-metric-val">${r.score.toFixed(4)}</span></div>`);
  }
  rows.push(`<div class="hero-metric-row"><span class="hero-metric-label">Rulebook</span>
    <span class="hero-metric-val">${r.status === 'complete' ? '✓ Passed' : '○ ' + (r.status || 'unknown')}</span></div>`);
  if (r.novelty_available && r.novelty_label) {
    rows.push(`<div class="hero-metric-row"><span class="hero-metric-label">Novelty</span>
      <span class="hero-metric-val">${r.novelty_label === 'novel' ? '✓ Novel' : r.novelty_label}</span></div>`);
  }
  if (r.plddt_score != null) {
    rows.push(`<div class="hero-metric-row"><span class="hero-metric-label">pLDDT</span>
      <span class="hero-metric-val">${r.plddt_score.toFixed(1)}${r.plddt_confidence ? ' (' + r.plddt_confidence + ')' : ''}</span></div>`);
  }
  return rows.join('');
}

function refineCandidate() {
  const spec = currentSpec;
  const seq = currentResult && currentResult.sequence;
  if (!spec) return;
  newExperiment();
  openAdvancedPanel();
  document.getElementById('advLenMin').value = spec.length_min;
  document.getElementById('advLenMax').value = spec.length_max;
  document.getElementById('advChargeMin').value = spec.charge_min;
  document.getElementById('advChargeMax').value = spec.charge_max;
  document.getElementById('advHydroMin').value = spec.hydro_min;
  document.getElementById('advHydroMax').value = spec.hydro_max;
  document.getElementById('advActivity').value = spec.activity || '';
  if (seq) document.getElementById('genInput').value = `Refine this candidate: ${seq}`;
}

/* ── Result tabs (Phase 5) ────────────────────────────────────────────────── */
function switchResultTab(tab) {
  document.querySelectorAll('.result-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.result-tab-panel').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
}

function renderOverviewTab(r) {
  document.getElementById('tabOverview').innerHTML = `
    <div class="overview-grid">
      <div class="spec-row"><span class="spec-label">Activity</span><span class="spec-value">${r.activity || '(general)'}</span></div>
      <div class="spec-row"><span class="spec-label">Length</span><span class="spec-value">${(r.descriptors && r.descriptors.length != null) ? r.descriptors.length : r.sequence.length} aa</span></div>
      <div class="spec-row"><span class="spec-label">Rulebook</span><span class="spec-value">${r.status === 'complete' ? '✓ Passed' : '○ ' + (r.status || 'unknown')}</span></div>
      <div class="spec-row"><span class="spec-label">PeptideBLEU</span><span class="spec-value">${r.score != null ? r.score.toFixed(4) : '–'}</span></div>
      <div class="spec-row"><span class="spec-label">Iterations</span><span class="spec-value">${r.iterations ?? '–'}</span></div>
      <div class="spec-row"><span class="spec-label">Time</span><span class="spec-value">${r.time_seconds != null ? r.time_seconds.toFixed(1) + 's' : '–'}</span></div>
    </div>
    <div class="overview-structure-summary">
      ${r.pdb_string
        ? `ESMFold pLDDT ${r.plddt_score != null ? r.plddt_score.toFixed(1) : '–'} · <a href="#" onclick="switchResultTab('structure');return false;">View 3D Structure →</a>`
        : `<span class="text-muted">Structural analysis unavailable. The peptide result is still complete.</span>`}
    </div>
  `;
}

function renderPropertiesTab(r) {
  const d = r.descriptors;
  const el = document.getElementById('tabProperties');
  if (!d) {
    el.innerHTML = `<p class="text-muted">Descriptor analysis unavailable.</p>`;
    return;
  }
  const row = (label, val) => `<div class="spec-row"><span class="spec-label">${label}</span><span class="spec-value">${val}</span></div>`;
  el.innerHTML = `
    <div class="tab-section-label">SEQUENCE / PHYSICOCHEMICAL PROPERTIES</div>
    <div class="spec-grid">
      ${row('Length', d.length != null ? d.length + ' AA' : '–')}
      ${row('Net charge', d.net_charge != null ? fmtCharge(d.net_charge) : '–')}
      ${row('Hydrophobicity', d.hydro_pct != null ? d.hydro_pct + '%' : '–')}
      ${row('GRAVY', d.gravy != null ? d.gravy : 'Not available (standard mode)')}
      ${row('Aromaticity', d.aromaticity != null ? (d.aromaticity * 100).toFixed(1) + '%' : 'Not available (standard mode)')}
      ${row('Mol. weight', d.mol_weight != null ? d.mol_weight + ' Da' : 'Not available (standard mode)')}
      ${row('Charge class', d.charge_class || '–')}
      ${row('Length class', d.length_class || '–')}
    </div>
    ${r.descriptors_partial ? '<p class="tab-hint">Full descriptor analysis available in harness mode.</p>' : ''}
  `;
}

function renderPeptideBleuTab(r) {
  const el = document.getElementById('tabPeptidebleu');
  const comp = r.components || {};
  if (Object.keys(comp).length === 0) {
    el.innerHTML = `<p class="text-muted">${r.reference_used ? 'No component breakdown available.' : 'No reference — PeptideBLEU not computed.'}</p>`;
    return;
  }
  const order = ['ngram_bleu', 'charge', 'hydrophobicity', 'functional_group', 'property_distribution', 'structural', 'blosum'];
  const bars = order.map(k => {
    const val = comp[k] ?? 0;
    return `
      <div class="comp-row">
        <span class="comp-label">${COMPONENT_LABELS[k] || k}</span>
        <div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${Math.round(val * 100)}%"></div></div>
        <span class="comp-val">${val.toFixed(4)}</span>
      </div>`;
  }).join('');
  el.innerHTML = `
    <div class="bleu-overall">Overall score <span class="bleu-overall-val">${r.score != null ? r.score.toFixed(4) : '–'}</span></div>
    <div class="component-scores">${bars}</div>
  `;
}

function renderSsBarsHtml(r) {
  if (!r.dssp_available || r.helix_pct == null) {
    return `<p class="text-muted">Predicted secondary structure not available.</p>`;
  }
  const bar = (key, val) => `
    <div class="comp-row">
      <span class="comp-label">${SS_BAR_LABELS[key]}</span>
      <div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${Math.round(val || 0)}%;background:${SS_BAR_COLORS[key]}"></div></div>
      <span class="comp-val">${(val ?? 0).toFixed(1)}%</span>
    </div>`;
  return bar('helix_pct', r.helix_pct) + bar('sheet_pct', r.sheet_pct) + bar('coil_pct', r.coil_pct);
}

function renderResidueStripHtml(r) {
  if (!r.ss_string) return `<p class="text-muted">Per-residue structure not available.</p>`;
  const seq = r.sequence || '';
  return r.ss_string.split('').map((c, i) => {
    // pydssp 3-state codes, verified against backend/dssp_scorer.py: 'H' =
    // helix, 'E' = sheet, everything else (incl. '-') = coil.
    const cls = c === 'H' ? 'residue-helix' : c === 'E' ? 'residue-sheet' : 'residue-coil';
    const aa = seq[i] || '?';
    return `<span class="residue-chip ${cls}" onclick="inspectResidue(${i})">${aa}</span>`;
  }).join('');
}

function renderStructureTab(r) {
  const el = document.getElementById('tabStructure');
  if (!r.pdb_string) {
    el.innerHTML = `<p class="text-muted">${r.plddt_interp || 'Structural analysis unavailable. The peptide result is still complete.'}</p>`;
    return;
  }

  el.innerHTML = `
    <div class="structure-layout">
      <div class="structure-viewer-col">
        <div class="structure-viewer" id="structureViewer"></div>
        <div class="structure-viewer-actions">
          <button class="btn-chip" onclick="resetStructureView()">Reset</button>
          <button class="btn-chip" onclick="downloadPdb()">Download PDB</button>
        </div>
      </div>
      <div class="structure-info-col">
        <div class="tab-section-label">STRUCTURAL CONFIDENCE</div>
        <div class="spec-row"><span class="spec-label">ESMFold pLDDT</span><span class="spec-value">${r.plddt_score != null ? r.plddt_score.toFixed(1) : '–'}</span></div>
        <div class="spec-row"><span class="spec-label">Confidence</span><span class="spec-value">${r.plddt_confidence || '–'}</span></div>
        <div class="tab-section-label" style="margin-top:14px">PREDICTED SECONDARY STRUCTURE (DSSP)</div>
        ${renderSsBarsHtml(r)}
      </div>
    </div>
    <div class="tab-section-label" style="margin-top:16px">RESIDUE INSPECTION</div>
    <div id="residueStrip" class="residue-strip">${renderResidueStripHtml(r)}</div>
    <div id="residueInfo" class="residue-info">Select a residue above to inspect it.</div>
  `;

  renderStructureViewer(r.pdb_string);
}

function renderStructureViewer(pdbText) {
  currentPdb = pdbText || null;
  const container = document.getElementById('structureViewer');
  if (!container) return;
  container.innerHTML = '';

  if (typeof $3Dmol === 'undefined') {
    container.innerHTML = '<div class="trace-empty">3Dmol.js failed to load (check network/CDN access)</div>';
    return;
  }

  structureViewer = $3Dmol.createViewer(container, { backgroundColor: '#000000' });
  structureViewer.addModel(pdbText, 'pdb');
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
}

function resetStructureView() {
  if (!structureViewer) return;
  structureViewer.zoomTo();
  structureViewer.render();
}

function inspectResidue(index) {
  const r = currentResult;
  const info = document.getElementById('residueInfo');
  if (!r || !info) return;
  const aa = (r.sequence || '')[index] || '?';
  const code = r.ss_string ? r.ss_string[index] : null;
  const ssLabel = code === 'H' ? 'Helix' : code === 'E' ? 'Sheet' : code ? 'Coil' : 'Not available';
  info.innerHTML = `
    <div class="spec-row"><span class="spec-label">Residue</span><span class="spec-value">${index + 1}</span></div>
    <div class="spec-row"><span class="spec-label">Amino acid</span><span class="spec-value">${aa} — ${AA_NAMES[aa] || 'Not available'}</span></div>
    <div class="spec-row"><span class="spec-label">Secondary structure</span><span class="spec-value">${ssLabel}</span></div>
    <div class="spec-row"><span class="spec-label">PDB chain</span><span class="spec-value">A:${index + 1}</span></div>
  `;
}

function renderNoveltyTab(r) {
  const el = document.getElementById('tabNovelty');
  if (!r.novelty_available || r.novelty_score == null) {
    el.innerHTML = `<p class="text-muted">${r.novelty_interp || 'Novelty check unavailable. BLAST database may not be configured.'}</p>`;
    return;
  }
  const style = NOVELTY_COLORS[r.novelty_label] || NOVELTY_COLORS.unknown;
  el.innerHTML = `
    <div class="novelty-badge-row"><span class="novelty-label" style="color:${style.color}">${style.label}</span></div>
    <div class="comp-row">
      <span class="comp-label">Similarity score</span>
      <div class="comp-bar-bg"><div class="comp-bar-fill" style="width:${Math.round(r.novelty_score * 100)}%;background:${style.color}"></div></div>
      <span class="comp-val">${r.novelty_score.toFixed(2)}</span>
    </div>
    ${r.closest_match ? `<div class="spec-row"><span class="spec-label">Closest match</span><span class="spec-value">${r.closest_match}</span></div>` : ''}
    <div class="spec-row"><span class="spec-label">Database</span><span class="spec-value">BLAST (IIIT-D 105K)</span></div>
    <p class="tab-hint">${r.novelty_interp || ''}</p>
  `;
}

function renderTraceTab(r) {
  const el = document.getElementById('tabTrace');
  let html = '';

  if (r.trace_url) {
    html += `<p style="margin-bottom:12px"><a href="${r.trace_url}" target="_blank" rel="noopener" class="trace-link" style="margin-left:0">View full LangSmith trace →</a></p>`;
  }

  html += '<div class="tab-section-label">ATTEMPT HISTORY</div>';
  if (attemptHistory.length === 0) {
    html += '<p class="text-muted">No attempt history recorded.</p>';
  } else {
    html += '<div class="trace-list">' + attemptHistory.map(a => {
      const seqPreview = a.sequence ? (a.sequence.length > 24 ? a.sequence.slice(0, 24) + '…' : a.sequence) : '—';
      const editHtml = a.edit_op
        ? `<span class="edit-op-detail">Edit: pos ${a.edit_op.position} ${a.edit_op.from_aa || '∅'}→${a.edit_op.to_aa || '∅'} (${a.edit_op.reason})</span>`
        : '';
      return `<div class="trace-row ${a.passed ? 'pass' : (a.sequence ? 'fail' : 'error')}">
        <span class="trace-status">${a.passed ? '✓' : '✗'}</span>
        Attempt ${a.n}: ${seqPreview} | BLEU ${a.score != null ? a.score.toFixed(4) : '–'}
        ${editHtml}
      </div>`;
    }).join('') + '</div>';
  }

  const lastViolations = attemptHistory.length ? attemptHistory[attemptHistory.length - 1].violations : null;
  html += '<div class="tab-section-label" style="margin-top:14px">DIAGNOSTIC VIOLATIONS</div>';
  if (lastViolations && lastViolations.length) {
    html += '<div class="violations-list">' + lastViolations.map(v => `
      <div class="violation-row">
        <span class="violation-rule">${v.rule}</span>
        <span class="violation-detail">current: ${v.current} → target: ${v.target} (excess ${v.excess})</span>
        <span class="violation-fix">${v.fix}</span>
        ${v.positions && v.positions.length ? `<span class="violation-detail">positions: ${v.positions.join(', ')}</span>` : ''}
      </div>`).join('') + '</div>';
  } else {
    html += '<p class="text-muted">No violations on the final candidate.</p>';
  }

  html += '<div class="tab-section-label" style="margin-top:14px">EDIT STATISTICS</div>';
  const stats = r.edit_stats || {};
  if (Object.keys(stats).length === 0) {
    html += '<p class="text-muted">No edits were needed.</p>';
  } else {
    html += '<div class="component-scores">' + Object.entries(stats).map(([op, s]) => {
      const deltaStr = s.avg_delta >= 0 ? `+${s.avg_delta.toFixed(4)}` : s.avg_delta.toFixed(4);
      return `<div class="comp-row"><span class="comp-label">${op}</span><span class="comp-val" style="width:auto">${s.count} used · ${s.improvements} improved · avg Δ ${deltaStr}</span></div>`;
    }).join('') + '</div>';
  }

  el.innerHTML = html;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function showErrorCard(message, options) {
  const { technical, retry } = options || {};
  let html = `<p>${escapeHtml(message)}</p>`;
  if (retry) {
    html += `<button class="btn-chip" style="margin-top:10px" onclick="retryGeneration()">Retry</button>`;
  }
  if (technical) {
    html += `<details class="error-technical"><summary>Technical details ▾</summary><pre>${escapeHtml(technical)}</pre></details>`;
  }
  document.getElementById('errorMessage').innerHTML = html;
  document.getElementById('errorCard').style.display = 'block';
}

function retryGeneration() {
  if (!currentSpec || isGenerating) return;
  document.getElementById('errorCard').style.display = 'none';
  runGeneration(currentSpec);
}

function copySequence() {
  const seq = document.getElementById('resultSequence').textContent.trim();
  if (!seq) return;
  navigator.clipboard?.writeText(seq).catch(() => {});
}

function exportFasta() {
  const seq = document.getElementById('resultSequence').textContent.trim();
  if (!seq) return;
  const activity = (currentResult && currentResult.activity) || 'unspecified';
  const scoreStr = (currentResult && currentResult.score != null) ? currentResult.score.toFixed(4) : 'NA';
  const fasta = `>PepForge_Candidate_1 | ${activity} | PeptideBLEU=${scoreStr}\n${seq}\n`;
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

/* ── LangSmith trace link (actively used by showBestCandidate) ───────────── */
function renderTraceLink(url) {
  const link = document.getElementById('traceLink');
  if (!link) return;
  if (!url) { link.style.display = 'none'; return; }
  link.href = url;
  link.style.display = 'inline-block';
}

/* BLAST novelty assessment — colors reused by renderNoveltyTab (Phase 5) */
const NOVELTY_COLORS = {
  novel:          { color: '#00e5c3', label: 'Novel' },
  low_similarity: { color: '#34d399', label: 'Mostly Novel' },
  similar:        { color: '#fbbf24', label: 'Similar' },
  known:          { color: '#ef4444', label: 'Known' },
  unknown:        { color: '#64748b', label: 'N/A' },
};

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

/* Secondary structure (DSSP) — colors/labels reused by renderSsBarsHtml (Phase 5) */
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

function scoreClass(s) {
  if (s >= 0.35) return 'score-good';
  if (s >= 0.25) return 'score-ok';
  return 'score-bad';
}

/* ── Boot ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
