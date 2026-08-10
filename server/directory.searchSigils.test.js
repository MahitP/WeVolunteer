import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * `@handle`, `#tag`, and plain text — three searches behind one field.
 *
 * ── What has to be true ──
 *
 * The whole value of a sigil is that it is EXCLUSIVE. `@ana` promises people and
 * nothing else; a single organization in that list makes the reader go back to
 * scanning, which is the work the sigil was supposed to remove. So the property
 * under test is not "does `@` find people" — it is "does `@` find ONLY people",
 * and the same for `#`.
 *
 * The malformed and hostile inputs are here for a plainer reason: this endpoint
 * takes a string from a text box, strips a character off the front, and puts the
 * rest into a LIKE pattern and a tag lookup. Every case below is something a
 * fourteen-year-old could type by accident or on purpose.
 */
describe('search sigils', () => {
  let srv, student;

  const search = (q, extra = '') => srv.call(
    'GET', `/api/directory/search?q=${encodeURIComponent(q)}${extra}`, undefined, student
  );

  beforeAll(async () => {
    srv = await startTestServer();
    student = await srv.login('leo.chen28@gmail.com');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /* ── @ means people ───────────────────────────────────────────────────── */

  describe('@ searches people and nothing else', () => {
    it('returns no organizations however many exist', async () => {
      const res = await search('@a');
      expect(res.status).toBe(200);
      expect(res.body.organizations).toEqual([]);
    });

    /**
     * The sigil outranks an explicitly requested type.
     *
     * `?q=@ana&type=organizations` asks two contradictory questions, and the one
     * the user typed is the more recent and more specific of the two. A caller
     * that could override it would let a stale scope tab silently reintroduce
     * the mixed list.
     */
    it('overrides a contradictory type parameter', async () => {
      const res = await search('@a', '&type=organizations');
      expect(res.status).toBe(200);
      expect(res.body.organizations).toEqual([]);
    });

    it('is case-insensitive on the handle', async () => {
      const lower = await search('@LEO');
      const upper = await search('@leo');
      expect(lower.status).toBe(200);
      expect(upper.status).toBe(200);
      expect(lower.body.users.map(u => u.id).sort())
        .toEqual(upper.body.users.map(u => u.id).sort());
    });

    /* A sigil with nothing after it is somebody mid-keystroke, not a request to
       match every account on the platform. */
    it('treats a bare @ as too short rather than as match-everything', async () => {
      const res = await search('@');
      expect(res.status).toBe(200);
      expect(res.body.tooShort).toBe(true);
      expect(res.body.users).toEqual([]);
    });

    it('returns nothing for a handle nobody has', async () => {
      const res = await search('@nobodyhasthishandleatall');
      expect(res.status).toBe(200);
      expect(res.body.users).toEqual([]);
    });
  });

  /* ── # means tagged things ────────────────────────────────────────────── */

  describe('# searches tagged things and never people', () => {
    it('returns no people', async () => {
      const res = await search('#food');
      expect(res.status).toBe(200);
      expect(res.body.users).toEqual([]);
    });

    it('returns no people even when the tag text matches somebody', async () => {
      /* 'leo' is a real handle on this seed. Under `#` it must find nothing,
         because people are not tagged — the sigil is a question about tags. */
      const res = await search('#leo');
      expect(res.status).toBe(200);
      expect(res.body.users).toEqual([]);
    });

    it('treats a bare # as too short', async () => {
      const res = await search('#');
      expect(res.status).toBe(200);
      expect(res.body.tooShort).toBe(true);
    });

    /* Normalisation has to agree with the client's, or `#Food Drive` finds the
       organization and none of its events. */
    it('normalises case and internal whitespace the same way', async () => {
      const a = await search('#Food Drive');
      const b = await search('#food  drive');
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.organizations.map(o => o.id).sort())
        .toEqual(b.body.organizations.map(o => o.id).sort());
    });

    it('returns an empty set for a tag nobody uses', async () => {
      const res = await search('#nosuchtaganywhere');
      expect(res.status).toBe(200);
      expect(res.body.organizations).toEqual([]);
    });
  });

  /* ── Plain search still mixes ─────────────────────────────────────────── */

  it('leaves an unprefixed search able to return both kinds', async () => {
    const res = await search('a');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(Array.isArray(res.body.organizations)).toBe(true);
  });

  /* ── Hostile and malformed input ──────────────────────────────────────── */

  describe('input that must not break it', () => {
    /**
     * None of these may 500, and none may return more than the sigil promises.
     * A 500 here is a stack trace in front of a student; a leaked row is the
     * exclusivity guarantee failing open.
     */
    const NASTY = [
      ['sql quote', "@' OR '1'='1"],
      ['sql comment', '@admin--'],
      ['sql union', "@' UNION SELECT * FROM users --"],
      ['like wildcards', '@%_%'],
      ['json injection', '@{"$ne":null}'],
      ['path traversal', '@../../etc/passwd'],
      ['angle brackets', '@<script>alert(1)</script>'],
      ['null byte', '@abc\0def'],
      ['newlines', '@abc\ndef'],
      ['unicode', '@日本語'],
      ['emoji', '@🎉🎉'],
      ['very long', `@${'a'.repeat(500)}`],
      ['url', '@https://evil.example/path?x=1'],
      ['double sigil', '@@ana'],
      ['sigil inside', '@an@a'],
      ['tag sql', "#' OR '1'='1"],
      ['tag wildcards', '#%_%'],
      ['tag unicode', '#日本語'],
      ['tag very long', `#${'b'.repeat(500)}`],
      ['whitespace only after sigil', '@    '],
      ['tag whitespace only', '#    '],
    ];

    for (const [label, q] of NASTY) {
      it(`survives ${label}`, async () => {
        const res = await search(q);
        expect(res.status, `${label} -> ${JSON.stringify(res.body)}`).toBe(200);

        /* The exclusivity promise holds even for input that matched nothing. */
        if (q.startsWith('@')) expect(res.body.organizations ?? []).toEqual([]);
        if (q.startsWith('#')) expect(res.body.users ?? []).toEqual([]);
      });
    }

    /** A wildcard must be matched literally, not expanded into "everything". */
    it('does not let LIKE wildcards match every account', async () => {
      const wildcard = await search('@%');
      const real = await search('@a');
      expect(wildcard.status).toBe(200);
      expect((wildcard.body.users ?? []).length)
        .toBeLessThanOrEqual((real.body.users ?? []).length);
    });
  });

  /* ── Authorization still applies ──────────────────────────────────────── */

  it('refuses an unauthenticated caller regardless of sigil', async () => {
    for (const q of ['@ana', '#food', 'ana']) {
      const res = await srv.call('GET', `/api/directory/search?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(401);
    }
  });
});
