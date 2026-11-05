/**
 * The operator's screen. Everything here is a view of what the studio sends:
 * what was heard, what Jev decided about it, the cards it earned, the lines of
 * thought, and what Hepta would say — with its READY / RESPOND light. Every
 * decision and card can be marked for tuning, and the session exported.
 */
import type { Insight, JevDecision, MarkKind, QuestionView, ResponseCard, SpeakerInfo, ThreadView } from '@hepta/listen';
import { captureElement, captureMic, type Capture } from './capture.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const ago = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

const MARK_LABELS: [MarkKind, string][] = [['good', 'good'], ['should_have_flagged', 'should have flagged'], ['false_flag', 'false flag'], ['too_early', 'too early'], ['too_late', 'too late']];
const KIND_LABEL: Record<string, string> = { diversion: 'Diversion', dodged: 'Not answered', contradiction: 'Changed', evidence: 'Evidence', shift: 'Shift', repeat: 'Asked again', correction: 'Corrected', addressed: 'To Hepta' };
const STATE_LABEL: Record<string, string> = { listen: 'Listen', note: 'Note', ready: 'Ready', respond: 'Respond' };

type Clip = { id: string; title: string; mode: string };

const state = {
  ws: null as WebSocket | null,
  running: false,
  mode: 'panel',
  keys: { anthropic: false, deepgram: false, assemblyai: false },
  clips: [] as Clip[],
  speakers: new Map<string, SpeakerInfo>(),
  lines: new Map<string, HTMLElement>(),
  decisions: new Map<string, JevDecision>(),
  lastByUtterance: new Map<string, JevDecision>(),
  insights: new Map<string, { i: Insight; el: HTMLElement; seenAt: number }>(),
  responses: new Map<string, ResponseCard>(),
  threads: [] as ThreadView[],
  questions: [] as QuestionView[],
  marks: new Map<string, MarkKind>(),
  latencies: [] as number[],
  audio: { ms: 0, wall: Date.now(), speed: 1 },
  capture: null as Capture | null,
  speaking: false,
};

// ------------------------------------------------------------------ socket

function connect(): void {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  ws.onopen = () => setConn('connected');
  ws.onclose = () => { setConn('disconnected — reconnecting'); setRunning(false); setTimeout(connect, 1500); };
  ws.onmessage = (e) => onMessage(JSON.parse(String(e.data)) as Record<string, unknown>);
}

function send(m: Record<string, unknown>): void {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(m));
}

function onMessage(m: Record<string, unknown>): void {
  switch (m.type) {
    case 'hello': {
      state.keys = m.keys as typeof state.keys;
      state.clips = m.clips as Clip[];
      fillClips();
      showKeys();
      break;
    }
    case 'started': setRunning(true); $('stt').textContent = `${m.input} · ${m.stt} · Jev ${m.backend} · writer ${m.responder}`; break;
    case 'status': if (m.stt === 'closed' && state.running && (m.reason === 'end of clip')) toast('End of clip.'); break;
    case 'heard': onHeard(m.heard as Parameters<typeof onHeard>[0]); break;
    case 'decision': onDecision(m.decision as JevDecision, m.speakers as SpeakerInfo[] | undefined, m.threads as ThreadView[] | undefined, m.questions as QuestionView[] | undefined); break;
    case 'insight': onInsight(m.insight as Insight); break;
    case 'response': onResponse(m.card as ResponseCard); break;
    case 'floor': if (m.floor === 'yield') stopSpeaking(); break;
    case 'speakers': for (const s of m.speakers as SpeakerInfo[]) state.speakers.set(s.id, s); renderSpeakerEdit(); refreshNames(); break;
    case 'marked': break;
    case 'export': download(m.data); break;
    case 'error': toast(String(m.message)); break;
  }
}

// --------------------------------------------------------------- speakers

function colorOf(id: string): string {
  const n = Number(/\d+/.exec(id)?.[0] ?? 7);
  return `var(--s${((n - 1) % 7) + 1})`;
}
function nameOf(id: string): string {
  return state.speakers.get(id)?.name ?? '';
}

function refreshNames(): void {
  for (const [u, line] of state.lines) {
    const d = state.lastByUtterance.get(u);
    if (d) paintWho(line, d.speaker);
  }
}

function renderSpeakerEdit(): void {
  const box = $('speakerEdit');
  box.replaceChildren();
  const list = [...state.speakers.values()].filter((s) => !s.outside);
  if (list.length === 0) { box.append(el('p', 'empty', 'Speakers appear here as they speak.')); return; }
  for (const s of list) {
    const row = el('div', 'row');
    const id = el('span', '', s.id);
    id.style.color = colorOf(s.id);
    id.style.fontFamily = 'var(--mono)';
    const name = el('input');
    name.value = s.name ?? '';
    name.placeholder = 'name';
    name.setAttribute('aria-label', `${s.id} name`);
    const role = el('select');
    role.setAttribute('aria-label', `${s.id} role`);
    for (const r of ['', 'moderator', 'panelist', 'user']) { const o = el('option', '', r || 'role'); o.value = r; role.append(o); }
    role.value = s.role ?? '';
    const save = () => send({ type: 'name', speaker: s.id, name: name.value.trim() || undefined, role: role.value || undefined });
    name.addEventListener('change', save);
    role.addEventListener('change', save);
    row.append(id, name, role);
    box.append(row);
  }
}

// -------------------------------------------------------------- transcript

function lineFor(utteranceId: string, speaker: string): HTMLElement {
  let line = state.lines.get(utteranceId);
  if (!line) {
    line = el('div', 'line partial');
    line.append(el('div', 'who'), el('p', 'text'), el('div', 'tags'));
    state.lines.set(utteranceId, line);
    const t = $('transcript');
    const stick = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
    t.append(line);
    if (stick) t.scrollTop = t.scrollHeight;
  }
  paintWho(line, speaker);
  return line;
}

function paintWho(line: HTMLElement, speaker: string): void {
  line.style.setProperty('--c', colorOf(speaker));
  const who = line.querySelector('.who')!;
  const at = line.dataset.at ? ` ${clock(Number(line.dataset.at))}` : '';
  who.replaceChildren(document.createTextNode(`${speaker}${at}`));
  const n = nameOf(speaker);
  if (n) who.append(el('small', '', n));
}

function onHeard(h: { utteranceId: string; speaker: string; text: string; final: boolean; startMs: number; atMs: number }): void {
  state.audio = { ms: h.atMs, wall: Date.now(), speed: state.audio.speed };
  const line = lineFor(h.utteranceId, h.speaker);
  if (!line.dataset.at) line.dataset.at = String(h.startMs);
  paintWho(line, h.speaker);
  line.querySelector('.text')!.textContent = h.text;
}

function onDecision(d: JevDecision, speakers?: SpeakerInfo[], threads?: ThreadView[], questions?: QuestionView[]): void {
  if (speakers) { for (const s of speakers) state.speakers.set(s.id, s); if ($('setup').hasAttribute('open') && document.activeElement?.closest('#speakerEdit') === null) renderSpeakerEdit(); }
  if (threads) state.threads = threads;
  if (questions) state.questions = questions;
  state.decisions.set(d.id, d);
  setState(d.respondState, d.why ?? '');
  if (d.trigger === 'chunk') {
    state.latencies.push(d.latencyMs);
    state.lastByUtterance.set(d.utteranceId, d);
    const line = lineFor(d.utteranceId, d.speaker);
    line.classList.toggle('partial', !d.final);
    line.classList.toggle('ignored', !!d.ignored);
    line.querySelector('.text')!.textContent = d.ignored ? `${d.text}  (${d.ignored === 'backchannel' ? 'a nod' : d.ignored})` : d.text;
    paintTags(line, d);
  }
  renderThreads();
  renderStats();
}

function paintTags(line: HTMLElement, d: JevDecision): void {
  const tags = line.querySelector('.tags')!;
  tags.replaceChildren();
  if (d.ignored) return;
  if (d.topic) tags.append(el('span', 'tag', d.topic));
  if (d.shiftType !== 'none') tags.append(el('span', `tag shift${d.shiftType === 'diversion' ? ' live' : ''}`, `${d.shiftType.replace('_', '-')}${d.shiftFrom ? ' · from ' + d.shiftFrom : ''}`));
  if (d.diversion) tags.append(el('span', `tag div${d.final ? '' : ' live'}`, d.diversion.type.replace('_', ' ')));
  if (d.claim) tags.append(el('span', `tag${d.claim.contradicts ? ' contra' : ''}`, `${d.claim.contradicts ? '≠ ' : ''}${d.claim.subject}${d.claim.value !== undefined ? ' ' + figure(d.claim.value, d.claim.unit) : ''}`));
  if (d.addressedToHepta) tags.append(el('span', 'tag live', 'to Hepta'));
  // A dodge is found when someone else speaks: name who did not answer, not who spoke.
  for (const qid of d.dodged ?? []) {
    const q = state.questions.find((x) => x.id === qid);
    tags.append(el('span', 'tag div', q ? `${q.to ?? '?'} did not answer “${q.text.length > 32 ? q.text.slice(0, 30) + '…' : q.text}”` : 'a question went unanswered'));
  }
  if (!d.final && d.readings.length > 1) tags.append(el('span', 'tag', d.readings.slice(0, 3).map((r) => `${r.label.replace('diversion:', '')} ${Math.round(r.p * 100)}%`).join(' · ')));
  const lat = el('span', 'tag lat', `${d.backend} ${d.latencyMs < 10 ? d.latencyMs.toFixed(1) : Math.round(d.latencyMs)} ms`);
  tags.append(lat);
  if (d.final) tags.append(marksFor(d.id, 'decision'));
}

const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
function figure(v: number, unit?: string): string {
  const n = Math.abs(v) >= 1e5 ? compact.format(v) : v.toLocaleString('en-GB');
  return unit === '%' ? `${n}%` : unit && /[£$€]/.test(unit) ? `${unit}${n}` : n;
}

function marksFor(target: string, on: 'decision' | 'insight' | 'response'): HTMLElement {
  const box = el('span', 'marks');
  const set = state.marks.get(target);
  if (set) box.classList.add('set');
  for (const [k, label] of MARK_LABELS) {
    const b = el('button', '', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(set === k));
    b.addEventListener('click', () => {
      state.marks.set(target, k);
      send({ type: 'mark', target, on, mark: k });
      for (const x of box.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
      box.classList.add('set');
    });
    box.append(b);
  }
  return box;
}

// ------------------------------------------------------------------ threads

function audioNow(): number {
  return state.audio.ms + (state.running ? (Date.now() - state.audio.wall) * state.audio.speed : 0);
}

function renderThreads(): void {
  const list = $('threads');
  list.replaceChildren();
  const shown = state.threads.filter((t) => t.weight >= 0.05).slice(0, 8);
  if (shown.length === 0) list.append(el('li', 'empty', 'Lines of thought appear as subjects come up.'));
  for (const t of shown) {
    const li = el('li', `thread${t.onAir ? ' onair' : ''}${t.weight < 0.3 ? ' faded' : ''}`);
    li.append(el('span', 'name', t.topic), el('span', 'meta', `${t.owner}${nameOf(t.owner) ? ' ' + nameOf(t.owner) : ''} · ${t.weight.toFixed(2)}`));
    const bar = el('span', 'wbar');
    const fill = el('span');
    fill.style.width = `${Math.min(100, (t.weight / 5) * 100)}%`;
    bar.append(fill);
    li.append(bar);
    li.title = `weight ${t.weight.toFixed(2)} · halves every 5 min · ${t.mentions} mention(s)`;
    list.append(li);
  }
  renderQuestions();
}

function renderQuestions(): void {
  const list = $('questions');
  list.replaceChildren();
  const now = audioNow();
  const qs = state.questions.filter((q) => q.status !== 'answered').slice(-6).reverse();
  if (qs.length === 0) list.append(el('li', 'empty', 'No question left unanswered.'));
  for (const q of qs) {
    const li = el('li', `q ${q.status}`);
    li.append(el('div', 'qt', `“${q.text}”`));
    const meta = el('div', 'qm');
    meta.append(`asked ${ago(now - q.askedMs)} ago by ${q.by}${nameOf(q.by) ? ' ' + nameOf(q.by) : ''}${q.to ? ` to ${q.to}` : ''} — `);
    meta.append(el('b', '', q.status === 'dodged' ? 'not answered' : 'open'));
    if (q.asks > 1) meta.append(` · asked ${q.asks}×`);
    if (q.turnsSince) meta.append(` · ${q.turnsSince} turn(s) since`);
    li.append(meta);
    list.append(li);
  }
}

// ----------------------------------------------------------------- insights

function onInsight(i: Insight): void {
  const known = state.insights.get(i.id);
  const card = known?.el ?? el('li', 'card');
  card.className = `card ${i.status}`;
  card.replaceChildren();
  const k = el('div', 'k');
  k.append(el('span', '', `${KIND_LABEL[i.kind] ?? i.kind}${i.type && i.kind === 'diversion' ? ' · ' + i.type.replace('_', ' ') : ''}`), el('span', 'st', i.status === 'confirmed' ? clock(i.atMs) : i.status));
  card.append(k, el('p', 't', i.text));
  if (i.detail) card.append(el('p', 'd', i.detail));
  if (i.status !== 'provisional') card.append(marksFor(i.id, 'insight'));
  state.insights.set(i.id, { i, el: card, seenAt: known?.seenAt ?? Date.now() });
  if (!known) $('insights').prepend(card);
  freshen();
}

/** Red marks what is live: a card is fresh for twenty seconds, then it is history. */
function freshen(): void {
  for (const { i, el: card, seenAt } of state.insights.values()) card.classList.toggle('fresh', i.status !== 'retracted' && Date.now() - seenAt < 20_000);
}

// ---------------------------------------------------------------- response

function setState(s: string, why: string): void {
  const st = $('state');
  st.dataset.s = s;
  st.querySelector('b')!.textContent = STATE_LABEL[s] ?? s;
  document.body.classList.toggle('respond', s === 'respond');
  if (s === 'ready' || s === 'respond') $('why').textContent = why;
}

function onResponse(card: ResponseCard): void {
  state.responses.set(card.id, card);
  const box = $('response');
  box.classList.toggle('writing', card.status === 'writing');
  box.classList.add('onair');
  $('say').textContent = card.text || '…';
  const cites = $('cites');
  const seen = new Set<string>();
  const uniq = card.cites.filter((q) => { const k = `${q.speaker}|${q.atMs}|${q.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
  cites.replaceChildren(...uniq.slice(0, 4).map((q) => el('span', 'cite', `${q.speaker} ${clock(q.atMs)} “${q.text}”`)));
  $('respLat').textContent = card.status === 'done'
    ? `${card.responder} · first words ${fmtMs(card.firstMs)} · card ${fmtMs(card.totalMs)}` : `${card.responder} writing…`;
  $('respMarks').replaceChildren(marksFor(card.id, 'response'));
  if (card.status === 'done') {
    if (($('autoSpeak') as HTMLInputElement).checked) speak(card.text);
    setTimeout(() => box.classList.remove('onair'), 8000);
  }
}

function fmtMs(ms?: number): string {
  return ms === undefined ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function speak(text: string): void {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.onstart = () => { state.speaking = true; send({ type: 'speaking', on: true }); };
  u.onend = u.onerror = () => { state.speaking = false; send({ type: 'speaking', on: false }); };
  speechSynthesis.speak(u);
}

function stopSpeaking(): void {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// ------------------------------------------------------------------ inputs

function fillClips(): void {
  const sel = $<HTMLSelectElement>('clip');
  sel.replaceChildren(...state.clips.map((c) => { const o = el('option', '', `${c.id.slice(0, 2)} · ${c.title}`); o.value = c.id; return o; }));
  sel.dispatchEvent(new Event('change'));
}

function showKeys(): void {
  const k = state.keys;
  $('keysLine').textContent = `Keys on the server: Claude ${k.anthropic ? 'yes' : 'no'} · Deepgram ${k.deepgram ? 'yes' : 'no'} · AssemblyAI ${k.assemblyai ? 'yes' : 'no'}.`;
  const writer = $<HTMLSelectElement>('writer');
  if (!k.anthropic) { writer.value = 'template'; (writer.querySelector('[value=sonnet]') as HTMLOptionElement).disabled = true; }
  if (!k.anthropic) (($('backend').querySelector('[value="jev-haiku"]')) as HTMLOptionElement).disabled = true;
  for (const v of ['mic', 'file', 'url']) {
    const o = $('input').querySelector(`[value=${v}]`) as HTMLOptionElement;
    o.disabled = !k.deepgram && !k.assemblyai;
    if (o.disabled) o.textContent = `${o.textContent!.replace(/ \(needs a speech key\)$/, '')} (needs a speech key)`;
  }
}

function setMode(m: string): void {
  state.mode = m;
  for (const b of $('mode').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === m));
}

function setRunning(on: boolean): void {
  state.running = on;
  document.body.classList.toggle('running', on);
  $('go').textContent = on ? 'Stop' : 'Start';
}

function setConn(s: string): void { $('conn').textContent = s; }

function readStance() {
  const topic = $<HTMLInputElement>('stTopic').value.trim();
  const position = $<HTMLTextAreaElement>('stPos').value.trim();
  if (!topic || !position) return undefined;
  const keys = $<HTMLInputElement>('stKeys').value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return { topic, keys: keys.length ? keys : [topic.toLowerCase()], position, confidence: Number($<HTMLInputElement>('stConf').value), evidence: [] as string[] };
}

function readEvidence() {
  const rows = $<HTMLTextAreaElement>('evidence').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = rows.map((r, i) => {
    const [subject, words, value, unit, text, source] = r.split('|').map((x) => x.trim());
    return { id: `e${i + 1}`, subject: subject ?? `item ${i + 1}`, keys: (words ?? subject ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
      ...(value && !Number.isNaN(Number(value)) ? { value: Number(value) } : {}), ...(unit ? { unit } : {}), text: text || r, ...(source ? { source } : {}) };
  });
  return out.length ? out : undefined;
}

async function start(): Promise<void> {
  const input = $<HTMLSelectElement>('input').value;
  reset();
  const base = { type: 'start', input, mode: state.mode, backend: $<HTMLSelectElement>('backend').value, responder: $<HTMLSelectElement>('writer').value,
    ...(readStance() ? { stance: readStance() } : {}), ...(readEvidence() ? { evidence: readEvidence() } : {}) };
  if (input === 'script') {
    const speed = Number($<HTMLSelectElement>('speed').value);
    state.audio.speed = speed;
    const clip = state.clips.find((c) => c.id === $<HTMLSelectElement>('clip').value);
    send({ ...base, clip: clip?.id, speed, mode: state.mode });
    return;
  }
  state.audio.speed = 1;
  try {
    if (input === 'mic') {
      send({ ...base, sampleRate: 16000 });
      state.capture = await captureMic((pcm) => sendAudio(pcm));
    } else {
      const player = $<HTMLVideoElement>('player');
      if (input === 'file') {
        const f = $<HTMLInputElement>('file').files?.[0];
        if (!f) { toast('Choose a file first.'); return; }
        player.src = URL.createObjectURL(f);
      } else {
        const u = $<HTMLInputElement>('url').value.trim();
        if (!u) { toast('Paste a media URL first.'); return; }
        player.src = `/media?url=${encodeURIComponent(u)}`;
      }
      $('mediaBox').hidden = false;
      send({ ...base, sampleRate: 16000 });
      state.capture = await captureElement(player, (pcm) => sendAudio(pcm));
      player.onended = () => stop();
      await player.play();
    }
  } catch (e) {
    toast(`Could not start ${input}: ${(e as Error).message}`);
    stop();
  }
}

function sendAudio(pcm: Int16Array): void {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
}

function stop(): void {
  state.capture?.stop();
  state.capture = null;
  send({ type: 'stop' });
  setRunning(false);
  setState('listen', '');
}

function reset(): void {
  state.lines.clear();
  state.decisions.clear();
  state.lastByUtterance.clear();
  state.insights.clear();
  state.responses.clear();
  state.speakers.clear();
  state.threads = [];
  state.questions = [];
  state.marks.clear();
  state.latencies = [];
  $('transcript').replaceChildren();
  $('insights').replaceChildren();
  $('say').textContent = 'Listening…';
  $('why').textContent = '';
  $('cites').replaceChildren();
  $('respLat').textContent = '';
  $('respMarks').replaceChildren();
  $('response').classList.remove('onair', 'writing');
  renderThreads();
  renderSpeakerEdit();
}

function renderStats(): void {
  const xs = [...state.latencies].sort((a, b) => a - b);
  const med = xs.length ? xs[Math.floor(xs.length / 2)]! : 0;
  const p95 = xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]! : 0;
  $('stats').textContent = `${xs.length} decisions · Jev median ${med.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms`;
}

function download(data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hepta-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

// ------------------------------------------------------------------- wiring

function wire(): void {
  for (const b of $('mode').querySelectorAll<HTMLButtonElement>('button')) b.addEventListener('click', () => setMode(b.dataset.v!));
  setMode('panel');
  const input = $<HTMLSelectElement>('input');
  const showPickers = () => {
    const v = input.value;
    $('clipPick').hidden = v !== 'script';
    $('speedPick').hidden = v !== 'script';
    $('filePick').hidden = v !== 'file';
    $('urlPick').hidden = v !== 'url';
    $('mediaBox').hidden = v === 'script' || v === 'mic';
  };
  input.addEventListener('change', showPickers);
  showPickers();
  $<HTMLSelectElement>('clip').addEventListener('change', () => {
    const c = state.clips.find((x) => x.id === $<HTMLSelectElement>('clip').value);
    if (c) setMode(c.mode);
  });
  $('go').addEventListener('click', () => (state.running ? stop() : void start()));
  $('cue').addEventListener('click', () => send({ type: 'cue' }));
  $('export').addEventListener('click', () => send({ type: 'export' }));
  $('speak').addEventListener('click', () => { const last = [...state.responses.values()].pop(); if (last) speak(last.text); });
  $('stConf').addEventListener('input', () => { $('stConfOut').textContent = Number($<HTMLInputElement>('stConf').value).toFixed(2); });
  $('setup').addEventListener('toggle', renderSpeakerEdit);
  $('theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('hepta-theme', root.dataset.theme); } catch { /* private window */ }
  });
  try { const t = localStorage.getItem('hepta-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* private window */ }
  setInterval(() => { renderQuestions(); freshen(); }, 1000);
  renderThreads();
  renderSpeakerEdit();
  connect();
}

wire();
