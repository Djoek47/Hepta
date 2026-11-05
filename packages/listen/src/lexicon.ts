/**
 * Subjects a broadcast debate comes back to, and the words that name them.
 *
 * Words carry weight. An unambiguous word ("housing", "immigration",
 * "unemployment") names its subject on its own. A weak word, marked ~, only
 * counts with company: "getting on with the job" is not a sentence about jobs,
 * and "rent is 1,450" in a budget is not a sentence about housing.
 *
 * A lexicon is a weak instrument and is used as one. Tonight's subject — the
 * debater's stance, the evidence pack — is added at run time and preferred,
 * because it is the subject most worth recognising.
 */
import { stem, words } from './text.js';

export const TOPIC_WORDS: Record<string, string[]> = {
  housing: ['housing', 'houses', 'homes', 'homeless', 'homelessness', 'mortgage', 'mortgages', 'landlord', 'landlords', 'tenant', 'tenants', 'housebuilding', '~home', '~house', '~rent', '~rents', '~build'],
  crime: ['crime', 'crimes', 'police', 'policing', 'offences', 'offenders', 'prison', 'prisons', 'burglary', 'sentencing', '~knife', '~violent'],
  immigration: ['immigration', 'migration', 'migrants', 'migrant', 'asylum', 'visa', 'visas', 'refugees', 'deportation', '~border', '~borders', '~backlog'],
  economy: ['economy', 'economic', 'growth', 'gdp', 'recession', 'unemployment', 'inflation', 'productivity', 'deficit', 'g7', '~growing', '~jobs', '~wages', '~prices', '~debt'],
  taxes: ['tax', 'taxes', 'taxation', 'vat', 'loophole', 'non-dom', 'income tax', 'council tax', '~cuts'],
  health: ['health', 'nhs', 'hospital', 'hospitals', 'nurses', 'patients', 'waiting lists', 'gp', 'gps', 'ambulance', '~doctors', '~doctor', '~nurse', '~waiting', '~care'],
  education: ['school', 'schools', 'teachers', 'classroom', 'class sizes', 'pupils', 'exams', 'exam', 'university', 'students', 'school meals', '~teacher', '~classes', '~children', '~meals'],
  energy: ['energy', 'electricity', 'wholesale', 'standing charges', 'ofgem', 'renewables', 'windfall', 'windfall tax', '~bills', '~gas', '~power', '~nuclear', '~grid'],
  climate: ['climate', 'net zero', 'emissions', 'carbon', 'warming', '~green'],
  transport: ['transport', 'rail', 'railway', 'trains', 'journey times', 'rail line', '~train', '~route', '~roads', '~buses', '~journey', '~line'],
  budget: ['budget', 'savings', 'groceries', 'savings goal', '~saving', '~spend', '~spending', '~afford', '~goal'],
  travel: ['trip', 'travel', 'holiday', 'flight', 'flights', 'lisbon', '~spring'],
  work: ['four-day week', 'four day week', 'working week', '~hours', '~workers', '~firms', '~companies', '~pilot', '~pilots'],
};

export type LexEntry = { topic: string; keys: { key: string; parts: string[]; weight: number }[]; bonus: number };
export type Lexicon = LexEntry[];

/** `extra` words are added to their subject; `prefer` subjects (tonight's) score a little higher. */
export function buildLexicon(extra: Record<string, string[]> = {}, prefer: string[] = []): Lexicon {
  const merged: Record<string, string[]> = { ...TOPIC_WORDS };
  for (const [t, ks] of Object.entries(extra)) merged[t] = [...(merged[t] ?? []), ...ks];
  return Object.entries(merged).map(([topic, keys]) => ({
    topic,
    bonus: prefer.includes(topic) ? 0.5 : 0,
    keys: keys.map((k) => {
      const weak = k.startsWith('~');
      const key = weak ? k.slice(1) : k;
      return { key, parts: words(key).map(stem), weight: weak ? 1 : 2 };
    }),
  }));
}

export type TopicHit = { topic: string; score: number; keys: string[] };

/** Subjects named in a text, best first. A multi-word key counts once; weak words count half. */
export function topicsIn(text: string, lex: Lexicon): TopicHit[] {
  const ws = words(text).map(stem);
  const set = new Set(ws);
  const joined = ` ${ws.join(' ')} `;
  const out: TopicHit[] = [];
  for (const e of lex) {
    const found = new Map<string, number>();
    for (const k of e.keys) {
      if (k.parts.length === 0) continue;
      const hit = k.parts.length === 1 ? set.has(k.parts[0]!) : joined.includes(` ${k.parts.join(' ')} `);
      if (hit) {
        const id = k.parts.join(' ');
        found.set(id, Math.max(found.get(id) ?? 0, k.weight));
      }
    }
    if (found.size === 0) continue;
    // A multi-word key also matches its single words ("council tax" and "tax"): keep the longest.
    for (const id of [...found.keys()]) {
      if (!id.includes(' ')) continue;
      for (const part of id.split(' ')) found.delete(part);
    }
    const score = [...found.values()].reduce((a, b) => a + b, 0) + e.bonus;
    out.push({ topic: e.topic, score, keys: [...found.keys()] });
  }
  return out.sort((a, b) => b.score - a.score);
}
