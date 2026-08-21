import { describe, it, expect } from 'vitest';
import { MockRuntime } from './MockRuntime.js';
import { AIStatus, AIRuntimeError, AIAbortError, isAbort } from './types.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MODEL = { id: 'test', version: 1, bytes: 1000 };

/**
 * The mock is test infrastructure, so it gets tested. Every later phase asserts
 * against its behaviour — if it silently stopped honouring an abort signal, a
 * dozen cancellation tests would pass while the feature was broken.
 */
describe('load', () => {
  it('moves through downloading and loading to ready', async () => {
    const rt = new MockRuntime();
    expect(rt.status).toBe(AIStatus.IDLE);

    await rt.load(MODEL);
    expect(rt.status).toBe(AIStatus.READY);
    expect(rt.model).toBe(MODEL);
  });

  it('reports determinate progress that ends at the model size', async () => {
    const seen = [];
    await new MockRuntime({ progressSteps: 4 }).load(MODEL, { onProgress: p => seen.push(p) });

    expect(seen).toHaveLength(4);
    expect(seen.at(-1)).toEqual({ loaded: 1000, total: 1000 });
    /* Monotonic: a progress bar that goes backwards reads as a stall. */
    expect(seen.map(p => p.loaded)).toEqual([...seen.map(p => p.loaded)].sort((a, b) => a - b));
  });

  it('does no work and stays idle when the signal is already aborted', async () => {
    /* Rejecting before touching any state matters: leaving the runtime in
       DOWNLOADING would show a progress bar for a load that never started, and
       nothing would ever move it off. */
    const rt = new MockRuntime();
    await expect(rt.load(MODEL, { signal: AbortSignal.abort() })).rejects.toThrow(AIAbortError);

    expect(rt.loadCount).toBe(0);
    expect(rt.status).toBe(AIStatus.IDLE);
    expect(rt.model).toBeNull();
  });

  it('stops partway through a download when cancelled', async () => {
    /* The case that matters: a student pressing Cancel during a 500 MB
       download must actually stop it, not merely stop being shown it. */
    const controller = new AbortController();
    const rt = new MockRuntime({ progressSteps: 10 });
    let ticks = 0;

    const load = rt.load(MODEL, {
      signal: controller.signal,
      onProgress: () => { ticks += 1; if (ticks === 3) controller.abort(); },
    });

    await expect(load).rejects.toThrow(AIAbortError);
    expect(ticks).toBe(3);
  });

  it('records the error and enters the error state when loading fails', async () => {
    const boom = new AIRuntimeError('no');
    const rt = new MockRuntime({ failLoadWith: boom });

    await expect(rt.load(MODEL)).rejects.toBe(boom);
    expect(rt.status).toBe(AIStatus.ERROR);
    expect(rt.lastError).toBe(boom);
  });
});

describe('generate', () => {
  it('refuses to run before a model is loaded', async () => {
    await expect(new MockRuntime().generate([])).rejects.toThrow(AIRuntimeError);
  });

  it('returns the scripted reply and restores the ready state', async () => {
    const rt = new MockRuntime().queue('Hello there.');
    await rt.load(MODEL);

    expect(await rt.generate([{ role: 'user', content: 'hi' }])).toBe('Hello there.');
    expect(rt.status).toBe(AIStatus.READY);
  });

  it('streams tokens that reassemble into exactly the reply', async () => {
    const rt = new MockRuntime().queue('one two three');
    await rt.load(MODEL);

    const tokens = [];
    const full = await rt.generate([], { onToken: t => tokens.push(t) });

    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join('')).toBe(full);
    expect(full).toBe('one two three');
  });

  it('returns replies in the order they were queued', async () => {
    const rt = new MockRuntime().queue('first', 'second');
    await rt.load(MODEL);

    expect(await rt.generate([])).toBe('first');
    expect(await rt.generate([])).toBe('second');
  });

  it('returns parseable JSON by default when a schema was requested', async () => {
    /* Callers that pass a schema always JSON.parse the result. An unscripted
       call must not hand them prose. */
    const rt = new MockRuntime();
    await rt.load(MODEL);

    const reply = await rt.generate([], { schema: { type: 'object' } });
    expect(() => JSON.parse(reply)).not.toThrow();
  });

  it('records the schema and token ceiling it was called with', async () => {
    const rt = new MockRuntime().queue('{}');
    await rt.load(MODEL);

    const schema = { type: 'object', properties: { hours: { type: 'number' } } };
    await rt.generate([{ role: 'user', content: 'x' }], { schema, maxTokens: 64 });

    expect(rt.calls).toHaveLength(1);
    expect(rt.calls[0].schema).toBe(schema);
    expect(rt.calls[0].maxTokens).toBe(64);
  });

  it('returns to ready after cancellation, not to error', async () => {
    /**
     * Pressing Stop is not a failure. Landing in the error state would show a
     * student something went wrong when they were the one who ended it, and
     * would need clearing before the next question.
     */
    const controller = new AbortController();
    const rt = new MockRuntime().queue('a b c d e f');
    await rt.load(MODEL);

    let n = 0;
    const gen = rt.generate([], {
      signal: controller.signal,
      onToken: () => { n += 1; if (n === 2) controller.abort(); },
    });

    const err = await gen.catch(e => e);
    expect(isAbort(err)).toBe(true);
    expect(rt.status).toBe(AIStatus.READY);
  });
});

describe('unload', () => {
  it('releases the model and returns to idle', async () => {
    const rt = new MockRuntime();
    await rt.load(MODEL);
    await rt.unload();

    expect(rt.status).toBe(AIStatus.IDLE);
    expect(rt.model).toBeNull();
    expect(rt.unloadCount).toBe(1);
  });
});

describe('isAbort', () => {
  it('recognises both our abort and the platform one', () => {
    /* wllama raises its own AbortError; ours is separate. Callers must be able
       to swallow either without a runtime-specific check. */
    expect(isAbort(new AIAbortError())).toBe(true);
    expect(isAbort(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbort(new AIRuntimeError('real failure'))).toBe(false);
  });
});

/**
 * The sampler and cache settings the real runtime sends, asserted against the
 * source because a MockRuntime cannot exercise llama.cpp.
 *
 * These are not style preferences. Each was set in response to a measured
 * failure with the real model, and each is the kind of line somebody
 * reasonably "tidies up" later without knowing what it was for.
 */
describe('WllamaRuntime generation parameters', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'src/ai/runtime/WllamaRuntime.js'),
    'utf8',
  );

  it('records the streamed-chunk defect where somebody will find it', () => {
    /* Intermittently the final chunk of a generation is delivered at the start
       of the next one, so a reply loses its last characters and the following
       one opens with them. Four fixes were tried and measured; none worked, and
       the residue is inside wllama's worker. The note is the deliverable — the
       next person to see a stray leading character should find the four dead
       ends rather than repeat them, or reach for the text-stripping rule that
       damaged correct replies last time. */
    expect(src).toMatch(/known defect in streamed generation/i);
    expect(src).toMatch(/cache_prompt: false/);
    expect(src).toMatch(/11\.5 seconds/);
  });

  it('leaves the repetition penalties at llama.cpp defaults', () => {
    /* They apply to every token in the window, and the tokens English repeats
       most are the punctuation and function words. Tuned against repetition,
       they remove punctuation first. */
    expect(src).toMatch(/penalty_repeat:\s*1(\.0)?\b/);
    expect(src).toMatch(/penalty_freq:\s*0\b/);
    expect(src).toMatch(/penalty_present:\s*0\b/);
  });

  it('sets the temperature under the name the sampler reads', () => {
    /* `temp`, not `temperature`: the latter is the OAI-compatibility alias and
       setting only it means the sampler runs at a value nobody chose. */
    expect(src).toMatch(/\btemp:\s*schema \? 0\.2 : 0\.45/);
  });

  it('reports why a generation ended', () => {
    /* So a reply cut off by the token budget can be labelled as cut off
       instead of looking like a bug. */
    expect(src).toMatch(/lastFinishReason/);
  });
});
