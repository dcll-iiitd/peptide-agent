/* ── SSE streaming (Phase 8a extraction) ──────────────────────────────────
   The line-split/JSON.parse loop below is moved verbatim from the old
   app.js runGeneration() — untouched per frontend_phase8a_modular.md
   ("No changes to SSE parsing logic — just extraction"). Only the dispatch
   mechanism changed: events are handed to caller-supplied callbacks instead
   of a single inline handleGenerationEvent(). */
import { generate } from './api.js';

export async function streamGenerate(requestBody, isHarness, callbacks) {
  const { onAttempt, onHITL, onFinal, onError, onComplete } = callbacks || {};
  let attemptCount = 0;

  try {
    const response = await generate(requestBody, isHarness);
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
            if (evt.type === 'attempt') {
              attemptCount++;
              onAttempt && onAttempt(evt, attemptCount);
            } else if (evt.type === 'hitl') {
              onHITL && onHITL(evt);
            } else if (evt.type === 'final') {
              onFinal && onFinal(evt);
            } else if (evt.type === 'error') {
              onError && onError(evt);
            }
          } catch { /* skip malformed */ }
        }
      }
    }
  } catch (err) {
    // Network-level failure (fetch rejected, reader threw) — distinct from
    // an in-stream {"type":"error"} SSE event handled above. Flagged via
    // networkError so the caller can show the right user-facing message
    // (see GeneratePage.js's onError, which preserves that distinction
    // exactly as the old single-function app.js did).
    onError && onError({
      networkError: true,
      message: String((err && err.message) || err),
      traceback: String((err && err.stack) || ''),
    });
  } finally {
    onComplete && onComplete();
  }
}
