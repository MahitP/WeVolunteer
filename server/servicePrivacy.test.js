import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Who may see somebody's service history and certificates.
 *
 * ── What this is guarding ──
 *
 * Certificates and hours default to PUBLIC, which is a product decision: being
 * able to see what somebody actually did is the point of a profile. The control
 * is that the subject can turn either of them off, and that turning it off
 * actually withholds the data at the SERVER — not in React, where a reader with
 * the network tab open sees everything the endpoint sent.
 *
 * So every case below drives the API directly. A test that rendered a component
 * and asserted a section was absent would pass against a server that had
 * already handed the data over.
 *
 * ── The two things that leak if this is done carelessly ──
 *
 * A COUNT. "Sam has 12 certificates" is most of what the setting exists to
 * withhold, so a private collection must not answer with an empty array and a
 * total either — it refuses.
 *
 * A DERIVED figure. Milestones are hours thresholds and the category breakdown
 * sums to the total, so publishing those while withholding `hours` hands the
 * reader the same fact by a longer route.
 */

let srv, db;
let alice, bob, staff;          // sessions
let aliceId, bobId;

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;

  const make = async (n) => {
    const { cookie, user } = await srv.signupConfirmed({
      name: `Privacy Person ${n}`,
      email: `privacy.person.${n}@example.org`,
      username: `privacyperson${n}`,
      password: 'Password123',
      role: 'student',
      grade: '11',
    });
    return { cookie, id: user.id };
  };

  const a = await make(1); alice = a.cookie; aliceId = a.id;
  const b = await make(2); bob = b.cookie; bobId = b.id;

  /* Somebody who legitimately holds `user.contact.read` — the capability that
     already names the power to see a student's particulars. The rule must not
     break applicant review or moderation. */
  staff = await srv.login('admin@example.gov').catch(() => null);

  /**
   * A completed shift for Alice, so there is something real to withhold.
   *
   * The event and its slot are created through the ORGANIZER API rather than by
   * hand-written SQL. An earlier version inserted them directly and tripped a
   * foreign key, which is the database being right: guessing at a schema in a
   * fixture is how a test ends up asserting against a shape production does not
   * have. Only the attendance row is written directly, because marking somebody
   * present is an organizer workflow with its own gates that are not what this
   * file is about.
   */
  const organizer = await srv.login('jordan.whitfield@example.org');
  const now = Date.now();
  const created = await srv.call('POST', '/api/events', {
    title: 'Park Cleanup', description: 'A morning by the river.', category: 'Other',
    location: 'Riverside Park',
    applicationDeadline: new Date(now + 2 * 864e5).toISOString(),
    slots: [{
      name: 'Morning', description: 'Setup and litter pick',
      startDatetime: new Date(now + 5 * 864e5).toISOString(),
      endDatetime: new Date(now + 5 * 864e5 + 72e5).toISOString(),
      maxSpots: 5,
    }],
  }, organizer);
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const eventId = created.body.id;
  const slotId = db.prepare('SELECT id FROM slots WHERE event_id = ?').get(eventId).id;

  /* No `id` column: `attendance` is keyed on (event_id, slot_id, user_id). */
  db.prepare(
    'INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, 1, 2)'
  ).run(eventId, slotId, aliceId);
});

afterAll(async () => { await srv.close(); });

const setVisibility = (patch, session) =>
  srv.call('PATCH', '/api/auth/profile', patch, session);

const publicProfileOf = (id, session) =>
  srv.call('GET', `/api/users/${id}/public-profile`, undefined, session);

const volunteerProfileOf = (id, session) =>
  srv.call('GET', `/api/users/${id}/profile`, undefined, session);

const certificatesOf = (id, session) =>
  srv.call('GET', `/api/users/${id}/certificates`, undefined, session);

/* ─────────────────────────── defaults ─────────────────────────── */

describe('the default is public', () => {
  it('a brand new account publishes hours and certificates', async () => {
    const res = await publicProfileOf(aliceId, bob);
    expect(res.status).toBe(200);
    const p = res.body.profile ?? res.body;
    expect(p.serviceVisibility).toEqual({ hours: 'visible', certificates: 'visible' });
    expect(p.stats, 'hours were withheld by default').toBeTruthy();
  });

  it('and the certificate collection answers', async () => {
    const res = await certificatesOf(aliceId, bob);
    expect(res.status).toBe(200);
    expect(res.body.certificates.length).toBeGreaterThan(0);
  });
});

/* ─────────────────────────── certificates ─────────────────────────── */

describe('certificates', () => {
  it('never carry the verification code to anybody but the owner', async () => {
    /**
     * The code is a BEARER CREDENTIAL: whoever holds it can call
     * `/api/certificates/verify/:code` and be handed a verified record in this
     * student's name. Publishing it would turn "see that Alice volunteered"
     * into "produce Alice's certificate on demand".
     */
    await setVisibility({ certificatesVisibility: 'public' }, alice);
    const res = await certificatesOf(aliceId, bob);
    expect(res.status).toBe(200);
    for (const c of res.body.certificates) {
      expect(c.code, 'a certificate code was published').toBeUndefined();
      /* Nor the location: where a named minor physically was on a given date is
         what the itemised service record is already gated on. */
      expect(c.location, 'an event location was published').toBeUndefined();
    }
    expect(JSON.stringify(res.body)).not.toMatch(/"code"/);
  });

  it('are refused — not emptied — when the owner makes them private', async () => {
    await setVisibility({ certificatesVisibility: 'private' }, alice);
    const res = await certificatesOf(aliceId, bob);

    /* A 200 with `[]` would say "Alice has none", which is false, and a 200
       with a total would leak the very count being withheld. */
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('certificates_private');
    expect(JSON.stringify(res.body)).not.toMatch(/Park Cleanup/);
  });

  it('leak no count through the public profile when private', async () => {
    const res = await publicProfileOf(aliceId, bob);
    const p = res.body.profile ?? res.body;
    expect(p.serviceVisibility.certificates).toBe('private');
    expect(JSON.stringify(p)).not.toMatch(/Park Cleanup/);
    expect(p.certificates, 'the profile carried a certificate list').toBeUndefined();
  });

  it('are still visible to the owner while private to everybody else', async () => {
    const mine = await certificatesOf(aliceId, alice);
    expect(mine.status).toBe(200);
    expect(mine.body.certificates.length).toBeGreaterThan(0);
    expect(mine.body.isSelf).toBe(true);

    /* And the owner's own printable route still carries the code. */
    const own = await srv.call('GET', '/api/certificates', undefined, alice);
    expect(own.status).toBe(200);
    expect(own.body[0].code, 'the owner lost their own certificate code').toBeTruthy();
  });

  it('cannot be reached by asking as somebody else', async () => {
    /* The IDOR shape: Bob knows Alice's id and asks on his own session. */
    const res = await certificatesOf(aliceId, bob);
    expect(res.status).toBe(403);
  });
});

/* ─────────────────────────── service hours ─────────────────────────── */

describe('service history', () => {
  it('is published by default and withheld when set to private', async () => {
    await setVisibility({ hoursVisibility: 'public' }, alice);
    let res = await publicProfileOf(aliceId, bob);
    let p = res.body.profile ?? res.body;
    expect(p.stats.hours).toBeGreaterThan(0);

    await setVisibility({ hoursVisibility: 'private' }, alice);
    res = await publicProfileOf(aliceId, bob);
    p = res.body.profile ?? res.body;

    /* OMITTED rather than zeroed. A zero is a claim about somebody, and it
       would be a false one. */
    expect(p.stats, 'stats survived a private setting').toBeUndefined();
    expect(p.lastVolunteeredAt).toBeUndefined();
    expect(p.serviceVisibility.hours).toBe('private');
  });

  it('withholds the DERIVED figures too, not just the total', async () => {
    /* Milestones are hours thresholds and the category breakdown sums to the
       total, so leaving either published hands the reader the same fact. */
    const res = await volunteerProfileOf(aliceId, bob);
    expect(res.status).toBe(200);
    expect(res.body.hoursVisible).toBe(false);
    expect(res.body.stats.hours).toBeNull();
    expect(res.body.byCategory).toEqual([]);
    expect(res.body.milestones).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/Riverside Park/);
  });

  it('is still visible to the owner', async () => {
    const res = await volunteerProfileOf(aliceId, alice);
    expect(res.body.hoursVisible).toBe(true);
    expect(res.body.stats.hours).toBeGreaterThan(0);
  });

  it('does not hide the record from staff who may already read particulars', async () => {
    /* Otherwise a privacy switch quietly breaks applicant review and
       moderation, which read this as part of a reviewed workflow. */
    if (!staff) return;
    const res = await volunteerProfileOf(aliceId, staff);
    expect(res.body.hoursVisible).toBe(true);
  });
});

/* ─────────────────────────── the transcript ─────────────────────────── */

describe('the transcript is nobody else’s business, at any setting', () => {
  it('refuses the itemised service record to another student', async () => {
    /**
     * This is the transcript's data source. Each row carries a past event's
     * title, its LOCATION and its exact times — for a fifteen-year-old, a
     * week-by-week record of where they have been.
     *
     * Asserted at BOTH endpoints that can return those rows, because two
     * endpoints returning the same data under different rules means the looser
     * one is the real policy.
     */
    await setVisibility({ hoursVisibility: 'public', certificatesVisibility: 'public' }, alice);

    const record = await srv.call('GET', `/api/users/${aliceId}/service-record`, undefined, bob);
    expect(record.status).toBe(403);

    const profile = await volunteerProfileOf(aliceId, bob);
    expect(profile.body.completed).toEqual([]);
    expect(profile.body.completedRedacted).toBe(true);
    expect(JSON.stringify(profile.body)).not.toMatch(/Riverside Park/);
  });

  it('is not unlocked by making hours public', async () => {
    /* The one thing a privacy setting must never do is GRANT access. Public
       hours mean the totals; they do not mean the whereabouts. */
    const record = await srv.call('GET', `/api/users/${aliceId}/service-record`, undefined, bob);
    expect(record.status).toBe(403);
  });

  it('is reachable by the owner', async () => {
    const record = await srv.call('GET', `/api/users/${aliceId}/service-record`, undefined, alice);
    expect(record.status).toBe(200);
  });
});

/* ─────────────────────────── the settings themselves ─────────────────────────── */

describe('the preferences persist and are validated', () => {
  it('stores private and reads it back', async () => {
    expect((await setVisibility({ certificatesVisibility: 'private' }, bob)).status).toBe(200);
    const me = await srv.call('GET', '/api/auth/me', undefined, bob);
    expect(me.body.certificatesVisibility).toBe('private');
  });

  it('stores public again', async () => {
    expect((await setVisibility({ certificatesVisibility: 'public' }, bob)).status).toBe(200);
    const me = await srv.call('GET', '/api/auth/me', undefined, bob);
    expect(me.body.certificatesVisibility).toBe('public');
  });

  it('keeps the two settings independent', async () => {
    await setVisibility({ hoursVisibility: 'private', certificatesVisibility: 'public' }, bob);
    const me = await srv.call('GET', '/api/auth/me', undefined, bob);
    expect(me.body.hoursVisibility).toBe('private');
    expect(me.body.certificatesVisibility).toBe('public');
  });

  it('refuses a value outside the closed set', async () => {
    /* Coercing instead of refusing would accept a typo and store the OPPOSITE
       of what the student chose — the one failure mode a privacy control must
       not have quietly. */
    const res = await setVisibility({ certificatesVisibility: 'friends' }, bob);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('certificatesVisibility');
  });

  it('cannot be set on somebody else’s account', async () => {
    await setVisibility({ hoursVisibility: 'public' }, bob);
    /* The route writes `WHERE id = req.user.id`, so there is no id to tamper
       with — asserted so a future edit cannot introduce one. */
    const res = await srv.call('PATCH', '/api/auth/profile',
      { hoursVisibility: 'private', id: aliceId, userId: aliceId }, bob);
    expect(res.status).toBe(200);
    const alicePrefs = await srv.call('GET', '/api/auth/me', undefined, alice);
    expect(alicePrefs.body.hoursVisibility, 'another account was rewritten').toBe('public');
  });
});

/* ─────────────────────── side channels ─────────────────────── */

describe('the setting is honoured on every surface, not just the profile', () => {
  it('drops a private student off the leaderboard', async () => {
    /**
     * The side channel this closes.
     *
     * The leaderboard is its own opt-in, so two settings could point opposite
     * ways: a student who joined it last term and has since set their hours to
     * "Only me" went on having their name and hour total published — through a
     * different endpoint from the one the privacy setting guards. A privacy
     * control that one endpoint honours and another does not is not a control.
     */
    await setVisibility({ hoursVisibility: 'public', leaderboardOptIn: true }, alice);

    const onBoard = async () => {
      const res = await srv.call('GET', '/api/leaderboard', undefined, bob);
      expect(res.status).toBe(200);
      return res.body.some(r => r.id === aliceId);
    };

    expect(await onBoard(), 'opting in did not put them on the board').toBe(true);

    await setVisibility({ hoursVisibility: 'private' }, alice);
    expect(await onBoard(), 'a private service history was published on the leaderboard').toBe(false);

    /* And it comes back, so this is a privacy control rather than a one-way door. */
    await setVisibility({ hoursVisibility: 'public' }, alice);
    expect(await onBoard()).toBe(true);
  });

  it('leaks nothing through the directory card', async () => {
    /* Directory rows are built by profileSummary, which carries no stats at
       all. Asserted so a future edit cannot add them without noticing. */
    await setVisibility({ hoursVisibility: 'private' }, alice);
    const res = await srv.call('GET', '/api/directory?q=Privacy', undefined, bob);
    if (res.status !== 200) return;
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/Riverside Park/);
    expect(body).not.toMatch(/"hours"/);
  });
});
