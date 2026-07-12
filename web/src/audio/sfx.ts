// Lightweight synthesized sound effects (Web Audio API, no asset files/licensing to manage).
// Short tones/noise bursts per event kind, with a persisted mute toggle.

export type SfxKind =
  | 'dice'
  | 'build'
  | 'trade'
  | 'robber'
  | 'card'
  | 'yourTurn'
  | 'win'
  | 'error'
  | 'discard';

const MUTE_KEY = 'catan.sfxMuted';

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  if (!ctx) ctx = new AudioCtor();
  return ctx;
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // non-fatal
  }
}

/** Call once on the first user gesture — browsers suspend AudioContext until then. */
export function unlockAudio(): void {
  const c = getCtx();
  if (c && c.state === 'suspended') {
    c.resume().catch(() => {});
  }
}

function tone(startTime: number, duration: number, freq: number, type: OscillatorType = 'sine', gainPeak = 0.15): void {
  const c = getCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = c.currentTime + startTime;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(gainPeak, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function noiseBurst(startTime: number, duration: number, gainPeak = 0.2): void {
  const c = getCtx();
  if (!c) return;
  const bufferSize = Math.max(1, Math.floor(c.sampleRate * duration));
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }
  const src = c.createBufferSource();
  src.buffer = buffer;
  const gain = c.createGain();
  const t0 = c.currentTime + startTime;
  gain.gain.setValueAtTime(gainPeak, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(gain).connect(c.destination);
  src.start(t0);
}

export function playSfx(kind: SfxKind): void {
  if (isMuted()) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  try {
    switch (kind) {
      case 'dice':
        noiseBurst(0, 0.14, 0.22);
        noiseBurst(0.09, 0.1, 0.16);
        break;
      case 'build':
        tone(0, 0.08, 660, 'square', 0.1);
        tone(0.07, 0.1, 880, 'square', 0.09);
        break;
      case 'trade':
        tone(0, 0.08, 523, 'sine', 0.11);
        tone(0.09, 0.12, 659, 'sine', 0.11);
        break;
      case 'robber':
        tone(0, 0.3, 120, 'sawtooth', 0.13);
        break;
      case 'card':
        tone(0, 0.1, 784, 'triangle', 0.11);
        break;
      case 'yourTurn':
        tone(0, 0.1, 880, 'sine', 0.13);
        tone(0.12, 0.16, 1108, 'sine', 0.13);
        break;
      case 'win':
        [523, 659, 784, 1046].forEach((f, i) => tone(i * 0.12, 0.2, f, 'triangle', 0.13));
        break;
      case 'error':
        tone(0, 0.15, 180, 'square', 0.1);
        break;
      case 'discard':
        tone(0, 0.12, 300, 'sawtooth', 0.09);
        break;
    }
  } catch {
    // AudioContext quirks shouldn't break gameplay
  }
}
