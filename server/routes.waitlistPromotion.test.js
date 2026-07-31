import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Regression cover for the P0 audit finding: the waitlist did nothing on
 * manually-managed events.
 *
 * All three promotion sites were gated on the event's Auto Select flag:
 *
 *     const event = db.prepare('SELECT auto_approve FROM events WHERE id = ?')…
 *     if (event && event.auto_approve === 1) handleWaitlistPromotion(…)
 *
 * `auto_approve` selects how volunteers are CHOSEN (weighted draw after the
 * deadline vs. organizer judgement). It says nothing about whether a freed spot
 * should be filled. Tying promotion to it meant that on every organizer-managed
 * event — the default — a confirmed volunteer releasing their spot left the
 * shift under capacity with someone waiting on it, and told neither of them.
 * Measured during the audit: max_spots=1, accepted=0, waitlisted=1.
 *
 * A second defect compounded it: `waitlist_order` was never assigned on the
 * manual paths (every write set it to NULL), so even when promotion did run its
 * `ORDER BY waitlist_order ASC` had no defined order and "first in line" was
 * arbitrary.
 *
 * Promotion now depends on capacity, queue order, and application state — never
 * on the selection method.
 */

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const ORG = 'jkatzenback@vikings.org';

/** Creates an open event with one shift of `maxSpots`, returning ids. */
async function makeEvent({ maxSpots, autoApprove = false, dayOffset = 60, title = 'Waitlist Test' }) {
  const orgToken = await srv.login(ORG);
  const start = new Date(Date.now() + dayOffset * 864e5).toISOString();
  const end = new Date(Date.now() + dayOffset * 864e5 + 108e5).toISOString();
  const mk = await srv.call('POST', '/api/events', {
    title, description: 'd', category: 'Other', location: 'Hall',
    applicationDeadline: new Date(Date.now() + (dayOffset - 10) * 864e5).toISOString(),
    autoApprove,
    slots: [{ name: 'Shift', description: 'd', startDatetime: start, endDatetime: end, maxSpots }]
  }, orgToken);
  expect(mk.status, JSON.stringify(mk.body)).toBe(201);
  const eventId = mk.body.id;
  const detail = await srv.call('GET', `/api/events/${eventId}`, undefined, orgToken);
  return { orgToken, eventId, slotId: detail.body.event.slots[0].id };
}

/** Applies as each student, returning their application rows keyed by email. */
async function applyAll(eventId, slotId, emails) {
  const out = {};
  for (const email of emails) {
    const token = await srv.login(email);
    const res = await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, token);
    expect(res.status, `${email} apply: ${JSON.stringify(res.body)}`).toBe(201);
    out[email] = { token, appId: res.body.application.id };
  }
  return out;
}

const statusOf = async (orgToken, eventId, appId) => {
  const d = await srv.call('GET', `/api/events/${eventId}`, undefined, orgToken);
  return d.body.applications.find(a => a.id === appId)?.status;
};

const acceptedCount = async (orgToken, eventId) => {
  const d = await srv.call('GET', `/api/events/${eventId}`, undefined, orgToken);
  return d.body.applications.filter(a => a.status === 'accepted').length;
};

describe('waitlist promotion on an ORGANIZER-MANAGED event (autoApprove off)', () => {
  let ctx, cast;

  beforeAll(async () => {
    ctx = await makeEvent({ maxSpots: 1, autoApprove: false, dayOffset: 60 });
    cast = await applyAll(ctx.eventId, ctx.slotId, ['leo.chen28@gmail.com', 'priya.patel.nhs@outlook.com']);
    await srv.call('PATCH', `/api/applications/${cast['leo.chen28@gmail.com'].appId}`, { status: 'accepted' }, ctx.orgToken);
    await srv.call('PATCH', `/api/applications/${cast['priya.patel.nhs@outlook.com'].appId}`, { status: 'waitlisted' }, ctx.orgToken);
  });

  it('assigns a waitlist_order when the organizer waitlists someone', async () => {
    const apps = (await srv.call('GET', '/api/applications', undefined, cast['priya.patel.nhs@outlook.com'].token)).body;
    const mine = apps.find(a => a.id === cast['priya.patel.nhs@outlook.com'].appId);
    expect(mine.status).toBe('waitlisted');
    expect(mine.waitlistOrder, 'waitlist position must be defined, not NULL').toBe(1);
  });

  // The core regression: this is the exact scenario from the audit brief.
  it('promotes the waitlisted volunteer when the accepted one withdraws', async () => {
    const res = await srv.call(
      'PATCH', `/api/applications/${cast['leo.chen28@gmail.com'].appId}`,
      { status: 'withdrawn' }, cast['leo.chen28@gmail.com'].token
    );
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(true);

    expect(await statusOf(ctx.orgToken, ctx.eventId, cast['priya.patel.nhs@outlook.com'].appId)).toBe('accepted');
  });

  it('keeps the slot count correct after promotion', async () => {
    expect(await acceptedCount(ctx.orgToken, ctx.eventId)).toBe(1);
  });

  it('clears waitlist_order on the promoted application', async () => {
    const apps = (await srv.call('GET', '/api/applications', undefined, cast['priya.patel.nhs@outlook.com'].token)).body;
    const mine = apps.find(a => a.id === cast['priya.patel.nhs@outlook.com'].appId);
    expect(mine.waitlistOrder == null).toBe(true);
  });

  it('notifies the promoted volunteer with real copy, not a fallback', async () => {
    const notifs = (await srv.call('GET', '/api/notifications', undefined, cast['priya.patel.nhs@outlook.com'].token)).body;
    const list = Array.isArray(notifs) ? notifs : notifs.notifications;
    const promoted = list.find(n => /spot|promot/i.test(n.title));
    expect(promoted, `no promotion notice in ${JSON.stringify(list.map(n => n.title))}`).toBeTruthy();
    expect(promoted.title).not.toBe('Notification');
    expect(promoted.link).toBeTruthy();
  });
});

describe('waitlist promotion on an AUTO SELECT event still works', () => {
  let ctx, cast;

  beforeAll(async () => {
    ctx = await makeEvent({ maxSpots: 1, autoApprove: true, dayOffset: 70, title: 'Auto Waitlist Test' });
    cast = await applyAll(ctx.eventId, ctx.slotId, ['emiller2027@gmail.com', 'ncarbin@comcast.net']);
    await srv.call('PATCH', `/api/applications/${cast['emiller2027@gmail.com'].appId}`, { status: 'accepted' }, ctx.orgToken);
    await srv.call('PATCH', `/api/applications/${cast['ncarbin@comcast.net'].appId}`, { status: 'waitlisted' }, ctx.orgToken);
  });

  it('promotes on withdrawal', async () => {
    await srv.call('PATCH', `/api/applications/${cast['emiller2027@gmail.com'].appId}`,
      { status: 'withdrawn' }, cast['emiller2027@gmail.com'].token);
    expect(await statusOf(ctx.orgToken, ctx.eventId, cast['ncarbin@comcast.net'].appId)).toBe('accepted');
  });
});

describe('waitlist ordering with MULTIPLE waiting volunteers', () => {
  let ctx, cast;
  const A = 'diana.sanger@gmail.com', B = 'mpolizzotto@outlook.com', C = 'aburnett@gmail.com', D = 'dsanger@outlook.com';

  beforeAll(async () => {
    ctx = await makeEvent({ maxSpots: 1, autoApprove: false, dayOffset: 80, title: 'FIFO Waitlist Test' });
    cast = await applyAll(ctx.eventId, ctx.slotId, [A, B, C, D]);
    await srv.call('PATCH', `/api/applications/${cast[A].appId}`, { status: 'accepted' }, ctx.orgToken);
    // Waitlisted in order B, C, D.
    for (const e of [B, C, D]) {
      await srv.call('PATCH', `/api/applications/${cast[e].appId}`, { status: 'waitlisted' }, ctx.orgToken);
    }
  });

  it('numbers the queue 1, 2, 3 in the order they were waitlisted', async () => {
    const orders = {};
    for (const e of [B, C, D]) {
      const apps = (await srv.call('GET', '/api/applications', undefined, cast[e].token)).body;
      orders[e] = apps.find(a => a.id === cast[e].appId).waitlistOrder;
    }
    expect(orders[B]).toBe(1);
    expect(orders[C]).toBe(2);
    expect(orders[D]).toBe(3);
  });

  it('promotes strictly the first in line (FIFO), not an arbitrary row', async () => {
    await srv.call('PATCH', `/api/applications/${cast[A].appId}`, { status: 'withdrawn' }, cast[A].token);
    expect(await statusOf(ctx.orgToken, ctx.eventId, cast[B].appId)).toBe('accepted');
    expect(await statusOf(ctx.orgToken, ctx.eventId, cast[C].appId)).toBe('waitlisted');
    expect(await statusOf(ctx.orgToken, ctx.eventId, cast[D].appId)).toBe('waitlisted');
  });

  it('closes the gap in the queue after a promotion', async () => {
    const apps = (await srv.call('GET', '/api/applications', undefined, cast[C].token)).body;
    expect(apps.find(a => a.id === cast[C].appId).waitlistOrder).toBe(1);
  });

  it('does not overfill: a single freed spot promotes exactly one person', async () => {
    expect(await acceptedCount(ctx.orgToken, ctx.eventId)).toBe(1);
  });
});

describe('promotion respects capacity and is not triggered spuriously', () => {
  it('does not promote when the organizer rejects a PENDING (never accepted) applicant', async () => {
    const ctx = await makeEvent({ maxSpots: 1, autoApprove: false, dayOffset: 90, title: 'Pending Reject Test' });
    const cast = await applyAll(ctx.eventId, ctx.slotId, ['advait.g@yahoo.com', 'pranathi.s@gmail.com']);
    await srv.call('PATCH', `/api/applications/${cast['pranathi.s@gmail.com'].appId}`, { status: 'waitlisted' }, ctx.orgToken);
    // Rejecting someone who was only pending frees nothing.
    await srv.call('PATCH', `/api/applications/${cast['advait.g@yahoo.com'].appId}`, { status: 'rejected' }, ctx.orgToken);
    expect(await statusOf(ctx.orgToken, ctx.eventId, cast['pranathi.s@gmail.com'].appId)).toBe('waitlisted');
  });

  it('promotes when the organizer demotes an ACCEPTED volunteer to rejected', async () => {
    const ctx = await makeEvent({ maxSpots: 1, autoApprove: false, dayOffset: 100, title: 'Demote Test' });
    const cast = await applyAll(ctx.eventId, ctx.slotId, ['colin.carbin29@outlook.com', 'leo.chen28@gmail.com']);
    await srv.call('PATCH', `/api/applications/${cast['colin.carbin29@outlook.com'].appId}`, { status: 'accepted' }, ctx.orgToken);
    await srv.call('PATCH', `/api/applications/${cast['leo.chen28@gmail.com'].appId}`, { status: 'waitlisted' }, ctx.orgToken);
    await srv.call('PATCH', `/api/applications/${cast['colin.carbin29@outlook.com'].appId}`, { status: 'rejected' }, ctx.orgToken);
    expect(await statusOf(ctx.orgToken, ctx.eventId, cast['leo.chen28@gmail.com'].appId)).toBe('accepted');
  });

  it('does not promote into a CANCELLED event', async () => {
    const ctx = await makeEvent({ maxSpots: 1, autoApprove: false, dayOffset: 110, title: 'Cancelled Promote Test' });
    const cast = await applyAll(ctx.eventId, ctx.slotId, ['priya.patel.nhs@outlook.com', 'emiller2027@gmail.com']);
    await srv.call('PATCH', `/api/applications/${cast['priya.patel.nhs@outlook.com'].appId}`, { status: 'accepted' }, ctx.orgToken);
    await srv.call('PATCH', `/api/applications/${cast['emiller2027@gmail.com'].appId}`, { status: 'waitlisted' }, ctx.orgToken);
    await srv.call('PATCH', `/api/events/${ctx.eventId}/status`, { status: 'cancelled' }, ctx.orgToken);
    await srv.call('PATCH', `/api/applications/${cast['priya.patel.nhs@outlook.com'].appId}`,
      { status: 'withdrawn' }, cast['priya.patel.nhs@outlook.com'].token);
    // Pulling someone into a called-off event would be worse than leaving them waiting.
    expect(await statusOf(ctx.orgToken, ctx.eventId, cast['emiller2027@gmail.com'].appId)).toBe('waitlisted');
  });

  it('promotes through the BULK endpoint too', async () => {
    const ctx = await makeEvent({ maxSpots: 1, autoApprove: false, dayOffset: 120, title: 'Bulk Promote Test' });
    const cast = await applyAll(ctx.eventId, ctx.slotId, ['ncarbin@comcast.net', 'dsanger@outlook.com']);
    await srv.call('PATCH', `/api/applications/${cast['ncarbin@comcast.net'].appId}`, { status: 'accepted' }, ctx.orgToken);
    await srv.call('PATCH', `/api/applications/${cast['dsanger@outlook.com'].appId}`, { status: 'waitlisted' }, ctx.orgToken);
    const res = await srv.call('PATCH', '/api/applications/bulk',
      { applicationIds: [cast['ncarbin@comcast.net'].appId], status: 'rejected' }, ctx.orgToken);
    expect(res.status).toBe(200);
    expect(await statusOf(ctx.orgToken, ctx.eventId, cast['dsanger@outlook.com'].appId)).toBe('accepted');
  });
});
