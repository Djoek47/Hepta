/**
 * What a session runs on, chosen from what the operator asked for and the
 * keys that exist. Keys stay on the server; the page only learns which exist.
 */
import {
  assemblyai, claudeClient, deepgram, HAIKU, haikuTransport, HeuristicDetector, JevDetector, scriptedProvider, SonnetResponder, TemplateResponder,
  type Clip, type Detector, type HaikuTiming, type Responder, type SttProvider,
} from '@hepta/listen';

export type Env = Record<string, string | undefined>;

export function keys(env: Env) {
  return { anthropic: !!env.ANTHROPIC_API_KEY, deepgram: !!env.DEEPGRAM_API_KEY, assemblyai: !!env.ASSEMBLYAI_API_KEY };
}

export function detectorFor(backend: string | undefined, env: Env, onTiming?: (t: HaikuTiming) => void): Detector {
  if (backend === 'jev-haiku') {
    const client = claudeClient(env);
    if (!client) throw new Error('jev-haiku needs ANTHROPIC_API_KEY in .env');
    return new JevDetector({ name: 'jev-haiku', model: HAIKU, timeoutMs: 2500, transport: haikuTransport({ client, ...(onTiming ? { onTiming } : {}) }) });
  }
  return new HeuristicDetector();
}

/** The recognizer for live audio: the one asked for, else whichever has a key. */
export function sttFor(name: string | undefined, env: Env): SttProvider {
  const want = name ?? (env.DEEPGRAM_API_KEY ? 'deepgram' : env.ASSEMBLYAI_API_KEY ? 'assemblyai' : undefined);
  if (want === 'deepgram') {
    if (!env.DEEPGRAM_API_KEY) throw new Error('Deepgram needs DEEPGRAM_API_KEY in .env');
    return deepgram({ apiKey: env.DEEPGRAM_API_KEY });
  }
  if (want === 'assemblyai') {
    if (!env.ASSEMBLYAI_API_KEY) throw new Error('AssemblyAI needs ASSEMBLYAI_API_KEY in .env');
    return assemblyai({ apiKey: env.ASSEMBLYAI_API_KEY });
  }
  throw new Error('live audio needs DEEPGRAM_API_KEY or ASSEMBLYAI_API_KEY in .env (scripted clips need no key)');
}

export function scriptedFor(clip: Clip, speed?: number): SttProvider {
  return scriptedProvider(clip, { speed: speed ?? 1 });
}

/** Response cards: Sonnet when asked for (or by default when there is a key), else the local template. */
export function responderFor(name: string | undefined, env: Env): Responder {
  const client = claudeClient(env);
  if ((name === 'sonnet' || name === undefined) && client) return new SonnetResponder({ client });
  if (name === 'sonnet') throw new Error('Sonnet response cards need ANTHROPIC_API_KEY in .env');
  return new TemplateResponder();
}
