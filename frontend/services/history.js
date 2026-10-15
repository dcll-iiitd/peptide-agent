/* ── Recent experiments store (Phase 8a extraction, logic from old app.js
   "Recent experiments" section — frontend_phase2_decisions.md Decision 3).
   localStorage for the experiment list itself; IndexedDB for `pdb_string`
   blobs only — see the IndexedDB note below. No DOM here; callers
   re-render their own UI after calling saveExperiment().

   Bug-investigation extension: saveExperiment() used to keep only 6 fields
   (thread_id, sequence, score, activity, timestamp, status) even though
   the harness final event (and GeneratePage.js's normalizeResult() output)
   already carries ~25 richer fields — descriptors, PeptideBLEU components,
   rulebook, pLDDT/structure, novelty, edit_stats, trace_url, pdb_string.
   That's why History's "Open" detail view and Analyze's artifact-retrieval
   path could never show real structure/novelty for a past experiment even
   when the data existed at generation time. saveExperiment()'s `result`
   param now expects a normalizeResult()-shaped object (unified harness/
   legacy field names), not a raw backend/SSE payload — see the call-site
   fix in GeneratePage.js's onFinal handler.

   IndexedDB for pdb_string: a PDB ATOM line is ~80 chars; a 30-residue
   peptide backbone+sidechains is ~240 atom lines (~20KB), a 50-residue one
   ~400 lines (~33KB) — small in absolute terms, but storing ~20-35KB
   string blobs inline in the single `pepforge_experiments` localStorage
   JSON blob means every read/write of the *entire* experiment list
   (including just updating one unrelated field) serializes every stored
   structure every time, and every localStorage.setItem call is
   synchronous and blocks the main thread. Moving pdb_string into
   IndexedDB — a real key-value store keyed by thread_id, written/read
   off the main thread — keeps the localStorage list cheap to read/write
   (now just numbers/short strings/small objects) and lets structure data
   scale past the 50-experiment cap without the whole list getting
   proportionally heavier. The experiment record keeps a `has_pdb`
   boolean so callers can synchronously decide whether to show a loading
   state before awaiting `getPdbString(threadId)`. */
const EXPERIMENTS_KEY = 'pepforge_experiments';
const MAX_EXPERIMENTS = 50; // frontend_phase8a_modular.md services spec (was 20 pre-Phase-8)

const PDB_DB_NAME = 'pepforge_structures';
const PDB_DB_VERSION = 1;
const PDB_STORE = 'pdb_strings';

let dbOpenPromise = null;

// Opens (or returns the cached open handle for) the IndexedDB database.
// Resolves to `null` — never rejects — when IndexedDB isn't available
// (older browsers, privacy modes) so every caller below can fail open
// into "no stored structure" rather than throwing.
function openPdbDb() {
  if (dbOpenPromise) return dbOpenPromise;
  dbOpenPromise = new Promise((resolve) => {
    if (!window.indexedDB) { resolve(null); return; }
    let req;
    try {
      req = indexedDB.open(PDB_DB_NAME, PDB_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PDB_STORE)) {
        req.result.createObjectStore(PDB_STORE, { keyPath: 'thread_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbOpenPromise;
}

// Fire-and-forget write — callers (saveExperiment/deleteExperiment) never
// await this; the localStorage record (with its has_pdb flag) is already
// the synchronous source of truth for "does this experiment have a
// structure," so a slow/failed IndexedDB write only ever delays or skips
// showing the 3D viewer, never corrupts the experiment list itself.
async function putPdbString(threadId, pdbString) {
  if (!threadId || !pdbString) return;
  const db = await openPdbDb();
  if (!db) return;
  try {
    const tx = db.transaction(PDB_STORE, 'readwrite');
    tx.objectStore(PDB_STORE).put({ thread_id: threadId, pdb_string: pdbString });
  } catch { /* storage unavailable mid-write — nothing to recover */ }
}

async function deletePdbString(threadId) {
  if (!threadId) return;
  const db = await openPdbDb();
  if (!db) return;
  try {
    const tx = db.transaction(PDB_STORE, 'readwrite');
    tx.objectStore(PDB_STORE).delete(threadId);
  } catch { /* nothing to recover */ }
}

// Async by nature (IndexedDB has no synchronous read API) — callers
// (HistoryPage's drawer, AnalyzePage's/ComparePage's storage-retrieval
// renders) render their structure section once synchronously first
// (using `has_pdb` to choose a loading vs. "not available" state), then
// call this and re-render when it resolves. Resolves to `null` on any
// failure or absence — never throws, never fabricates a string.
export async function getPdbString(threadId) {
  if (!threadId) return null;
  const db = await openPdbDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PDB_STORE, 'readonly');
      const req = tx.objectStore(PDB_STORE).get(threadId);
      req.onsuccess = () => resolve(req.result ? req.result.pdb_string : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function getExperiments() {
  try {
    return JSON.parse(localStorage.getItem(EXPERIMENTS_KEY)) || [];
  } catch {
    return [];
  }
}

// Writes experiments to localStorage, evicting additional oldest entries
// (beyond the normal MAX_EXPERIMENTS cap) if the write still throws. Now
// that pdb_string lives in IndexedDB, each entry is small (numbers/short
// strings), so a quota hit here would mean something unrelated filled
// the origin's localStorage — still handled defensively rather than
// assumed impossible. Bounded retries so a persistently-too-large single
// entry can't spin forever. Evicted entries' IndexedDB structures are
// cleaned up by the caller (saveExperiment), not here, since this
// function only sees the list, not which entries were dropped.
function writeExperiments(experiments) {
  let list = experiments;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      localStorage.setItem(EXPERIMENTS_KEY, JSON.stringify(list));
      return true;
    } catch {
      if (list.length === 0) return false;
      list = list.slice(1); // drop the oldest and retry
    }
  }
  return false;
}

export function saveExperiment(result, spec) {
  const threadId = result.thread_id || null;
  const hasPdb = !!result.pdb_string;
  const entry = {
    thread_id: threadId,
    timestamp: Date.now(),
    source: result.source || 'generate',
    sequence: result.sequence || '',
    score: result.score != null ? result.score : null,
    activity: (spec && spec.activity) || result.activity || '',
    status: result.status || 'unknown',
    spec: spec
      ? {
          activity: spec.activity || '',
          length_min: spec.length_min,
          length_max: spec.length_max,
          charge_min: spec.charge_min,
          charge_max: spec.charge_max,
          hydro_min: spec.hydro_min,
          hydro_max: spec.hydro_max,
        }
      : null,

    rulebook_score: result.rulebook_score != null ? result.rulebook_score : null,
    rulebook_passed: result.rulebook_passed != null ? result.rulebook_passed : null,
    reference_used: result.reference_used || null,
    components: result.components || null,
    descriptors: result.descriptors || null,
    descriptors_partial: !!result.descriptors_partial,

    iterations: result.iterations != null ? result.iterations : null,
    time_seconds: result.time_seconds != null ? result.time_seconds : null,
    rag_examples_used: result.rag_examples_used != null ? result.rag_examples_used : null,
    rag_sequences: result.rag_sequences || null,
    edit_stats: result.edit_stats || null,
    trace_url: result.trace_url || null,

    plddt_score: result.plddt_score != null ? result.plddt_score : null,
    plddt_confidence: result.plddt_confidence || null,
    plddt_interp: result.plddt_interp || null,
    helix_pct: result.helix_pct != null ? result.helix_pct : null,
    sheet_pct: result.sheet_pct != null ? result.sheet_pct : null,
    coil_pct: result.coil_pct != null ? result.coil_pct : null,
    ss_string: result.ss_string || null,
    // The actual PDB text lives in IndexedDB (see header comment) — this
    // flag is the synchronous signal every renderer checks before
    // deciding whether to await getPdbString(thread_id).
    has_pdb: hasPdb,

    novelty_score: result.novelty_score != null ? result.novelty_score : null,
    closest_match: result.closest_match || null,
    novelty_label: result.novelty_label || null,
    novelty_source: result.novelty_source || null,

    // Analyze-sourced records only — harmless extra keys, nothing
    // enumerates a fixed key list defensively against them.
    diagnostic: result.diagnostic || null,
    explanation: result.explanation || null,
  };

  const experiments = getExperiments();
  experiments.push(entry);
  while (experiments.length > MAX_EXPERIMENTS) {
    const evicted = experiments.shift();
    if (evicted && evicted.thread_id) deletePdbString(evicted.thread_id);
  }
  writeExperiments(experiments);
  if (hasPdb && threadId) putPdbString(threadId, result.pdb_string);
  try { sessionStorage.setItem('pepforge_current_experiment', JSON.stringify(entry)); } catch { /* storage unavailable */ }
  return entry;
}

export function getExperiment(threadId) {
  return getExperiments().find(e => e.thread_id === threadId) || null;
}

// Most recent experiment matching a sequence (sequences are always
// uppercased by both Generate and Analyze before saving/comparing).
export function findBySequence(sequence) {
  if (!sequence) return null;
  const experiments = getExperiments();
  for (let i = experiments.length - 1; i >= 0; i--) {
    if (experiments[i].sequence === sequence) return experiments[i];
  }
  return null;
}

export function deleteExperiment(threadId) {
  const experiments = getExperiments().filter(e => e.thread_id !== threadId);
  writeExperiments(experiments);
  deletePdbString(threadId);
  return experiments;
}
