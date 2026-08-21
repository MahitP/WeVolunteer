import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isVoiceSupported, startDictation, VoiceError } from './voice.js';

/**
 * A stand-in for the browser's recogniser.
 *
 * jsdom has no `SpeechRecognition`, which is also the honest default state for
 * a good share of real browsers — so the unsupported path is the one that runs
 * without any setup here, and the supported path is driven explicitly.
 */
class FakeRecognition {
  constructor() {
    FakeRecognition.last = this;
    this.started = false;
    this.stopped = false;
  }

  start() {
    if (FakeRecognition.failStart) throw new Error('already started');
    this.started = true;
  }

  stop() { this.stopped = true; }

  /* Helpers the tests drive it with. */
  say(transcript, { isFinal = true } = {}) {
    this.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript }], { isFinal })],
    });
  }

  finish() { this.onend?.(); }
  fail(error) { this.onerror?.({ error }); }
}

function install() {
  FakeRecognition.last = null;
  FakeRecognition.failStart = false;
  window.SpeechRecognition = FakeRecognition;
}

afterEach(() => {
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
  vi.restoreAllMocks();
});

describe('support detection', () => {
  it('reports unsupported when the browser has no recogniser', () => {
    /* The default in jsdom, and the real state in browsers without it. The
       control simply does not appear. */
    expect(isVoiceSupported()).toBe(false);
  });

  it('accepts the vendor-prefixed constructor', () => {
    window.webkitSpeechRecognition = FakeRecognition;
    expect(isVoiceSupported()).toBe(true);
  });
});

describe('dictating', () => {
  beforeEach(install);

  it('returns what was said', async () => {
    const session = startDictation();
    FakeRecognition.last.say('find opportunities near me');
    FakeRecognition.last.finish();

    expect(await session.result).toBe('find opportunities near me');
  });

  it('asks for one utterance, not an open microphone', () => {
    /**
     * A control that keeps listening until told otherwise is a recording
     * device. This is a dictation box, and the difference is a property of the
     * request rather than of the interface around it.
     */
    startDictation();
    expect(FakeRecognition.last.continuous).toBe(false);
  });

  it('reports interim text only when somebody is listening for it', () => {
    const onInterim = vi.fn();
    startDictation({ onInterim });
    expect(FakeRecognition.last.interimResults).toBe(true);

    FakeRecognition.last.say('find opp', { isFinal: false });
    expect(onInterim).toHaveBeenCalledWith('find opp');
  });

  it('keeps the words when the person presses stop mid-sentence', async () => {
    /* Pressing stop should keep what was said, not discard it. */
    const session = startDictation();
    FakeRecognition.last.say('how many hours');
    session.stop();
    FakeRecognition.last.finish();

    expect(await session.result).toBe('how many hours');
  });

  it('resolves empty rather than failing when nothing was heard', async () => {
    const session = startDictation();
    FakeRecognition.last.finish();
    expect(await session.result).toBe('');
  });
});

describe('when it cannot listen', () => {
  beforeEach(install);

  it('treats a denied microphone as a decision, with a way forward', async () => {
    const session = startDictation();
    FakeRecognition.last.fail('not-allowed');

    const err = await session.result.catch(e => e);
    expect(err).toBeInstanceOf(VoiceError);
    expect(err.code).toBe('not-allowed');
    expect(err.message).toMatch(/permission/i);
    /* Every message ends with the alternative, because typing always works. */
    expect(err.message).toMatch(/type instead/i);
  });

  it('does not report an abort as a failure', async () => {
    /**
     * `aborted` is the person pressing stop. Showing an error would tell
     * somebody something went wrong when they were the one who ended it.
     */
    const session = startDictation();
    FakeRecognition.last.say('partial words');
    FakeRecognition.last.fail('aborted');

    await expect(session.result).resolves.toBe('partial words');
  });

  it.each([
    ['no-speech', /didn't catch/i],
    ['audio-capture', /no microphone/i],
    ['network', /connection/i],
    ['something-new', /unexpectedly/i],
  ])('explains %s', async (code, expected) => {
    const session = startDictation();
    FakeRecognition.last.fail(code);
    const err = await session.result.catch(e => e);

    expect(err.message).toMatch(expected);
    expect(err.message).toMatch(/type instead/i);
  });

  it('rejects rather than throwing when starting fails', async () => {
    FakeRecognition.failStart = true;
    const session = startDictation();
    await expect(session.result).rejects.toThrow(VoiceError);
    /* The handle is still usable, so a caller need not special-case it. */
    expect(() => session.stop()).not.toThrow();
  });

  it('rejects usably on a browser with no recogniser', async () => {
    delete window.SpeechRecognition;
    const session = startDictation();

    await expect(session.result).rejects.toThrow(/cannot do dictation/i);
    expect(() => session.stop()).not.toThrow();
  });
});
