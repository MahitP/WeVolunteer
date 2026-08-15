import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Organization tags, end to end.
 *
 * ── The bug this was written against ──
 *
 * Creating an organization with perfectly ordinary tags was refused with
 * "Each tag must be text of 40 characters or fewer", naming a limit none of
 * them came close to. Creating one with NO tags succeeded. So tags were
 * unusable, and the error pointed at the wrong thing entirely.
 *
 * The cause was a shape mismatch, not a length one. `TagInput` was built for
 * event tags and emits `{tag, label}` objects; `OrganizationForm` passed them
 * straight through; and the server's guard reads
 *
 *     payload.tags.some(t => typeof t !== 'string' || … || t.length > 40)
 *
 * so an object failed on the FIRST clause and reported the message attached to
 * the third. An empty array passed because `.some()` on nothing is false —
 * which is exactly why "no tags" appeared to work and hid the real fault.
 *
 * The tests below therefore do two jobs: they pin the length rule per tag, and
 * they pin that the server accepts what the editor actually produces.
 */

const ORGANIZER = 'jordan.whitfield@example.org';

describe('organization tags', () => {
  let srv;
  let organizer;
  let n = 0;

  beforeAll(async () => {
    srv = await startTestServer();
    organizer = await srv.login(ORGANIZER);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /** A distinct name per call; the slug is derived from it. */
  const create = (tags, over = {}) => {
    n += 1;
    return srv.call('POST', '/api/organizations', {
      name: `Test Org ${n} ${Math.random().toString(36).slice(2, 7)}`,
      description: 'An organization used by the tag tests.',
      ...(tags === undefined ? {} : { tags }),
      ...over,
    }, organizer);
  };

  const tagsOf = (res) => res.body?.organization?.tags;

  describe('the shape the editor actually produces', () => {
    it('accepts the three tags from the bug report', async () => {
      const res = await create(['Community Service', 'Food Drive', 'Environmental']);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(tagsOf(res)).toHaveLength(3);
    });

    it('accepts the {tag, label} objects TagInput emits', async () => {
      /**
       * The regression itself. `TagInput` is shared with the event editor and
       * emits objects; this is the shape the organization form sends when
       * somebody types into it.
       */
      const res = await create([
        { tag: 'community service', label: 'Community Service' },
        { tag: 'food drive', label: 'Food Drive' },
      ]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(tagsOf(res)).toHaveLength(2);
    });

    it('keeps the label a person typed, not the normalised key', async () => {
      const res = await create([{ tag: 'food drive', label: 'Food Drive' }]);
      expect(tagsOf(res)).toContain('Food Drive');
    });
  });

  describe('length is checked per tag, not on the whole collection', () => {
    it('accepts a tag of exactly 40 characters', async () => {
      const res = await create(['A'.repeat(40)]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('refuses a tag of 41 characters', async () => {
      const res = await create(['A'.repeat(41)]);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('tags');
    });

    it('accepts many short tags whose combined length far exceeds 40', async () => {
      /**
       * The assertion that distinguishes a per-tag check from one applied to
       * the serialised array. Six tags of ten characters is sixty characters of
       * text and a JSON string longer still, and every individual tag is well
       * inside the limit.
       */
      const res = await create(['Alphabetic', 'Bookbinding', 'Cataloguing', 'Deliveries', 'Environment', 'Fundraising']);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(tagsOf(res)).toHaveLength(6);
    });

    it('names the tag that was too long, rather than the whole field', async () => {
      const tooLong = 'B'.repeat(45);
      const res = await create(['Fine', tooLong]);
      expect(res.status).toBe(400);
      /* An organizer with eight tags and one mistake should not have to bisect
         their own input to find it. */
      expect(res.body.error).toContain(tooLong.slice(0, 20));
    });
  });

  describe('tidying', () => {
    it('trims surrounding whitespace', async () => {
      const res = await create(['  Food Drive  ']);
      expect(res.status).toBe(201);
      expect(tagsOf(res)).toContain('Food Drive');
    });

    it('refuses a tag that is only whitespace', async () => {
      const res = await create(['Fine', '   ']);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('tags');
    });

    it('drops a duplicate rather than refusing the whole submission', async () => {
      /* Two spellings of one thing is a typo, not an error worth stopping for. */
      const res = await create(['Food Drive', 'food drive', 'Environmental']);
      expect(res.status).toBe(201);
      expect(tagsOf(res)).toHaveLength(2);
    });

    it('refuses more tags than the limit', async () => {
      const res = await create(Array.from({ length: 20 }, (_, i) => `Tag${i}`));
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('tags');
    });
  });

  describe('no tags at all', () => {
    it('creates an organization when tags are omitted', async () => {
      const res = await create(undefined);
      expect(res.status).toBe(201);
      expect(tagsOf(res)).toEqual([]);
    });

    it('creates an organization with an explicitly empty list', async () => {
      const res = await create([]);
      expect(res.status).toBe(201);
      expect(tagsOf(res)).toEqual([]);
    });
  });

  it('reads the tags back on the organization page', async () => {
    const created = await create(['Community Service', 'Environmental']);
    const slug = created.body.organization.slug;

    const read = await srv.call('GET', `/api/organizations/${slug}`, undefined, organizer);
    expect(read.status).toBe(200);
    expect(read.body.organization.tags).toEqual(expect.arrayContaining(['Community Service', 'Environmental']));
  });
});
