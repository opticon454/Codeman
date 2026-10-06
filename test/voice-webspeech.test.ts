/**
 * Web Speech dictation on a phone (Edge for Android): "Listening…" in red, the timer starts, and it
 * stops itself after a couple of seconds with no message.
 *
 * Three things made that so, and each is pinned here against a fake recogniser and a manual clock:
 *  - a flat 3 s silence timer started at the tap, before the speech service was even listening, so
 *    anyone who took a moment to begin (or a service that took a moment to start) was cut off;
 *  - a second microphone capture (`getUserMedia`, for the cosmetic level meter) opened at the same time
 *    as the recogniser, which on Android ends the recogniser after a second or two;
 *  - every self-ending (`no-speech`, `aborted`, a bare `onend`) was silent, so it looked like a dead button.
 *
 * Builds a JSDOM window in-test under the default node env (do NOT declare a per-file jsdom
 * environment: it externalizes node:fs under vite and the readFileSync below stops working).
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(new URL('../src/web/public/voice-input.js', import.meta.url), 'utf-8');

class FakeRecognition {
  static last: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = '';
  maxAlternatives = 1;
  started = 0;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started += 1;
  }
  stop() {}
}

function boot(userAgent: string) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window as any;
  Object.defineProperty(win.navigator, 'userAgent', { value: userAgent, configurable: true });
  let now = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  win.Date.now = () => now;
  win.setTimeout = (fn: () => void, ms = 0) => {
    const id = nextId++;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  win.clearTimeout = (id: number) => void timers.delete(id);
  win.setInterval = () => 0;
  win.clearInterval = () => {};
  const toasts: Array<[string, string]> = [];
  win.app = {
    activeSessionId: 'sess-1',
    showToast: (msg: string, kind: string) => toasts.push([msg, kind]),
    sendInput: () => Promise.resolve(),
  };
  win.SpeechRecognition = FakeRecognition;
  const getUserMedia = vi.fn(() => new Promise(() => {})); // never resolves: only whether it was CALLED matters
  Object.defineProperty(win.navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(SOURCE, ctx, { filename: 'voice-input.js' });
  const voice = vm.runInContext('VoiceInput', ctx) as any;
  // The DOM-only presentation is not what is under test.
  for (const name of [
    '_updateButtons',
    '_showPreview',
    '_hidePreview',
    '_startDurationTimer',
    '_stopDurationTimer',
    '_startLevelMeter',
    '_stopLevelMeter',
  ]) {
    voice[name] = () => {};
  }
  voice._insertText = vi.fn();
  voice.recognition = null;
  voice._resolveProvider = () => 'webspeech';
  return {
    voice,
    toasts,
    getUserMedia,
    /** Advance the manual clock, firing due timers in order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
    },
  };
}

const ANDROID_EDGE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

beforeEach(() => {
  FakeRecognition.last = null;
});

describe('Web Speech on a phone', () => {
  it('does not open a second microphone capture on Android, but still does on desktop', () => {
    const android = boot(ANDROID_EDGE);
    android.voice.start();
    expect(FakeRecognition.last!.started).toBe(1);
    expect(android.getUserMedia).not.toHaveBeenCalled();

    const desktop = boot(DESKTOP);
    desktop.voice.start();
    expect(desktop.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('waits for the speech service to start listening: no cut-off at 3 s from the tap', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    t.advance(7_900);
    expect(t.voice.isRecording).toBe(true); // used to have ended at 3 s
    expect(t.toasts).toEqual([]);
    t.advance(200);
    expect(t.voice.isRecording).toBe(false);
    expect(t.toasts).toEqual([["Didn't hear anything. Tap the mic and start talking.", 'info']]); // and says so
  });

  it('starts the grace period when the engine really begins listening, then 4 s of quiet after speech starts', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    t.advance(2_000);
    FakeRecognition.last!.onaudiostart!(); // engine up at t=2 s: a fresh 8 s from here
    t.advance(7_900);
    expect(t.voice.isRecording).toBe(true);
    FakeRecognition.last!.onspeechstart!(); // the person speaks: the normal short pause applies
    t.advance(3_900);
    expect(t.voice.isRecording).toBe(true);
    t.advance(200);
    expect(t.voice.isRecording).toBe(false);
  });

  const phrase = (text: string, isFinal: boolean, index = 0) => ({
    resultIndex: index,
    results: Object.assign(
      Array.from({ length: index + 1 }, (_, n) =>
        n === index
          ? Object.assign([{ transcript: text }], { isFinal })
          : Object.assign([{ transcript: '' }], { isFinal: true })
      ),
      {}
    ),
  });

  it('keeps listening after a finished phrase, and puts each phrase in the prompt once', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    FakeRecognition.last!.onresult!(phrase('testing', true, 0)); // what Android hands back after a pause
    expect(t.voice.isRecording).toBe(true); // used to stop here, about two seconds in
    expect(t.voice._insertText).toHaveBeenCalledTimes(1);
    expect(t.voice._insertText).toHaveBeenLastCalledWith('testing', { keepLeadingSpace: false });

    t.advance(1_500);
    FakeRecognition.last!.onresult!(phrase(' this keeps going', true, 1));
    expect(t.voice.isRecording).toBe(true);
    expect(t.voice._insertText).toHaveBeenCalledTimes(2);
    expect(t.voice._insertText).toHaveBeenLastCalledWith(' this keeps going', { keepLeadingSpace: true });
  });

  it('ends 4 s after the LAST phrase, without inserting anything a second time', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    FakeRecognition.last!.onresult!(phrase('one', true, 0));
    t.advance(2_000);
    FakeRecognition.last!.onresult!(phrase(' two', true, 1)); // restarts the quiet timer
    t.advance(3_900);
    expect(t.voice.isRecording).toBe(true);
    t.advance(200);
    expect(t.voice.isRecording).toBe(false);
    expect(t.voice._insertText).toHaveBeenCalledTimes(2); // 'one' and ' two', not 'one two' again at the end
    expect(t.toasts).toEqual([]);
  });

  it('the engine ending by itself after phrases inserts nothing new and does not complain', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    FakeRecognition.last!.onresult!(phrase('hello', true, 0));
    t.advance(6_000);
    FakeRecognition.last!.onend!();
    expect(t.voice._insertText).toHaveBeenCalledTimes(1);
    expect(t.toasts).toEqual([]);
  });

  it('compose mode keeps the editor holding everything dictated so far, replacing rather than appending', () => {
    const t = boot(ANDROID_EDGE);
    t.voice._getDeepgramConfig = () => ({ insertMode: 'compose' });
    t.voice.start();
    FakeRecognition.last!.onresult!(phrase('hello', true, 0));
    FakeRecognition.last!.onresult!(phrase(' world', true, 1));
    expect(t.voice._insertText.mock.calls.map((c: unknown[]) => c[0])).toEqual(['hello', 'hello world']);
  });

  it('a pause in an interim phrase does NOT end the session on Android, but still does on iOS (no finals there)', () => {
    const android = boot(ANDROID_EDGE);
    android.voice.start();
    FakeRecognition.last!.onresult!(phrase('testing', false, 0));
    android.advance(1_000);
    expect(android.voice.isRecording).toBe(true); // the 750 ms "stopped changing" rule is iOS-only

    const ios = boot(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );
    ios.voice.start();
    FakeRecognition.last!.onresult!(phrase('testing', false, 0));
    ios.advance(800);
    expect(ios.voice.isRecording).toBe(false);
    expect(ios.voice._insertText).toHaveBeenCalledWith('testing', { keepLeadingSpace: false });
  });

  it.each([
    ['no-speech', 'info', /Didn't hear anything/],
    ['aborted', 'warning', /interrupted/],
    ['audio-capture', 'error', /microphone/],
    ['service-not-allowed', 'error', /Deepgram/],
    ['not-allowed', 'error', /Microphone access denied/],
    ['network', 'error', /internet/],
    ['language-not-supported', 'error', /Voice input error: language-not-supported/],
  ])('a %s ending tells the person why', (error, kind, text) => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    FakeRecognition.last!.onerror!({ error });
    expect(t.voice.isRecording).toBe(false);
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0][1]).toBe(kind);
    expect(t.toasts[0][0]).toMatch(text);
  });

  it('says nothing for an error that arrives after the person stopped it themselves', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    t.voice.stop();
    FakeRecognition.last!.onerror!({ error: 'aborted' });
    expect(t.toasts).toEqual([]);
  });

  it('a recogniser that ends itself after a couple of seconds having heard nothing says so', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    t.advance(2_000);
    FakeRecognition.last!.onend!();
    expect(t.voice.isRecording).toBe(false);
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0][0]).toMatch(/stopped after 2 s without hearing anything/);
    expect(t.toasts[0][0]).toMatch(/Deepgram/);
  });

  it('still silently retries the very early premature end (under 500 ms) instead of complaining', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    t.advance(200);
    FakeRecognition.last!.onend!();
    expect(FakeRecognition.last!.started).toBe(2); // restarted
    expect(t.voice.isRecording).toBe(true);
    expect(t.toasts).toEqual([]);
  });

  it('an end after a result inserts the text and does not complain', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    t.voice._hasReceivedResult = true;
    t.voice._accumulatedFinal = 'hello world';
    t.advance(2_000);
    FakeRecognition.last!.onend!();
    expect(t.voice._insertText).toHaveBeenCalledWith('hello world', { keepLeadingSpace: false });
    expect(t.toasts).toEqual([]);
  });
});
