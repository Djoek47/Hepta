/**
 * npm run bench:draft -- --audio path/to/debate.mp4 --id my-debate [--mode panel] [--stt deepgram|assemblyai] [--speed 1]
 *
 * Transcribes a recording once (at broadcast speed, cached) and writes
 * bench/clips/<id>/clip.json: the turns with their times and words, speakers
 * S1, S2… as the recognizer heard them, and every label left for a person to
 * fill in. Name the speakers, fix any turn the diarizer got wrong, label.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { assemblyai, deepgram, type Clip } from '@hepta/listen';
import { draftClip, transcribe } from '../bench/src/recorded.js';

for (const line of existsSync('.env') ? readFileSync('.env', 'utf8').split('\n') : []) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const audio = arg('--audio');
const id = arg('--id') ?? (audio ? basename(audio).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined);
if (!audio || !id || !existsSync(audio)) { console.error('usage: npm run bench:draft -- --audio <file> --id <name> [--mode panel]'); process.exit(2); }
const want = arg('--stt') ?? (process.env.DEEPGRAM_API_KEY ? 'deepgram' : 'assemblyai');
const key = want === 'deepgram' ? process.env.DEEPGRAM_API_KEY : process.env.ASSEMBLYAI_API_KEY;
if (!key) { console.error(`needs ${want === 'deepgram' ? 'DEEPGRAM_API_KEY' : 'ASSEMBLYAI_API_KEY'} in .env`); process.exit(2); }
const provider = want === 'deepgram' ? deepgram({ apiKey: key }) : assemblyai({ apiKey: key });

const dir = join('bench/clips', id);
mkdirSync(dir, { recursive: true });
const local = `audio${audio.slice(audio.lastIndexOf('.'))}`;
if (!existsSync(join(dir, local))) copyFileSync(audio, join(dir, local));
const stub: Clip = { id, title: id, mode: (arg('--mode') ?? 'panel') as Clip['mode'], audio: local, speakers: {}, turns: [] };
const t = await transcribe(stub, dir, provider, { speed: Number(arg('--speed') ?? 1), log: console.error });
const clip = draftClip(id, local, t, stub.mode);
const out = join(dir, 'clip.json');
if (existsSync(out)) { console.error(`${out} exists; writing clip.draft.json instead`); writeFileSync(join(dir, 'clip.draft.json'), JSON.stringify(clip, null, 2)); }
else writeFileSync(out, JSON.stringify(clip, null, 2));
console.error(`${clip.turns.length} turns, ${Object.keys(clip.speakers).length} speakers → ${dir}. Now label it (bench/clips/README.md).`);
