import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Resolving ONE event by id through the browse endpoint.
 *
 * ── The defect this exists for ──
 *
 * 23 notification kinds emit `link: event:<id>`
 * (`services/notificationContent.js`), and the client resolved that id purely
 * against local caches: the SessionProvider index, which is fetched with
 * `{mine: 'true'}` for anybody without `event.moderate`, plus whatever a browse
 * surface happened to render this session. Two of those kinds are *by
 * definition* about an event the recipient is not part of —
 *
 *   FRIEND_SIGNED_UP          "… signed up for X. There may still be places."
 *   ORGANIZATION_EVENT_POSTED "X is open for applications."
 *
 * — so from a cold load the answer was "That event is no longer available." for
 * a live, open event. The email CTA for every one of the 23,
 * `${APP_URL}/?event=<id>` (`workers/notificationWorker.js`), resolves through
 * the same code and rendered nothing at all.
 *
 * ── Why the fix is a filter on THIS endpoint ──
 *
 * `GET /api/events/:id` cannot be used: it is staff-only and answers 403 to a
 * student. Adding a second single-event read would mean a second authorization
 * path to keep in step with this one — and this one is where the per-card
 * disclosure rules live, including blanking arrival instructions for anybody
 * who is not going.
 *
 * So `?id=` NARROWS this query and changes nothing else. The clause AND-s with
 * every other predicate, the same serialiser runs, and the same
 * `canSeeInstructions` decision is made. It grants no read that paging the list
 * did not already grant, which is the property the cases below pin from both
 * directions.
 */

let srv, organizer, student, other;
let eventId;

beforeAll(async () => {
  srv = await startTestServer();
  organizer = await srv.login('jordan.whitfield@example.org');
  student = await srv.login('leo.chen@example.com');
  if (!organizer || !student) throw new Error('seeded logins failed — check the addresses');

  const iso = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  const created = await srv.call('POST', '/api/events', {
    title: 'Riverbank Litter Sweep',
    description: 'Bags and gloves provided.',
    category: 'Other',
    location: 'Reichler Park',
    instructions: 'Meet at the blue gate behind the maintenance shed.',
    applicationDeadline: iso(60 * 24 * 3),
    slots: [{
      name: 'Morning', description: 'd',
      startDatetime: iso(60 * 24 * 5),
      endDatetime: iso(60 * 24 * 5 + 120),
      maxSpots: 4,
    }],
  }, organizer);
  expect(created.status, 'the fixture event was not created').toBe(201);
  eventId = created.body?.event?.id ?? created.body?.id;
  expect(eventId, 'the create response carried no event id').toBeTruthy();
}, 90000);

afterAll(async () => { await srv?.close(); });

const byId = (id, who, extra = '') =>
  srv.call('GET', `/api/events?id=${encodeURIComponent(id)}&scope=all&limit=1${extra}`, undefined, who);

describe('a student who is not involved can resolve the event a notification names', () => {
  /**
   * THE case. Leo has not applied, is not the host, has not favourited it, and
   * has no attendance — so this event is absent from his `mine=true` index, and
   * on a cold load his `seenEvents` is empty. Both discovery notifications and
   * every notification email land here.
   */
  it('returns exactly that event', async () => {
    const res = await byId(eventId, student);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].id).toBe(eventId);
    expect(res.body.events[0].title).toBe('Riverbank Litter Sweep');
  });

  it('is genuinely absent from the index the client would have consulted', async () => {
    /* The control. Without it the case above could pass against an index that
       already contained the event, and would prove nothing about the defect. */
    const mine = await srv.call('GET', '/api/events?mine=true&scope=all&limit=200', undefined, student);
    expect(mine.status).toBe(200);
    expect(mine.body.events.some(e => e.id === eventId)).toBe(false);
  });

  it('carries the fields the modal needs, not a stub', async () => {
    const res = await byId(eventId, student);
    const ev = res.body.events[0];
    expect(Array.isArray(ev.slots), 'no slots — the modal would say "No shifts yet"').toBe(true);
    expect(ev.slots.length).toBeGreaterThan(0);
    expect(ev).toHaveProperty('viewerBan');
  });
});

describe('what the id filter must NOT do', () => {
  it('withholds arrival instructions from somebody who is not going', async () => {
    /**
     * The disclosure rule this endpoint owns. `canSeeInstructions` is
     * `event.moderate || host || accepted`, and resolving by id must not be a
     * way around it — otherwise a notification link becomes an instructions
     * oracle for every signed-in account.
     */
    const res = await byId(eventId, student);
    expect(res.body.events[0].instructions).toBe('');
  });

  it('still gives them to the host, so the blanking is scoping and not removal', async () => {
    const res = await byId(eventId, organizer);
    expect(res.body.events[0].instructions).toContain('blue gate');
  });

  it('matches nothing for an id that does not exist, rather than everything', async () => {
    /**
     * Fail closed. An `id` that silently fell through to "no filter" would turn
     * a mistyped notification link into a dump of the whole table — the same
     * failure `restrictToSemanticIds` is written to avoid for candidate lists.
     */
    const res = await byId('no-such-event-id', student);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it('refuses an unauthenticated caller, exactly as browsing does', async () => {
    const res = await srv.call('GET', `/api/events?id=${eventId}&scope=all&limit=1`);
    expect(res.status).toBe(401);
  });

  it('AND-s with the other filters rather than overriding them', async () => {
    /* A narrowed query is still a query. An event that does not match the
       other predicates must not reappear because an id was named. */
    const res = await srv.call(
      'GET', `/api/events?id=${encodeURIComponent(eventId)}&scope=all&limit=1&q=zzz-no-such-text`,
      undefined, student,
    );
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(0);
  });
});

describe('the notification kinds that could not resolve', () => {
  /**
   * Both emit `link: event:<id>` and both are addressed to somebody who is not
   * involved, which is the whole point of them. These assert the link the
   * server builds and that the id in it resolves for that recipient — the two
   * halves that were never connected.
   */
  it('FRIEND_SIGNED_UP names an event its recipient can now resolve', async () => {
    const { getInAppContent } = await import('./services/notificationContent.js');
    const content = getInAppContent('FRIEND_SIGNED_UP', {
      actorName: 'Priya', eventTitle: 'Riverbank Litter Sweep', eventId,
    });
    expect(content.link).toBe(`event:${eventId}`);

    const res = await byId(content.link.slice('event:'.length), student);
    expect(res.body.events, 'the friend notification still leads nowhere').toHaveLength(1);
  });

  it('ORGANIZATION_EVENT_POSTED names an event its recipient can now resolve', async () => {
    const { getInAppContent } = await import('./services/notificationContent.js');
    const content = getInAppContent('ORGANIZATION_EVENT_POSTED', {
      organizationName: 'Key Club', eventTitle: 'Riverbank Litter Sweep', eventId,
    });
    expect(content.link).toBe(`event:${eventId}`);

    const res = await byId(content.link.slice('event:'.length), student);
    expect(res.body.events, 'the organization notification still leads nowhere').toHaveLength(1);
  });

  it('the email CTA points at the same id, through the same resolution', async () => {
    /**
     * `workers/notificationWorker.js` turns any `event:` link into
     * `${APP_URL}/?event=<id>`, which the client resolves with the very code
     * path the cases above exercise. Asserting the id rather than the origin,
     * because APP_URL is environment-dependent and the id is the part that was
     * broken.
     */
    const { getInAppContent } = await import('./services/notificationContent.js');
    const content = getInAppContent('ORGANIZATION_EVENT_POSTED', {
      organizationName: 'Key Club', eventTitle: 'Riverbank Litter Sweep', eventId,
    });
    const ctaId = content.link.split(':')[1];
    expect(ctaId).toBe(eventId);

    const res = await byId(ctaId, student);
    expect(res.body.events[0].id).toBe(eventId);
  });
});
