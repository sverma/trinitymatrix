const preferenceKey = "trinitymatrix:turn-sounds";

type AudioWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

let audioContext: AudioContext | null = null;
let lastCueKey = "";

function contextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const audioWindow = window as AudioWindow;
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function getContext(): AudioContext | null {
  if (audioContext) return audioContext;
  const AudioContextClass = contextConstructor();
  if (!AudioContextClass) return null;
  audioContext = new AudioContextClass();
  return audioContext;
}

export function getTurnSoundsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(preferenceKey) !== "off";
  } catch {
    return true;
  }
}

export function setTurnSoundsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(preferenceKey, enabled ? "on" : "off");
  } catch {
    // A blocked preference store must not interfere with gameplay.
  }
}

export async function unlockTurnSounds(): Promise<boolean> {
  if (!getTurnSoundsEnabled()) return false;
  const context = getContext();
  if (!context) return false;
  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {
      return false;
    }
  }
  return context.state === "running";
}

function envelope(context: AudioContext, startsAt: number, duration: number, volume: number): GainNode {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(volume, startsAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
  gain.connect(context.destination);
  return gain;
}

function bell(context: AudioContext, startsAt: number, frequency: number, duration: number, volume: number): void {
  const fundamental = context.createOscillator();
  fundamental.type = "sine";
  fundamental.frequency.setValueAtTime(frequency, startsAt);
  fundamental.connect(envelope(context, startsAt, duration, volume));
  fundamental.start(startsAt);
  fundamental.stop(startsAt + duration);

  const shimmer = context.createOscillator();
  shimmer.type = "sine";
  shimmer.frequency.setValueAtTime(frequency * 2.01, startsAt);
  shimmer.connect(envelope(context, startsAt, duration * 0.58, volume * 0.28));
  shimmer.start(startsAt);
  shimmer.stop(startsAt + duration * 0.58);
}

function canPlay(cueKey: string): AudioContext | null {
  if (!getTurnSoundsEnabled() || cueKey === lastCueKey) return null;
  const context = getContext();
  if (!context || context.state !== "running") return null;
  lastCueKey = cueKey;
  return context;
}

export function playTurnStarted(cueKey: string): void {
  const context = canPlay(`start:${cueKey}`);
  if (!context) return;
  const now = context.currentTime + 0.025;
  // A quiet, ascending three-note bell melody: warm enough to invite action
  // without competing with the table or speech output.
  bell(context, now, 523.25, 0.72, 0.052);
  bell(context, now + 0.14, 659.25, 0.72, 0.048);
  bell(context, now + 0.28, 783.99, 0.82, 0.044);
}

export function playTurnEnded(cueKey: string): void {
  const context = canPlay(`end:${cueKey}`);
  if (!context) return;
  const now = context.currentTime + 0.025;
  bell(context, now, 987.77, 0.42, 0.042);

  // A very short falling whistle confirms that control has passed away.
  const whistle = context.createOscillator();
  whistle.type = "sine";
  whistle.frequency.setValueAtTime(880, now + 0.07);
  whistle.frequency.exponentialRampToValueAtTime(587.33, now + 0.34);
  whistle.connect(envelope(context, now + 0.07, 0.3, 0.032));
  whistle.start(now + 0.07);
  whistle.stop(now + 0.38);
}
