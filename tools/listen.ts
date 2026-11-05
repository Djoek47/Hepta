/**
 * Listen from the terminal.
 *
 *   npm run listen -- --file debate.mp4 [--stt deepgram|assemblyai] [--mode panel] [--backend heuristic|jev-haiku]
 *                     [--speed 1] [--names "S1=Moderator:moderator,S2=Minister"]
 *   npm run listen -- --clip 01 [--speed 4]
 *
 * A file is decoded to 16 kHz PCM (WAV natively, anything else through ffmpeg)
 * and sent to the recognizer at broadcast speed. A clip is a scripted bench
 * clip played through the simulated recognizer, no keys needed. Every final
 * utterance prints with what Hepta made of it; the session is saved as JSON.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assemblyai, claudeClient, clock, decodeAudio, deepgram, HAIKU, haikuTransport, HeuristicDetector, JevDetector, type JevDecision,
  Listener, pace, scriptedProvider, type Clip, type Mode, type SpeakerRole, type SttProvider,
} from '@hepta/listen';

loadEnv('.env');
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

const file = arg('--file');
const clipId = arg('--clip');
if (!file && !clipId) { console.error('usage: npm run listen -- --file <audio> | --clip <id>'); process.exit(2); }
const speed = Number(arg('--speed') ?? 1);

let clip: Clip | undefined;
if (clipId) {
  const f = readdirSync('bench/clips').find((x) => x.startsWith(clipId) && x.endsWith('.json'));
  if (!f) { console.error(`no clip ${clipId}`); process.exit(2); }
  clip = JSON.parse(readFileSync(join('bench/clips', f), 'utf8')) as Clip;
}

const mode = (arg('--mode') ?? clip?.mode ?? 'panel') as Mode;
const backend = arg('--backend') ?? 'heuristic';
const detector = backend === 'jev-haiku'
  ? new JevDetector({ name: 'jev-haiku', model: HAIKU, timeoutMs: 2500, transport: haikuTransport({ client: claudeClient() ?? die('jev-haiku needs ANTHROPIC_API_KEY') }) })
  : new HeuristicDetector();
const listener = new Listener({ mode, detector, ...(clip?.evidence ? { evidence: clip.evidence } : {}), ...(clip?.stance ? { stance: clip.stance } : {}) });

for (const spec of (arg('--names') ?? '').split(',').filter(Boolean)) {
  const [id, rest] = spec.split('=');
  const [name, role] = (rest ?? '').split(':');
  listener.name(id!.trim(), name?.trim(), (role?.trim() || undefined) as SpeakerRole | undefined);
}

let provider: SttProvider;
if (clip) provider = scriptedProvider(clip, { speed });
else {
  const want = arg('--stt') ?? (process.env.DEEPGRAM_API_KEY ? 'deepgram' : 'assemblyai');
  const key = want === 'deepgram' ? process.env.DEEPGRAM_API_KEY : process.env.ASSEMBLYAI_API_KEY;
  if (!key) die(`${want} needs ${want === 'deepgram' ? 'DEEPGRAM_API_KEY' : 'ASSEMBLYAI_API_KEY'} in .env`);
  provider = want === 'deepgram' ? deepgram({ apiKey: key! }) : assemblyai({ apiKey: key! });
}

const named = new Set<string>();
const firstSeen: string[] = [];
for (const t of clip?.turns ?? []) if (!firstSeen.includes(t.speaker)) firstSeen.push(t.speaker);

listener.on((e) => {
  if (e.type !== 'decision') return;
  const d = e.decision;
  if (!d.final && d.respondState !== 'respond' && !d.diversion) return;
  console.log(line(d));
});

const session = await provider.open({ sampleRate: 16_000 });
session.on((e) => {
  if (e.type === 'chunk') {
    if (clip) for (const w of e.chunk.words) {
      const lab = w.speaker;
      if (lab === undefined || lab === null || named.has(lab)) continue;
      named.add(lab);
      const info = clip.speakers[firstSeen[Number(lab)] ?? ''];
      if (info?.role === 'moderator' || info?.role === 'panelist' || info?.role === 'user') listener.name(listener.speakers.idFor(lab), info.name, info.role);
    }
    void listener.hear(e.chunk);
  } else if (e.type === 'error') console.error(e.error);
});

if (file) {
  if (!existsSync(file) && !/^https?:/.test(file)) die(`no such file: ${file}`);
  const pcm = await decodeAudio(file);
  console.error(`playing ${file}: ${(pcm.length / 16000).toFixed(1)} s at ${speed}x through ${provider.name}`);
  await pace(pcm, (f) => session.send(f), { speed });
}
await session.finish();
await new Promise((r) => setTimeout(r, 200));

mkdirSync('exports', { recursive: true });
const out = join('exports', `listen-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({ mode, backend: detector.name, stt: provider.name, source: file ?? clip?.id, speakers: listener.speakers.list(), decisions: listener.decisions }, null, 1));
console.error(`\nsaved ${out}`);

function line(d: JevDecision): string {
  const who = listener.speakers.get(d.speaker)?.name;
  const tags = [
    d.ignored ? `ignored:${d.ignored}` : '',
    d.shiftType !== 'none' ? `${d.shiftFrom ?? '—'} → ${d.topic} ${d.shiftType.toUpperCase()}` : d.topic ? `on ${d.topic}` : '',
    d.diversion ? `DIVERSION ${d.diversion.type}` : '',
    d.claim ? `claim ${d.claim.subject}${d.claim.value !== undefined ? ' ' + d.claim.value + (d.claim.unit ?? '') : ''}${d.claim.contradicts ? ' CONTRADICTS' : ''}` : '',
    d.addressedToHepta ? 'to Hepta' : '',
  ].filter(Boolean).join(' · ');
  const state = d.respondState === 'listen' ? '' : `  ${d.respondState.toUpperCase()}`;
  return `${clock(d.atMs)} ${d.final ? ' ' : '…'} ${d.speaker}${who ? ' ' + who : ''}: "${d.text}"  [${tags}]${state}  ${d.latencyMs.toFixed(1)}ms`;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
