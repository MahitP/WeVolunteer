import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * An event tells you about YOUR ban, and nobody else's.
 *
 * ── Why the event carries this at all ──
 *
 * Being banned was communicated once, by notification, into a list that fills
 * up. Somebody who returns to an event a fortnight later and finds they cannot
 * take part deserves to learn why where they are standing, and to be able to
 * appeal without going hunting through notifications.
 *
 * ── The disclosure this must not become ──
 *
 * `viewerBan` names a ban and quotes its reason. Keyed on anything other than
 * the session it would be a way to ask "is this person banned from that club?"
 * about anybody, from a public-ish event page. It is keyed on `req.user.id` and
 * takes no parameter, and these tests are what hold that.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const BANNED = 'leo.chen@example.com';
const BYSTANDER = 'priya.patel@example.com';

describe('viewerBan on an event', () => {
  let srv; let db;
  let organizer; let banned; let bystander;
  let organizerId; let bannedId;
  let orgKey; let orgId; let eventId;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    organizer = await srv.login(ORGANIZER);
    banned = await srv.login(BANNED);
    bystander = await srv.login(BYSTANDER);

    const idOf = async (s) => (await srv.call('GET', '/api/auth/me', undefined, s)).body.id;
    organizerId = await idOf(organizer);
    bannedId = await idOf(banned);

    const created = await srv.call('POST', '/api/organizations', {
      name: `Ban Notice Org ${Math.random().toString(36).slice(2, 7)}`,
      description: 'An organization used by the event ban-notice tests.',
    }, organizer);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgKey = created.body.organization.slug;
    orgId = created.body.organization.id;

    /* An event belonging to that organization — the link the notice depends on. */
    const template = await db.prepare('SELECT * FROM events LIMIT 1').get();
    expect(template, 'no event to clone').toBeTruthy();
    eventId = 'evt-ban-notice';
    const row = { ...template, id: eventId, title: 'Ban notice fixture', status: 'open', organization_id: orgId, organizer_id: organizerId };
    const cols = Object.keys(row);
    await db.prepare(`INSERT INTO events (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map(c => row[c]));
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare('DELETE FROM organization_bans WHERE organization_id = ?').run(orgId);
    await db.prepare("UPDATE appeals SET status = 'resolved' WHERE user_id = ? AND status IN ('open','reviewing')").run(bannedId);
  });

  const ban = async () => {
    await db.prepare(`INSERT INTO organization_bans (id, organization_id, user_id, banned_by, reason, created_at)
                VALUES ('ban-notice-1', ?, ?, ?, 'Repeatedly no-showed shifts.', ?)`)
      .run(orgId, bannedId, organizerId, new Date().toISOString());
  };

/**
   * Read from the LIST, not from `GET /api/events/:id`.
   *
   * That single-event route is host-gated — "Access denied: You do not host
   * this event" — so a volunteer never reaches it. The event modal is opened
   * from the browse list and renders the object the list supplied, which is
   * where the field has to be for anybody to see it. The first draft of these
   * tests read the host route and failed against a working feature.
   */
  const fetchEvent = async (session) => {
    const res = await srv.call('GET', '/api/events?scope=listable&limit=60&offset=0', undefined, session);
    return {
      status: res.status,
      body: { event: (res.body.events || []).find(e => e.id === eventId) },
      raw: res.body,
    };
  };

  it('says nothing when the reader is not banned', async () => {
    const res = await fetchEvent(banned);
    expect(res.status, JSON.stringify(res.body).slice(0, 150)).toBe(200);
    expect(res.body.event.viewerBan).toBeNull();
  });

  it('tells a banned reader that they are, and why', async () => {
    await ban();
    const res = await fetchEvent(banned);
    expect(res.body.event.viewerBan).toMatchObject({ banned: true, reason: 'Repeatedly no-showed shifts.' });
  });

  it('says NOTHING about that ban to anybody else', async () => {
    /**
     * The disclosure. A bystander opening the same event must not learn that
     * somebody else is banned, nor read the reason — which names conduct.
     */
    await ban();
    const res = await fetchEvent(bystander);
    expect(res.body.event.viewerBan).toBeNull();
    expect(JSON.stringify(res.raw), 'the reason leaked into somebody else\'s response').not.toMatch(/no-showed/);
  });

  it('says nothing to the organizer who issued it either, on this surface', async () => {
    /* Managers read bans through the organization's own authorized surfaces.
       This field answers "am I banned", and the organizer is not. */
    await ban();
    const res = await fetchEvent(organizer);
    expect(res.body.event.viewerBan).toBeNull();
  });

  it('stops mentioning it once the ban is lifted', async () => {
    await ban();
    await db.prepare('UPDATE organization_bans SET lifted_at = ? WHERE organization_id = ? AND user_id = ?')
      .run(new Date().toISOString(), orgId, bannedId);
    const res = await fetchEvent(banned);
    expect(res.body.event.viewerBan).toBeNull();
  });

  it('carries an appeal already filed, so a second is not offered', async () => {
    await ban();
    const filed = await srv.call('POST', '/api/appeals', {
      subject: 'organization_ban',
      organizationId: orgId,
      statement: 'Two of those shifts were cancelled and nobody told me.',
    }, banned);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const res = await fetchEvent(banned);
    expect(res.body.event.viewerBan.appeal).toMatchObject({ id: filed.body.appealId, status: 'open' });
  });

  it('carries the outcome once that appeal has been decided', async () => {
    await ban();
    const filed = await srv.call('POST', '/api/appeals', {
      subject: 'organization_ban', organizationId: orgId,
      statement: 'Two of those shifts were cancelled and nobody told me.',
    }, banned);
    await srv.call('POST', `/api/organizations/${orgKey}/appeals/${filed.body.appealId}/decision`,
      { decision: 'stands', reasoning: 'The shifts were not cancelled by us.' }, organizer);

    const res = await fetchEvent(banned);
    expect(res.body.event.viewerBan.appeal).toMatchObject({ status: 'resolved', decision: 'stands' });
  });

  it('says nothing to a reader with no session at all', async () => {
    await ban();
    const res = await fetchEvent();
    /* The list itself requires a session, so the field is unreachable without
       one — but assert on the outcome rather than on the mechanism, since a
       future public list must still not carry somebody else's ban. */
    if (res.status === 200) expect(res.body.event?.viewerBan ?? null).toBeNull();
    else expect([401, 403]).toContain(res.status);
  });

  it('says nothing on an event that belongs to no organization', async () => {
    /* There is no ban to speak of, and the absence must not be an error. */
    await ban();
    await db.prepare('UPDATE events SET organization_id = NULL WHERE id = ?').run(eventId);
    try {
      const res = await fetchEvent(banned);
      expect(res.status).toBe(200);
      expect(res.body.event.viewerBan).toBeNull();
    } finally {
      await db.prepare('UPDATE events SET organization_id = ? WHERE id = ?').run(orgId, eventId);
    }
  });
});
