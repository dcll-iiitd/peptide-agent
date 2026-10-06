/* ── Slash command wrapper (Phase 8a extraction) ─────────────────────────── */
import { command } from './api.js';

export function parseSlashCommand(text) {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  return { cmd, args, text: trimmed };
}

export async function slash(text, threadId) {
  return command(text, threadId);
}
