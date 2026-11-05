/**
 * Text normalization and token matching.
 *
 * Everything here runs on device with no network. It is tier 0 of resolution
 * and the reason the app still works when every model is unreachable.
 */

export type Token = { raw: string; norm: string; start: number; end: number };

const PUNCT = /[.,!?;:'"`()[\]{}<>/\\|@#$%^&*_+=~]/g;

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics: "Amélie" matches "amelie"
    .toLowerCase()
    .replace(PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokenize while keeping offsets into the ORIGINAL string, for span arbitration. */
export function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  const re = /[^\s.,!?;:'"`()[\]{}<>/\\|@#$%^&*_+=~]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const raw = m[0];
    const norm = normalize(raw);
    if (norm) tokens.push({ raw, norm, start: m.index, end: m.index + raw.length });
  }
  return tokens;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** 1 for identical, 0 for unrelated. STT name errors ("Drako"/"Draco") land ~0.8. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

/** Below this, a token pair is treated as unrelated rather than a near miss. */
export const TOKEN_FLOOR = 0.72;

export type WindowMatch = { score: number; span: [number, number] };

/**
 * Best contiguous window of `haystack` matching the whole `needle` phrase.
 * Multi-token needles must match in order, which is what keeps "pharmacy run"
 * from matching a stray "run".
 */
export function matchPhrase(haystack: Token[], needle: string): WindowMatch | null {
  const parts = normalize(needle).split(' ').filter(Boolean);
  if (parts.length === 0 || haystack.length < parts.length) return null;

  let best: WindowMatch | null = null;
  for (let i = 0; i + parts.length <= haystack.length; i++) {
    let total = 0;
    for (let j = 0; j < parts.length; j++) {
      const s = similarity(haystack[i + j]!.norm, parts[j]!);
      total += s >= TOKEN_FLOOR ? s : 0;
    }
    const score = total / parts.length;
    if (score > 0 && (!best || score > best.score)) {
      best = { score, span: [haystack[i]!.start, haystack[i + parts.length - 1]!.end] };
    }
  }
  return best;
}
