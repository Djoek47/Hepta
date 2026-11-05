/**
 * Subjects a broadcast debate comes back to, and the words that name them.
 *
 * A lexicon is a weak instrument and is used as one: it names a subject when
 * the words are unambiguous, and otherwise the subject is the utterance's own
 * content words. An evidence pack or a seeded stance adds its keys at run time,
 * because the subject of tonight's debate is the one most worth recognising.
 */
import { stem, words } from './text.js';

export const TOPIC_WORDS: Record<string, string[]> = {
  housing: ['housing', 'house', 'houses', 'homes', 'home', 'homeless', 'homelessness', 'rent', 'rents', 'renters', 'mortgage', 'landlord', 'landlords', 'tenant', 'tenants', 'housebuilding'],
  crime: ['crime', 'crimes', 'police', 'policing', 'offences', 'offenders', 'prison', 'prisons', 'knife', 'burglary', 'sentencing', 'violent'],
  immigration: ['immigration', 'migration', 'migrants', 'migrant', 'asylum', 'border', 'borders', 'visa', 'visas', 'refugees', 'deportation', 'backlog'],
  economy: ['economy', 'economic', 'growth', 'growing', 'gdp', 'recession', 'unemployment', 'jobs', 'wages', 'inflation', 'prices', 'productivity', 'deficit', 'debt', 'g7'],
  taxes: ['tax', 'taxes', 'taxation', 'vat', 'loophole', 'non-dom', 'windfall', 'council tax'],
  health: ['health', 'nhs', 'hospital', 'hospitals', 'doctors', 'doctor', 'nurses', 'nurse', 'patients', 'waiting', 'waiting lists', 'gp', 'gps', 'ambulance', 'care', 'strike', 'strikes', 'union'],
  education: ['school', 'schools', 'teachers', 'teacher', 'classroom', 'classes', 'class sizes', 'pupils', 'children', 'exams', 'exam', 'university', 'students', 'meals', 'school meals'],
  energy: ['energy', 'bills', 'gas', 'electricity', 'wholesale', 'standing charges', 'power', 'ofgem', 'renewables', 'nuclear', 'grid'],
  climate: ['climate', 'net zero', 'emissions', 'carbon', 'warming', 'green'],
  transport: ['transport', 'rail', 'railway', 'trains', 'train', 'route', 'roads', 'buses', 'journey', 'journey times', 'line'],
  budget: ['budget', 'savings', 'saving', 'groceries', 'spend', 'spending', 'afford', 'goal'],
  travel: ['trip', 'travel', 'holiday', 'flight', 'flights', 'lisbon', 'spring'],
  work: ['four-day week', 'four day week', 'working week', 'hours', 'workers', 'firms', 'companies', 'pilot', 'pilots'],
};

export type Lexicon = { topic: string; keys: string[]; stems: string[][] }[];

export function buildLexicon(extra: Record<string, string[]> = {}): Lexicon {
  const merged: Record<string, string[]> = { ...TOPIC_WORDS };
  for (const [t, ks] of Object.entries(extra)) merged[t] = [...(merged[t] ?? []), ...ks];
  return Object.entries(merged).map(([topic, keys]) => ({
    topic, keys, stems: keys.map((k) => words(k).map(stem)),
  }));
}

/** Topics named in a text, best first, with how many of their words appeared. */
export function topicsIn(text: string, lex: Lexicon): { topic: string; hits: number; keys: string[] }[] {
  const ws = words(text).map(stem);
  const set = new Set(ws);
  const out: { topic: string; hits: number; keys: string[] }[] = [];
  for (const e of lex) {
    const found: string[] = [];
    e.stems.forEach((parts, i) => {
      if (parts.length === 0) return;
      if (parts.length === 1 ? set.has(parts[0]!) : ws.join(' ').includes(parts.join(' '))) found.push(e.keys[i]!);
    });
    // A multi-word key ("waiting lists") counts once, not once per word.
    const distinct = new Set(found.map((k) => words(k).map(stem).join(' ')));
    if (distinct.size > 0) out.push({ topic: e.topic, hits: distinct.size, keys: [...distinct] });
  }
  return out.sort((a, b) => b.hits - a.hits);
}
