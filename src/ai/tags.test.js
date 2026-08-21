import { describe, it, expect, vi } from 'vitest';
import { refineTagSuggestions, suggestTags, TAG_SCHEMA } from './tags.js';
import { MAX_TAGS_PER_EVENT } from '../eventTags.js';
import { MockRuntime } from './runtime/MockRuntime.js';

const VOCAB = [
  { tag: 'environment', label: 'Environment' },
  { tag: 'gardening', label: 'Gardening' },
  { tag: 'tutoring', label: 'Tutoring' },
];

async function readyRuntime(...responses) {
  const rt = new MockRuntime({ responses });
  await rt.load({ id: 'm', version: 1, bytes: 10 });
  return rt;
}

describe('preferring the spelling already in use', () => {
  it('replaces a variant with the existing tag', () => {
    /**
     * The one real harm a suggester can do is fragmentation — "Environment"
     * and "environment" splitting one idea across two filters and making both
     * worse. A proposal that normalises onto an existing tag adopts that tag's
     * spelling.
     */
    const out = refineTagSuggestions(['environment'], { vocabulary: VOCAB });
    expect(out).toEqual([{ tag: 'environment', label: 'Environment', existing: true }]);
  });

  it('passes a genuinely new tag through untouched', () => {
    /* Not a taxonomy: nothing is forbidden, and a word nobody has used before
       is offered as the model wrote it. */
    const out = refineTagSuggestions(['Native Plants'], { vocabulary: VOCAB });
    expect(out).toEqual([{ tag: 'native plants', label: 'Native Plants', existing: false }]);
  });

  it('marks which suggestions are already in use', () => {
    const out = refineTagSuggestions(['Gardening', 'Beekeeping'], { vocabulary: VOCAB });
    expect(out.map(t => t.existing)).toEqual([true, false]);
  });
});

describe('what gets dropped', () => {
  it('drops tags that say nothing on a volunteering platform', () => {
    /* Every opportunity here is volunteering, so a tag saying so distinguishes
       nothing and costs one of eight slots. Small models reach for these
       constantly. */
    const out = refineTagSuggestions(
      ['Volunteering', 'event', 'Community Service', 'Gardening'],
      { vocabulary: VOCAB },
    );
    expect(out.map(t => t.tag)).toEqual(['gardening']);
  });

  it('drops anything the server would refuse', () => {
    /**
     * Normalised with the server's own function, so a suggestion that could not
     * be saved is never offered. An organizer accepting a chip and then being
     * told on submit that it was never valid is the failure this prevents.
     */
    const out = refineTagSuggestions(
      ['ok tag', '', '   ', '###', 'x'.repeat(80), '!!!'],
      { vocabulary: [] },
    );
    expect(out.map(t => t.tag)).toEqual(['ok tag']);
  });

  it('drops duplicates, however they were spelled', () => {
    const out = refineTagSuggestions(
      ['Environment', 'environment', '#Environment', ' ENVIRONMENT '],
      { vocabulary: VOCAB },
    );
    expect(out).toHaveLength(1);
  });

  it('does not re-offer a tag the event already has', () => {
    const out = refineTagSuggestions(['Gardening', 'Tutoring'], {
      vocabulary: VOCAB,
      existing: [{ label: 'Gardening' }],
    });
    expect(out.map(t => t.tag)).toEqual(['tutoring']);
  });

  it('accepts existing tags given as plain strings', () => {
    const out = refineTagSuggestions(['Gardening'], { vocabulary: VOCAB, existing: ['gardening'] });
    expect(out).toEqual([]);
  });
});

describe('staying within what an event may hold', () => {
  it('never suggests more than the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => `topic ${i}`);
    expect(refineTagSuggestions(many, {}).length).toBeLessThanOrEqual(MAX_TAGS_PER_EVENT);
  });

  it('leaves room for the tags already there', () => {
    /**
     * Bounded by the limit minus what the event already has, so accepting every
     * suggestion cannot produce a set the server refuses.
     */
    const existing = ['a tag', 'b tag', 'c tag', 'd tag', 'e tag', 'f tag'];
    const out = refineTagSuggestions(
      Array.from({ length: 10 }, (_, i) => `new ${i}`),
      { existing },
    );
    expect(out.length).toBe(MAX_TAGS_PER_EVENT - existing.length);
    expect(out.length + existing.length).toBeLessThanOrEqual(MAX_TAGS_PER_EVENT);
  });

  it('suggests nothing when the event is already full', () => {
    const full = Array.from({ length: MAX_TAGS_PER_EVENT }, (_, i) => `tag ${i}`);
    expect(refineTagSuggestions(['another'], { existing: full })).toEqual([]);
  });

  it('handles junk input without throwing', () => {
    expect(refineTagSuggestions(null, {})).toEqual([]);
    expect(refineTagSuggestions(undefined, {})).toEqual([]);
    expect(refineTagSuggestions('not an array', {})).toEqual([]);
    expect(refineTagSuggestions([null, undefined, {}, []], {})).toEqual([]);
  });

  it('keeps a numeric tag, because the rules allow one', () => {
    /**
     * Not an oversight in the normaliser: its charset admits digits, and it has
     * to — "5K" is one of the event categories, and "#5k" is a tag an organizer
     * would reasonably write. Dropping numbers here would make the suggester
     * stricter than the form it feeds.
     */
    expect(refineTagSuggestions(['5K'], {})).toEqual([
      { tag: '5k', label: '5K', existing: false },
    ]);
  });
});

describe('asking the model', () => {
  const EVENT = {
    title: 'Native Plant Restoration',
    description: 'Help restore native plants and clear litter from the community park.',
  };

  it('constrains the reply to an array of strings', async () => {
    const rt = await readyRuntime(JSON.stringify({ tags: ['Environment', 'Gardening'] }));
    await suggestTags({ ...EVENT, runtime: rt, vocabulary: VOCAB });

    /* The grammar is what makes the reply parse. Without it a small model
       returns prose, numbering, or an object it invented. */
    expect(rt.calls[0].schema).toBe(TAG_SCHEMA);
  });

  it('refines whatever comes back', async () => {
    const rt = await readyRuntime(JSON.stringify({
      tags: ['environment', 'Volunteering', 'environment', 'Native Plants'],
    }));

    const out = await suggestTags({ ...EVENT, runtime: rt, vocabulary: VOCAB });
    expect(out.map(t => t.label)).toEqual(['Environment', 'Native Plants']);
  });

  it('sends the event text as delimited data', async () => {
    const rt = await readyRuntime('{"tags":[]}');
    await suggestTags({ ...EVENT, runtime: rt });
    expect(rt.calls[0].messages[0].content).toContain('OPPORTUNITY:');
    expect(rt.calls[0].messages[0].content).toContain('---');
  });
});

describe('failing quietly', () => {
  it('suggests nothing with no model', async () => {
    expect(await suggestTags({ title: 'x', description: 'y'.repeat(40), runtime: null })).toEqual([]);
  });

  it('suggests nothing when the model is not ready', async () => {
    expect(await suggestTags({ title: 'x', description: 'y'.repeat(40), runtime: new MockRuntime() }))
      .toEqual([]);
  });

  it('suggests nothing when the model throws', async () => {
    /**
     * This is a convenience on a form that works perfectly without it. An
     * organizer writing an event should never see an error about a suggestion
     * they did not ask for.
     */
    const rt = await readyRuntime();
    rt.generate = vi.fn().mockRejectedValue(new Error('worker died'));
    expect(await suggestTags({ title: 'Native Plants', description: 'Restore the park please.', runtime: rt }))
      .toEqual([]);
  });

  it('suggests nothing for an unparseable reply', async () => {
    const rt = await readyRuntime('sure! here are some tags: nature, plants');
    expect(await suggestTags({ title: 'Native Plants', description: 'Restore the park please.', runtime: rt }))
      .toEqual([]);
  });

  it('does not bother the model with almost no text', async () => {
    /* Nothing useful comes from three words, and asking costs a second of an
       organizer's time mid-sentence. */
    const rt = await readyRuntime('{"tags":["x"]}');
    expect(await suggestTags({ title: 'Park', description: '', runtime: rt })).toEqual([]);
    expect(rt.calls).toHaveLength(0);
  });
});
