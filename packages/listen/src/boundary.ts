/**
 * Is the speaker at a clause boundary right now? The only places Hepta may
 * take the floor without being rude: the end of a clause or a breath, never
 * the middle of a phrase.
 *
 * A streaming recognizer knows more than the words: it punctuates, and it
 * times every word. So a boundary is any of
 *   - the end of the utterance
 *   - punctuation the recognizer put at the end of what it has so far
 *   - a joint word at the end ("and", "but", "so" — the ported Lines list)
 *   - silence after the last word longer than a breath
 */
import { BOUNDARY } from '@intermenu/hepta/lines';
import { words } from './text.js';
import type { SttChunk } from './types.js';

export const BREATH_MS = 350;

export function atBoundary(chunk: SttChunk, breathMs = BREATH_MS): boolean {
  if (chunk.final) return true;
  const t = chunk.text.trim();
  if (!t) return false;
  if (/[,.;:!?—–]$/.test(t)) return true;
  const last = words(t).pop();
  if (last && BOUNDARY.has(last)) return true;
  const w = chunk.words[chunk.words.length - 1];
  return !!w && chunk.heardToMs - w.endMs >= breathMs;
}
