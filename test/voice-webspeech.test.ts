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

  /**
   * A `result` event as the engine delivers it: every final phrase of the session so far, then at most one
   * interim one. (`resultIndex` is the first entry that changed.)
   */
  const speech = (finals: string[], interim = '') => ({
    resultIndex: Math.max(0, finals.length - 1),
    results: [
      ...finals.map((transcript) => Object.assign([{ transcript }], { isFinal: true })),
      ...(interim ? [Object.assign([{ transcript: interim }], { isFinal: false })] : []),
    ],
  });

  it('keeps listening after a finished phrase, and puts each phrase in the prompt once', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    FakeRecognition.last!.onresult!(speech(['testing'])); // what Android hands back after a pause
    expect(t.voice.isRecording).toBe(true); // used to stop here, about two seconds in
    expect(t.voice._insertText).toHaveBeenCalledTimes(1);
    expect(t.voice._insertText).toHaveBeenLastCalledWith('testing', { keepLeadingSpace: false });

    t.advance(1_500);
    FakeRecognition.last!.onresult!(speech(['testing', ' this keeps going']));
    expect(t.voice.isRecording).toBe(true);
    expect(t.voice._insertText).toHaveBeenCalledTimes(2);
    expect(t.voice._insertText).toHaveBeenLastCalledWith(' this keeps going', { keepLeadingSpace: true });
  });

  // What Chrome on Android really sends: the running sentence as ONE "final" result, repeated and extended
  // on every update. Adding each event's final text put "testing", "testing can", "testing can you"... into
  // the prompt one after another (reported from a phone).
  it('a sentence re-sent in growing "final" results is inserted once, not once per update', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    const updates = [
      'testing',
      'testing can',
      'testing can',
      'testing can you',
      'testing can you',
      'testing can you go',
      'testing can you go longer',
      'testing can you go longer than two seconds now',
      'testing can you go longer than two seconds now',
    ];
    for (const text of updates) FakeRecognition.last!.onresult!(speech([text]));
    const pieces = t.voice._insertText.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(pieces.join('').trim()).toBe('testing can you go longer than two seconds now');
    expect(t.voice._accumulatedFinal).toBe('testing can you go longer than two seconds now');
    expect(t.voice.isRecording).toBe(true);
  });

  // The shape from the phone that reported it: each update is a NEW entry in `results`, holding the whole
  // sentence so far, every one flagged final (so the list grows: 1 entry, 2 entries, 3 entries...).
  it('a chain of growing "final" entries is one sentence, inserted once', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    const sentence = [
      'alright',
      "alright let's",
      "alright let's try",
      "alright let's try this",
      "alright let's try this again",
    ];
    const entries: string[] = [];
    for (const text of sentence) {
      entries.push(text);
      FakeRecognition.last!.onresult!(speech([...entries]));
    }
    const pieces = t.voice._insertText.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(pieces.join('').trim()).toBe("alright let's try this again");
    expect(pieces).toEqual(['alright', " let's", ' try', ' this', ' again']);
    expect(t.voice._accumulatedFinal).toBe("alright let's try this again");
  });

  it('genuinely separate phrases in one session are still both kept', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    FakeRecognition.last!.onresult!(speech(['hello there']));
    FakeRecognition.last!.onresult!(speech(['hello there', ' how are you']));
    expect(t.voice._accumulatedFinal).toBe('hello there how are you');
    const pieces = t.voice._insertText.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(pieces.join('')).toBe('hello there how are you');
  });

  it('an interim entry that extends the final text is not shown twice in the preview', () => {
    const t = boot(ANDROID_EDGE);
    const shown: string[] = [];
    t.voice._showPreview = (text: string) => shown.push(text);
    t.voice.start();
    FakeRecognition.last!.onresult!(speech(["alright let's"], "alright let's try"));
    expect(shown.at(-1)).toBe("alright let's try");
  });

  it('words the engine revises that are already in the prompt are not inserted twice', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    FakeRecognition.last!.onresult!(speech(['recognise speech']));
    FakeRecognition.last!.onresult!(speech(['wreck a nice beach']));
    const pieces = t.voice._insertText.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(pieces[0]).toBe('recognise speech');
    // Direct mode can only append: from the first difference on, once.
    expect(pieces).toHaveLength(2);
    expect(pieces[1]).toMatch(/^ ?wreck a nice beach$/);
  });

  it('ends 4 s after the LAST phrase, without inserting anything a second time', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    FakeRecognition.last!.onresult!(speech(['one']));
    t.advance(2_000);
    FakeRecognition.last!.onresult!(speech(['one', ' two'])); // restarts the quiet timer
    t.advance(3_900);
    expect(t.voice.isRecording).toBe(true);
    t.advance(200);
    expect(t.voice.isRecording).toBe(false);
    expect(t.voice._insertText).toHaveBeenCalledTimes(2); // 'one' and ' two', not 'one two' again at the end
    expect(t.toasts).toEqual([]);
  });

  // Chrome and Edge on Android ignore `continuous = true`: the recogniser ends at the first pause, however
  // it was configured. Without re-arming it the session stopped after one word.
  it('re-arms a recogniser that ended by itself right after a phrase, so a second phrase is heard', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    const rec = FakeRecognition.last!;
    rec.onresult!(speech(['testing']));
    t.advance(300);
    rec.onend!(); // Android: the engine is done after one utterance
    expect(rec.started).toBe(2); // listening again
    expect(t.voice.isRecording).toBe(true);
    expect(t.toasts).toEqual([]);

    t.advance(1_000);
    rec.onresult!(speech(['this is the second part'])); // a fresh transcript, index 0 again
    expect(t.voice._insertText).toHaveBeenCalledTimes(2);
    expect(t.voice._insertText).toHaveBeenLastCalledWith(' this is the second part', { keepLeadingSpace: true });
    expect(t.voice._accumulatedFinal).toBe('testing this is the second part'); // one space between phrases
  });

  it('does not re-arm once the quiet window has run out, or after the person stopped it', () => {
    const late = boot(ANDROID_EDGE);
    late.voice.start();
    FakeRecognition.last!.onresult!(speech(['hello']));
    late.advance(3_900); // still inside the window...
    late.voice._lastResultAt -= 5_000; // ...but pretend the last phrase was long ago
    FakeRecognition.last!.onend!();
    expect(FakeRecognition.last!.started).toBe(1);
    expect(late.voice.isRecording).toBe(false);

    const tapped = boot(ANDROID_EDGE);
    tapped.voice.start();
    FakeRecognition.last!.onresult!(speech(['hello']));
    tapped.voice.stop();
    FakeRecognition.last!.onend!();
    expect(FakeRecognition.last!.started).toBe(1);
  });

  it('is bounded: a recogniser that keeps ending is re-armed a limited number of times', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    const rec = FakeRecognition.last!;
    rec.onresult!(speech(['hello']));
    for (let i = 0; i < 100 && t.voice.isRecording; i += 1) {
      t.voice._lastResultAt = Date.now(); // each cycle counts as just having heard speech
      rec.onend!();
    }
    expect(rec.started).toBe(1 + t.voice.WEBSPEECH_MAX_RESTARTS);
    expect(t.voice.isRecording).toBe(false);
  });

  it('a quiet spell ending the recogniser after dictation is a normal end: text stays, no complaint', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    FakeRecognition.last!.onresult!(speech(['hello']));
    FakeRecognition.last!.onerror!({ error: 'no-speech' });
    expect(t.voice.isRecording).toBe(false);
    expect(t.toasts).toEqual([]);
    expect(t.voice._insertText).toHaveBeenCalledTimes(1);
  });

  it('the engine ending by itself after phrases inserts nothing new and does not complain', () => {
    const t = boot(ANDROID_EDGE);
    t.voice.start();
    FakeRecognition.last!.onresult!(speech(['hello']));
    t.advance(6_000);
    FakeRecognition.last!.onend!();
    expect(t.voice._insertText).toHaveBeenCalledTimes(1);
    expect(t.toasts).toEqual([]);
  });

  it('compose mode keeps the editor holding everything dictated so far, replacing rather than appending', () => {
    const t = boot(ANDROID_EDGE);
    t.voice._getDeepgramConfig = () => ({ insertMode: 'compose' });
    t.voice.start();
    FakeRecognition.last!.onresult!(speech(['hello']));
    FakeRecognition.last!.onresult!(speech(['hello', ' world']));
    expect(t.voice._insertText.mock.calls.map((c: unknown[]) => c[0])).toEqual(['hello', 'hello world']);
  });

  it('a pause in an interim phrase does NOT end the session on Android, but still does on iOS (no finals there)', () => {
    const android = boot(ANDROID_EDGE);
    android.voice.start();
    FakeRecognition.last!.onresult!(speech([], 'testing'));
    android.advance(1_000);
    expect(android.voice.isRecording).toBe(true); // the 750 ms "stopped changing" rule is iOS-only

    const ios = boot(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );
    ios.voice.start();
    FakeRecognition.last!.onresult!(speech([], 'testing'));
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
