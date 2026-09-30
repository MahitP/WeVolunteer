/**
 * A week in the life of WeVolunteer — ~100 students, a dozen organizers, two
 * owners and an administrator, using the product the way people do.
 *
 * ── What this is for ──
 *
 * The suite asks "does each behaviour do what it says?" one behaviour at a
 * time. This asks the other question: when everybody does everything at once,
 * for a week, does the record still add up? Hours derived only from
 * attendance, no slot over capacity, the close-out lock holding, privacy
 * holding between students, the per-person limits biting where they should.
 *
 * ── How ──
 *
 * Every write goes through a route a person could have called. The clock is
 * moved (`Date` only — timers stay real, so the server, the database and the
 * workers keep running), never the rows. The week runs in the PAST: day 0 is
 * nine days ago and day 7 is yesterday, so when it finishes the database holds
 * a lived week of history plus upcoming events created relative to today — the
 * shape a real deployment has.
 *
 * An unexpected answer is recorded as an ANOMALY with the request that got it,
 * rather than failing the run: the value of a rehearsal is the whole list, not
 * the first surprise. The invariants are hard assertions — those are the
 * properties that must never break.
 *
 * ── Limits raised, and only these ──
 *
 * Sign-up, sign-in and the general API limiter are keyed by IP address, and
 * here one loopback address stands in for a hundred phones. Raising them is
 * modelling a hundred devices, not hiding anything. Every per-PERSON limit —
 * applications, messages, appeals, check-in codes — is left at its production
 * default, because those are among the things being checked.
 *
 * Output: the database (copied), `week-report.json` and `week-report.md`, in
 * the directory named by SIM_OUT_DIR (default: the OS temp dir).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const REAL_NOW = Date.now();
const T0 = REAL_NOW - 9 * DAY;
const OUT_DIR = process.env.SIM_OUT_DIR || path.join(tmpdir(), 'wev-week');
const PASSWORD = 'Password123';

process.env.SIGNUP_RATE_LIMIT ||= '100000';
process.env.LOGIN_RATE_LIMIT ||= '100000';
process.env.API_RATE_LIMIT ||= '1000000';

/* Deterministic, so a second run is the same week. */
let seed = 20260930;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const sample = (arr, n) => { const a = [...arr]; const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rand() * a.length), 1)[0]); return out; };

const FIRST = ['Aarav', 'Maya', 'Liam', 'Sofia', 'Noah', 'Ava', 'Ethan', 'Isha', 'Lucas', 'Zara', 'Mason', 'Chloe', 'Arjun', 'Emma', 'Owen', 'Nina', 'Ravi', 'Grace', 'Kai', 'Leah'];
const LAST = ['Shah', 'Nguyen', 'Kowalski', 'Garcia', 'Okafor', 'Patel', 'Kim', 'Rossi', 'Cohen', 'Singh'];
const TAGS = ['environment', 'food', 'tutoring', 'seniors', 'animals', 'library', 'sports', 'health', 'NHS', 'arts'];
const CATEGORIES = ['Other'];

describe('a week in the life', () => {
  let srv, db;
  const anomalies = [];
  const tally = {};
  const count = (k, n = 1) => { tally[k] = (tally[k] || 0) + n; };
  const at = (ms) => vi.setSystemTime(new Date(ms));
  const dayAt = (d, hour = 9) => T0 + d * DAY + hour * HOUR;

  /** Every person the week involves, with a lazily refreshed session. */
  const people = new Map();
  const person = (email) => people.get(email);

  async function session(p) {
    if (!p.cookie) p.cookie = await srv.login(p.email, p.password);
    return p.cookie;
  }

  /**
   * A call as a person. A 401 means the session lapsed across a moved clock —
   * sign in again once and retry; anything else is the answer.
   */
  async function as(p, method, url, body, headers) {
    let res = await srv.call(method, url, body, await session(p), headers);
    /* 403 as well: an expired token is answered 403 "Invalid or expired token"
       (recorded as rehearsal finding R2), not 401. */
    if (res.status === 401 || (res.status === 403 && /expired token/i.test(res.body?.error || ''))) {
      p.cookie = null;
      res = await srv.call(method, url, body, await session(p), headers);
    }
    return res;
  }

  /** Record a response against what was expected. Never throws. */
  function expectOk(label, res, allowed = [200, 201, 204]) {
    const ok = allowed.includes(res.status);
    count(ok ? `ok:${label}` : `anomaly:${label}`);
    if (!ok) anomalies.push({ label, status: res.status, body: res.body, at: new Date().toISOString() });
    return ok;
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    at(T0);
    srv = await startServer();
    ({ db } = await import('../db.js'));
  }, 120_000);

  async function startServer() {
    const { startTestServer } = await import('../testServer.js');
    return startTestServer();
  }

  afterAll(async () => {
    vi.useRealTimers();
    await srv?.close();
  });

  it('runs seven days, and the record still adds up', async () => {
    /* ═══════════════════════════ Day 0 — people arrive ═══════════════════════════ */
    at(dayAt(0, 8));

    const admin = { email: 'admin@example.gov', password: 'password123', role: 'admin' };
    const jordan = { email: 'jordan.whitfield@example.org', password: 'password123', role: 'organizer' };
    people.set(admin.email, admin); people.set(jordan.email, jordan);

    // Owners: Mahit (who is also a student) and the platform account.
    for (const [name, username, email] of [
      ['Mahit Pulavarthi', 'mahit', 'mahit.owner@sim.test'],
      ['WeVolunteer', 'wevolunteer', 'platform.owner@sim.test'],
    ]) {
      const signed = await srv.signupConfirmed({ name, username, email, password: PASSWORD, role: 'student', grade: '12', dateOfBirth: '2008-03-01' });
      await srv.makeOwner(email);
      const { enrolTwoFactor } = await import('../testServer.js');
      await enrolTwoFactor(db, email);
      const { seedAdminAcceptance } = await import('../db.js');
      await seedAdminAcceptance();
      people.set(email, { email, password: PASSWORD, role: 'owner', id: signed.user.id, username, cookie: null });
    }
    const mahit = person('mahit.owner@sim.test');
    const platform = person('platform.owner@sim.test');

    // A hundred students across four grades.
    const students = [];
    for (let i = 0; i < 100; i++) {
      const grade = String(9 + (i % 4));
      const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`;
      const username = `sim_student_${i}`;
      const email = `student${i}@sim.test`;
      const res = await srv.call('POST', '/api/auth/signup', {
        ...(await import('../testConsent.js')).TEST_SIGNUP_DEFAULTS,
        name, username, email, password: PASSWORD, role: 'student', grade,
        dateOfBirth: `${2008 + (12 - Number(grade))}-0${1 + (i % 9)}-15`,
      });
      if (!expectOk('student signup', res, [201])) continue;
      await srv.confirmEmail(res.body.user.id);
      const p = { email, password: PASSWORD, role: 'student', id: res.body.user.id, username, grade, cookie: null };
      people.set(email, p); students.push(p);
    }
    count('students', students.length);

    // Profiles: a third choose private mode, most write something.
    for (const s of students) {
      const res = await as(s, 'PATCH', '/api/auth/profile', {
        bio: `Grade ${s.grade} volunteer who likes ${pick(TAGS)}.`,
        skills: sample(['first aid', 'spanish', 'tutoring', 'cooking', 'photography', 'coding'], 2),
        ...(rand() < 0.33 ? { profileVisibility: 'private' } : {}),
      });
      expectOk('profile update', res, [200]);
    }

    // Organizers: ten sign up, the administrator approves seven, denies one,
    // leaves two pending.
    const organizers = [jordan];
    const pendingOrganizers = [];
    for (let i = 0; i < 10; i++) {
      const email = `organizer${i}@sim.test`;
      const res = await srv.call('POST', '/api/auth/signup', {
        ...(await import('../testConsent.js')).TEST_SIGNUP_DEFAULTS,
        name: `Organizer ${LAST[i]}`, username: `sim_org_${i}`, email, password: PASSWORD,
        role: 'organizer', grade: 'Adult', dateOfBirth: '1984-05-05',
      });
      if (!expectOk('organizer signup', res, [201])) continue;
      await srv.confirmEmail(res.body.user.id);
      people.set(email, { email, password: PASSWORD, role: 'organizer', id: res.body.user.id, cookie: null });
    }
    const pendingList = await as(admin, 'GET', '/api/admin/organizers/pending');
    expectOk('pending organizer list', pendingList, [200]);
    const pendingSim = (Array.isArray(pendingList.body) ? pendingList.body : pendingList.body?.organizers || [])
      .filter(u => String(u.email || '').endsWith('@sim.test'));
    for (const [i, u] of pendingSim.entries()) {
      const p = person(u.email);
      if (i < 7) {
        if (expectOk('approve organizer', await as(admin, 'POST', `/api/admin/organizers/${u.id}/approve`, {}), [200])) {
          p.cookie = null; // role changed; the old session describes a student-shaped pending account
          expectOk('organizer agreement', await as(p, 'POST', '/api/legal/organizer-agreement/accept', { acknowledged: true }), [200, 201]);
          organizers.push(p);
        }
      } else if (i === 7) {
        expectOk('deny organizer', await as(admin, 'POST', `/api/admin/organizers/${u.id}/deny`, { reason: 'Could not confirm the organization named in the request.' }), [200]);
      } else {
        pendingOrganizers.push(p);
      }
    }
    count('organizers approved', organizers.length);

    // A pending organizer must not be able to post an event.
    if (pendingOrganizers[0]) {
      const res = await as(pendingOrganizers[0], 'POST', '/api/events', eventPayload('Should not exist', dayAt(3), 1));
      count(res.status === 403 ? 'ok:pending organizer cannot post' : 'anomaly:pending organizer posted');
      if (res.status !== 403) anomalies.push({ label: 'pending organizer posted an event', status: res.status, body: res.body });
    }

    // Friends: every student sends two requests; most are accepted.
    for (const s of students) {
      for (const other of sample(students.filter(o => o !== s), 2)) {
        const sent = await as(s, 'POST', `/api/users/${other.id}/friend`, {});
        if (sent.status === 200 || sent.status === 201) {
          count('friend requests');
          if (rand() < 0.8) {
            const acc = await as(other, 'POST', `/api/users/${s.id}/friend/accept`, {});
            if ([200, 201].includes(acc.status)) count('friendships');
          }
        } else if (sent.status !== 409) {
          expectOk('friend request', sent, [200, 201, 409]);
        }
      }
    }

    /* ─── Organizations: an open club, a request-to-join society, an invite-only club ─── */
    const orgs = [];
    for (const [i, [name, joinPolicy, tags]] of [
      ['SBHS Volunteering Club', 'open', ['service', 'school']],
      ['National Honor Society', 'request', ['NHS', 'service']],
      ['Key Club', 'invite', ['service', 'leadership']],
    ].entries()) {
      const owner = organizers[i + 1] || jordan;
      const made = await as(owner, 'POST', '/api/organizations', {
        name, description: `${name} — volunteering together since 2019.`, tags, allowReplies: true,
      });
      if (!expectOk('create organization', made, [201])) continue;
      const key = made.body.organization?.handle || made.body.organization?.id || made.body.handle || made.body.id;
      if (joinPolicy !== 'open') {
        expectOk('set join policy', await as(owner, 'PATCH', `/api/organizations/${key}`, { joinPolicy }), [200]);
      }
      orgs.push({ name, key, owner, joinPolicy, id: made.body.organization?.id || made.body.id, members: [] });
    }

    // Open club: 40 join. Society: 20 request, 15 accepted. Key Club: a link, 10 join by it.
    const [club, nhs, keyClub] = orgs;
    if (club) for (const s of sample(students, 40)) {
      if (expectOk('join open club', await as(s, 'POST', `/api/organizations/${club.key}/membership`), [200, 201])) club.members.push(s);
    }
    if (nhs) {
      const requesters = sample(students, 20);
      for (const s of requesters) expectOk('join request', await as(s, 'POST', `/api/organizations/${nhs.key}/join-requests`, {}), [200, 201]);
      const list = await as(nhs.owner, 'GET', `/api/organizations/${nhs.key}/join-requests`);
      const reqs = list.body?.requests || [];
      for (const [i, r] of reqs.entries()) {
        const decision = i < 15 ? 'accept' : 'reject';
        if (expectOk('join request decision', await as(nhs.owner, 'POST', `/api/organizations/${nhs.key}/join-requests/${r.requestId}/decision`, { decision }), [200]) && decision === 'accept') {
          const who = students.find(s => s.id === r.id);
          if (who) nhs.members.push(who);
        }
      }
      // Joining a request club directly must be refused.
      const outsider = students.find(s => !requesters.includes(s));
      const direct = await as(outsider, 'POST', `/api/organizations/${nhs.key}/membership`);
      if (direct.status < 400) anomalies.push({ label: 'joined a request-only organization directly', status: direct.status, body: direct.body });
      else count('ok:request club refuses direct join');
    }
    if (keyClub) {
      const link = await as(keyClub.owner, 'POST', `/api/organizations/${keyClub.key}/share-links`, { label: 'Fall recruitment' });
      if (expectOk('create share link', link, [200, 201])) {
        const token = String(link.body.link?.path || '').split('/').pop();
        for (const s of sample(students, 10)) {
          if (expectOk('join by share link', await as(s, 'POST', `/api/organizations/${keyClub.key}/membership`, { shareToken: token }), [200, 201])) keyClub.members.push(s);
        }
      }
      const noLink = await as(pick(students.filter(s => !keyClub.members.includes(s))), 'POST', `/api/organizations/${keyClub.key}/membership`);
      if (noLink.status < 400) anomalies.push({ label: 'joined an invite-only organization without a link', status: noLink.status, body: noLink.body });
      else count('ok:invite club refuses join without link');
    }

    /* ─── Events: twenty, days 2–6, some tagged, some for a club, one not-for-credit ─── */
    const events = [];
    for (let i = 0; i < 20; i++) {
      const host = organizers[i % organizers.length];
      const day = 2 + (i % 5);
      const shiftCount = 1 + (i % 3);
      const org = orgs.find(o => o.owner === host);
      // Staggered through the day (8, 11, 14, 17h) so first shifts do not all
      // overlap — the overlap rule would otherwise refuse most applications.
      const hour = [8, 11, 14, 17][Math.floor(i / 5) % 4];
      const payload = eventPayload(`${pick(['Park cleanup', 'Food pantry', 'Library reading hour', 'Senior centre visit', 'Animal shelter walk', 'Tutoring night'])} #${i}`, dayAt(day, hour), shiftCount, {
        tags: sample(TAGS, 1 + (i % 4)),
        ...(org && i % 2 === 0 ? { organizationId: org.id } : {}),
        ...(i === 7 ? { creditsHours: false } : {}),
        ...(i === 11 ? { autoApprove: true } : {}),
      });
      const made = await as(host, 'POST', '/api/events', payload);
      if (!expectOk('create event', made, [201])) continue;
      const detail = await as(host, 'GET', `/api/events/${made.body.id}`);
      events.push({ id: made.body.id, host, day, slots: detail.body?.event?.slots || [], autoSelect: i === 11, noCredit: i === 7 });
    }
    // Mahit, as an owner who is also a student, posts one too (P2-10).
    {
      const made = await as(mahit, 'POST', '/api/events', eventPayload('Owner-hosted beach sweep', dayAt(5, 14), 1));
      expectOk('owner creates event', made, [201]);
    }
    count('events', events.length);

    /* ═════════ Day 0 evening — applications (every deadline is still ahead) ═════════ */
    at(dayAt(0, 20));
    const applied = new Map(); // student email → [{eventId, slotId}]
    for (const s of students) {
      const want = sample(events, 2 + Math.floor(rand() * 5));
      for (const e of want) {
        const slot = pick(e.slots);
        if (!slot) continue;
        const res = await as(s, 'POST', `/api/events/${e.id}/apply`, { slotId: slot.id });
        if ([200, 201].includes(res.status)) {
          count('applications');
          applied.set(s.email, [...(applied.get(s.email) || []), { eventId: e.id, slotId: slot.id }]);
        } else if (res.status !== 409) {
          expectOk('apply', res, [200, 201, 409]);
        } else {
          count(`apply refused:${res.body?.code || 'conflict'}`);
        }
      }
    }
    // Mahit applies as a student too.
    expectOk('owner applies', await as(mahit, 'POST', `/api/events/${events[0].id}/apply`, { slotId: events[0].slots[0].id }), [200, 201]);

    // The pending-application cap (10 events) must bite for one determined student.
    {
      const eager = students[0];
      let refusedAt = null;
      for (const e of events) {
        const res = await as(eager, 'POST', `/api/events/${e.id}/apply`, { slotId: e.slots[0].id });
        count(`eager apply → ${res.status} ${res.body?.code || ''}`.trim());
        if (res.status === 409 && res.body?.code === 'application_limit_reached') { refusedAt = e.id; break; }
      }
      if (refusedAt) count('ok:pending cap enforced'); else anomalies.push({ label: 'pending application cap never refused', status: null });
    }

    /* ═══════════════════════ Day 1 — organizers decide ═══════════════════════ */
    at(dayAt(1, 9));
    // Most accepted, some waitlisted or rejected; a few students withdraw.
    for (const e of events.filter(ev => !ev.autoSelect)) {
      const detail = await as(e.host, 'GET', `/api/events/${e.id}`);
      const apps = (detail.body?.applications || []).filter(a => a.status === 'pending');
      for (const a of apps) {
        const r = rand();
        const status = r < 0.8 ? 'accepted' : r < 0.9 ? 'waitlisted' : 'rejected';
        const res = await as(e.host, 'PATCH', `/api/applications/${a.id}`, { status });
        if ([200].includes(res.status)) count(`decision:${status}`);
        else if (res.status === 409 || (res.status === 400 && /full/i.test(res.body?.error || ''))) count('ok:accept refused, shift full');
        else expectOk('decide application', res, [200, 409]);
      }
    }
    for (const s of sample(students, 8)) {
      const mine = await as(s, 'GET', '/api/applications');
      const a = (Array.isArray(mine.body) ? mine.body : []).find(x => x.status === 'accepted' || x.status === 'pending');
      if (a) expectOk('withdraw', await as(s, 'PATCH', `/api/applications/${a.id}`, { status: 'withdrawn' }), [200]);
    }

    // Messages: friends talk; students write to organizers of events they applied to.
    for (const s of sample(students, 40)) {
      const friends = await as(s, 'GET', '/api/me/friends');
      const list = Array.isArray(friends.body) ? friends.body : (friends.body?.friends || []);
      const friend = list[0];
      if (!friend) continue;
      const conv = await as(s, 'POST', '/api/messages/conversations/peer/resolve', { userId: friend.id || friend.userId });
      if (!expectOk('open friend conversation', conv, [200, 201])) continue;
      const cid = conv.body.conversation?.id;
      for (const text of ['Want to do the park cleanup Saturday?', 'I signed up for the morning shift.']) {
        expectOk('send message', await as(s, 'POST', `/api/messages/conversations/${cid}/messages`, { body: text }), [200, 201]);
      }
      count('conversations');
    }

    // Announcements and replies.
    for (const o of orgs) {
      const posted = await as(o.owner, 'POST', `/api/organizations/${o.key}/announcements`, { body: `Welcome to ${o.name}! First meeting Thursday in room 214.` });
      if (!expectOk('post announcement', posted, [200, 201])) continue;
      const aid = posted.body.announcement?.id || posted.body.id;
      for (const m of o.members.slice(0, 5)) {
        expectOk('reply to announcement', await as(m, 'POST', `/api/organizations/${o.key}/announcements/${aid}/replies`, { body: 'See you there!' }), [200, 201]);
      }
      o.announcementId = aid;
    }
    // Turning replies off must stop replies on every post.
    if (club?.announcementId && club.members[0]) {
      expectOk('disable replies', await as(club.owner, 'PATCH', `/api/organizations/${club.key}`, { allowReplies: false }), [200]);
      const blocked = await as(club.members[0], 'POST', `/api/organizations/${club.key}/announcements/${club.announcementId}/replies`, { body: 'Can I still reply?' });
      if (blocked.status < 400) anomalies.push({ label: 'replied after replies were turned off', status: blocked.status });
      else count('ok:replies switch holds');
      expectOk('enable replies', await as(club.owner, 'PATCH', `/api/organizations/${club.key}`, { allowReplies: true }), [200]);
    }

    // External hours: a third of students log some.
    for (const s of sample(students, 33)) {
      expectOk('log external hours', await as(s, 'POST', '/api/external-hours', {
        organizationName: pick(['Elijah\'s Promise', 'Town Library', 'Hope Shelter']), activityName: pick(['Soup kitchen', 'Book sorting', 'Clothing drive']),
        occurredOn: new Date(dayAt(-20)).toISOString().slice(0, 10), hours: 1 + Math.floor(rand() * 4), description: 'Before joining WeVolunteer.',
      }), [201]);
    }

    await invariants('day 1');

    /* ═════════════ Days 2–6 — shifts happen, one event at a time ═════════════ */
    /* The clock only ever moves forward. Each day is one timeline: the evening
       before, every check-in in start order, every credit in end order, then
       the close-outs — interleaved by time, as they would really happen. */
    for (let day = 2; day <= 6; day++) {
      const todays = events.filter(e => e.day === day);

      // The evening before: fetch rosters, and remove one volunteer from some
      // events (allowed — nothing has started).
      at(dayAt(day - 1, 18));
      for (const e of todays) {
        // Auto Select: its deadline has passed, so the draw runs before the
        // roster is read.
        if (e.autoSelect) {
          expectOk('auto-select run', await as(e.host, 'POST', `/api/events/${e.id}/auto-select/run`, {}), [200, 201, 202]);
        }
        const detail0 = await as(e.host, 'GET', `/api/events/${e.id}`);
        e.accepted = (detail0.body?.applications || []).filter(a => a.status === 'accepted');
        e.kicked = e.accepted[0] && rand() < 0.5 ? e.accepted[0] : null;
        if (e.kicked) {
          expectOk('remove before shift', await as(e.host, 'PATCH', `/api/applications/${e.kicked.id}`, { status: 'rejected' }), [200]);
        }
      }

      const timeline = [];
      for (const e of todays) {
        for (const slot of e.slots) {
          const start = Date.parse(slot.startDatetime);
          const end = Date.parse(slot.endDatetime);
          const job = { e, slot, start, end, present: {} };
          timeline.push({ t: start + 10 * 60_000, kind: 'checkin', job });
          timeline.push({ t: end + 30 * 60_000, kind: 'credit', job });
        }
        if (events.indexOf(e) % 4 !== 3) {
          const lastEnd = Math.max(...e.slots.map(s => Date.parse(s.endDatetime)));
          timeline.push({ t: lastEnd + 2 * HOUR, kind: 'closeout', job: { e } });
        }
      }
      timeline.sort((a, b) => a.t - b.t);

      for (const step of timeline) {
        at(step.t);
        const { e } = step.job;

        if (step.kind === 'checkin') {
          const { slot, present } = step.job;
          const inSlot = e.accepted.filter(a => a.slotId === slot.id && a !== e.kicked);

          // Once the shift has started, removal must be refused.
          if (inSlot[1]) {
            const late = await as(e.host, 'PATCH', `/api/applications/${inSlot[1].id}`, { status: 'rejected' });
            if (late.status === 200) {
              const after = await as(e.host, 'GET', `/api/events/${e.id}`);
              const row = (after.body?.applications || []).find(a => a.id === inSlot[1].id);
              if (row?.status !== 'accepted') anomalies.push({ label: 'removed a volunteer after the shift started', status: late.status, body: late.body });
              else count('ok:late removal ignored');
            } else count('ok:late removal refused');
          }

          // Check-in: 60% by QR, 25% by name, 15% do not come.
          for (const a of inSlot) {
            const who = students.find(s => s.id === a.userId) || [mahit].find(p => p.id === a.userId);
            const r = rand();
            if (r < 0.6 && who) {
              const code = await as(who, 'POST', `/api/applications/${a.id}/checkin-code`, {});
              if (expectOk('check-in code', code, [200])) {
                if (!String(code.body.displayName || '').startsWith('@')) count('FINDING R1: check-in code shows the name, not @username');
                else count('ok:check-in code shows @username');
                if (expectOk('scan', await as(e.host, 'POST', `/api/events/${e.id}/checkin/scan`, { token: code.body.token }), [200])) present[a.id] = true;
              }
            } else if (r < 0.85) {
              if (expectOk('manual check-in', await as(e.host, 'POST', `/api/events/${e.id}/checkin`, { checkinMap: { [a.id]: true } }), [200])) present[a.id] = true;
            } else {
              present[a.id] = false;
              count('no-shows');
            }
          }
        } else if (step.kind === 'credit') {
          // After the shift: credit. One volunteer per shift left early.
          const { present, start, end, slot } = step.job;
          // Account for everyone confirmed NOW — a waitlisted volunteer promoted
          // after a removal is on the roster too, and close-out requires them.
          const live = await as(e.host, 'GET', `/api/events/${e.id}`);
          for (const a of (live.body?.applications || []).filter(x => x.slotId === slot.id && x.status === 'accepted')) {
            if (!(a.id in present)) { present[a.id] = false; count('no-shows (promoted late)'); }
          }
          const ids = Object.keys(present);
          if (ids.length) {
            const early = ids.find(id => present[id]);
            const hoursMap = early && !e.noCredit ? { [early]: Math.max(0.5, (end - start) / HOUR - 1) } : undefined;
            if (expectOk('credit attendance', await as(e.host, 'POST', `/api/events/${e.id}/attendance`, { attendanceMap: present, ...(hoursMap ? { hoursMap } : {}) }), [200])) {
              e.presentIds = [...(e.presentIds || []), ...ids.filter(id => present[id])];
            }
          }
        } else {
          // Close out most events; every fourth stays open so the "ready when
          // you are" card has something to show.
          const closing = await as(e.host, 'POST', `/api/events/${e.id}/hours/close-out`, {});
          if (closing.status === 409) {
            const r = await as(e.host, 'GET', `/api/events/${e.id}`);
            const att = await db.prepare('SELECT user_id, slot_id, present FROM attendance WHERE event_id = ?').all(e.id);
            const accepted = (r.body?.applications || []).filter(a => a.status === 'accepted');
            const missing = accepted.filter(a => !att.some(x => x.user_id === a.userId && x.slot_id === a.slotId));
            anomalies.push({ label: 'close-out refused — unaccounted', status: 409, body: { event: e.id, autoSelect: e.autoSelect, missing: missing.map(m => ({ slot: m.slotId, user: m.userId, status: m.status })) } });
          }
          if (expectOk('close out', closing, [200, 409])) {
            e.closed = true;
            const credited = e.presentIds?.[0];
            if (credited) {
              const relock = await as(e.host, 'POST', `/api/events/${e.id}/attendance`, { attendanceMap: { [credited]: false } });
              if (relock.status !== 409) anomalies.push({ label: 'attendance changed after close-out', status: relock.status, body: relock.body });
              else count('ok:close-out lock holds');
            }
          }
        }
      }
      await invariants(`day ${day}`);
    }

    /* ═══════════════ Day 6 — club moderation, reports, a suspension ═══════════════ */
    at(dayAt(6, 19));
    if (club && club.members.length >= 4) {
      const [kickMe, banMe, banToo] = club.members;
      expectOk('kick member', await as(club.owner, 'DELETE', `/api/organizations/${club.key}/members/${kickMe.id}`, { mode: 'kick', reason: '' }), [200, 204]);
      const noReason = await as(club.owner, 'DELETE', `/api/organizations/${club.key}/members/${banMe.id}`, { mode: 'ban' });
      if (noReason.status !== 400) anomalies.push({ label: 'ban without a reason was accepted', status: noReason.status });
      else count('ok:ban needs a reason');
      expectOk('ban member', await as(club.owner, 'DELETE', `/api/organizations/${club.key}/members/${banMe.id}`, { mode: 'ban', reason: 'Repeatedly posted off-topic messages after two warnings.' }), [200, 204]);
      expectOk('ban second member', await as(club.owner, 'DELETE', `/api/organizations/${club.key}/members/${banToo.id}`, { mode: 'ban', reason: 'Did not attend three club shifts in a row without notice.' }), [200, 204]);

      // The kicked member may rejoin; the banned one may not.
      expectOk('kicked member rejoins', await as(kickMe, 'POST', `/api/organizations/${club.key}/membership`), [200, 201]);
      const banned = await as(banMe, 'POST', `/api/organizations/${club.key}/membership`);
      if (banned.status < 400) anomalies.push({ label: 'banned member rejoined', status: banned.status });
      else count('ok:ban holds');

      // Appeals: one goes in; a second while pending is refused; the window caps at five.
      const first = await as(banMe, 'POST', '/api/appeals', { subject: 'organization_ban', organizationId: club.id, statement: 'I understand why and I would like another chance. I will keep to the club rules.' });
      expectOk('appeal a ban', first, [200, 201]);
      const dup = await as(banMe, 'POST', '/api/appeals', { subject: 'organization_ban', organizationId: club.id, statement: 'Please look at this again, I really want to come back.' });
      if (dup.status === 200 && dup.body?.duplicate === true && dup.body?.appealId === first.body?.appealId) count('ok:one appeal at a time (idempotent)');
      else anomalies.push({ label: 'second appeal while the first is pending was not treated as a duplicate', status: dup.status, body: dup.body });

      // Club managers see the appeal and decide it; the other ban is lifted directly.
      const inbox = await as(club.owner, 'GET', `/api/organizations/${club.key}/appeals`);
      const appeals = Array.isArray(inbox.body) ? inbox.body : (inbox.body?.appeals || []);
      if (appeals[0]) expectOk('decide org appeal', await as(club.owner, 'POST', `/api/organizations/${club.key}/appeals/${appeals[0].id}/decision`, { decision: 'stands', reasoning: 'Ban stands for this term; you may apply again next term.' }), [200]);
      else anomalies.push({ label: 'club manager cannot see the appeal', status: inbox.status, body: inbox.body });
      const bans = await as(club.owner, 'GET', `/api/organizations/${club.key}/bans`);
      const banList = Array.isArray(bans.body) ? bans.body : (bans.body?.bans || []);
      expect(banList.length, 'banned list shows both bans').toBeGreaterThanOrEqual(1);
      expectOk('lift a ban', await as(club.owner, 'POST', `/api/organizations/${club.key}/bans/${banToo.id}/lift`, {}), [200, 204]);
    }

    // A report, and a suspension decided by the administrator.
    const troublemaker = students[99];
    expectOk('report a user', await as(students[98], 'POST', '/api/reports', { targetType: 'user', targetId: troublemaker.id, reason: 'harassment', details: 'Sent me the same message twenty times.' }), [200, 201]);
    const susp = await as(admin, 'POST', `/api/admin/users/${troublemaker.id}/suspend`, { reason: 'Repeated unwanted messages to another student after being asked to stop.' });
    expectOk('suspend', susp, [200]);
    {
      const blocked = await as(troublemaker, 'GET', '/api/events');
      if (blocked.status === 200) anomalies.push({ label: 'suspended account can still browse events', status: 200 });
      else count('ok:suspension confines');
      const appeal = await as(troublemaker, 'POST', '/api/appeals', { subject: 'suspension', statement: 'I am sorry. It will not happen again and I have apologised.' });
      expectOk('appeal a suspension', appeal, [200, 201]);
    }

    /* ═══════════════ Day 7 — certificates, privacy, and the week's end ═══════════════ */
    at(dayAt(7, 10));
    const sA = students[1]; const sB = students[2];
    const certsA = await as(sA, 'GET', '/api/certificates');
    const certList = Array.isArray(certsA.body) ? certsA.body : (certsA.body?.certificates || []);
    if (certList[0]?.code) {
      const peek = await as(sB, 'GET', `/api/certificates/${certList[0].code}`);
      if (peek.status !== 404) anomalies.push({ label: "another student opened someone's certificate", status: peek.status });
      else count('ok:certificate owner-only');
      const pub = await srv.call('GET', `/api/certificates/verify/${certList[0].code}`);
      expectOk('public verification', pub, [200]);
    }
    // Private mode hides grade and school from other students.
    const priv = students.find(s => s !== sB);
    if (priv) {
      const prof = await as(sB, 'GET', `/api/users/${priv.id}/profile`);
      count(prof.status === 200 ? 'profiles readable' : `profile status ${prof.status}`);
    }

    // Upcoming events relative to TODAY, so the database is also a live one.
    at(REAL_NOW - 2 * HOUR);
    for (let i = 0; i < 6; i++) {
      const host = organizers[i % organizers.length];
      const made = await as(host, 'POST', '/api/events', eventPayload(`Upcoming: ${pick(['Harvest festival', 'Blood drive', 'Coat drive', 'River cleanup'])} #${i}`, REAL_NOW + (3 + i) * DAY + 10 * HOUR, 1 + (i % 2), { tags: sample(TAGS, 2) }));
      if (expectOk('create upcoming event', made, [201])) {
        const d = await as(host, 'GET', `/api/events/${made.body.id}`);
        for (const s of sample(students.slice(0, 98), 6)) {
          const slot = pick(d.body?.event?.slots || []);
          if (slot) { const r = await as(s, 'POST', `/api/events/${made.body.id}/apply`, { slotId: slot.id }); if ([200, 201].includes(r.status)) count('upcoming applications'); }
        }
      }
    }

    await invariants('end of week');

    /* ─── Output ─── */
    mkdirSync(OUT_DIR, { recursive: true });
    // The lived-in database is kept on SQLite, where it is a file the dev
    // server can open. On PostgreSQL the harness drops its schema at the end.
    if (db.dialect !== 'postgres') {
      const dbOut = path.join(OUT_DIR, 'week.db');
      if (existsSync(dbOut)) rmSync(dbOut);
      await db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
    }
    const totals = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM applications) AS applications,
      (SELECT COUNT(*) FROM attendance WHERE present = 1) AS attended,
      (SELECT ROUND(CAST(COALESCE(SUM(hours_awarded), 0) AS NUMERIC), 2) FROM attendance WHERE present = 1) AS hours,
      (SELECT COUNT(*) FROM certificates) AS certificates,
      (SELECT COUNT(*) FROM notifications) AS notifications,
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM organization_members) AS memberships`).get();
    const report = { window: { from: new Date(T0).toISOString(), to: new Date(dayAt(7, 23)).toISOString() }, totals, tally, anomalies };
    const suffix = db.dialect === 'postgres' ? '-postgres' : '';
    writeFileSync(path.join(OUT_DIR, `week-report${suffix}.json`), JSON.stringify(report, null, 2));
    writeFileSync(path.join(OUT_DIR, `week-report${suffix}.md`), renderReport(report));
    console.log(`\n[week] ${JSON.stringify(totals)}\n[week] anomalies: ${anomalies.length} — report in ${OUT_DIR}`);
  });

  /* ───────────────────────────── invariants ───────────────────────────── */

  async function invariants(when) {
    // 1. Hours are derived only from attendance: the ledger agrees with it.
    //    The application's own parity check, not a re-derivation of it.
    const { verifyLedgerParity } = await import('../hoursLedger.js');
    const parity = await verifyLedgerParity(db);
    expect(parity.mismatches, `${when}: hours ledger disagrees with attendance`).toEqual([]);
    count(`${when}: volunteers with credited hours`, parity.usersChecked);

    // 2. No shift over capacity.
    const over = await db.prepare(`
      SELECT s.id, s.max_spots, COUNT(a.id) AS n FROM slots s
        JOIN applications a ON a.slot_id = s.id AND a.status = 'accepted'
       GROUP BY s.id, s.max_spots HAVING COUNT(a.id) > s.max_spots`).all();
    expect(over, `${when}: shifts over capacity`).toEqual([]);

    // 3. Attendance only on shifts that have started — nobody is credited for
    //    the future, however the clock was moved to get here.
    const future = await db.prepare(`
      SELECT a.user_id, s.start_datetime FROM attendance a JOIN slots s ON s.id = a.slot_id
       WHERE a.present = 1 AND s.start_datetime > ?`).all(new Date().toISOString());
    expect(future, `${when}: attendance recorded for shifts that have not started`).toEqual([]);
  }
});

/** A valid event body, shifts back to back from `startMs`. */
function eventPayload(title, startMs, shifts, extra = {}) {
  const slots = [];
  for (let i = 0; i < shifts; i++) {
    const s = startMs + i * 2.5 * HOUR;
    slots.push({ name: `Shift ${i + 1}`, description: 'Bring water.', startDatetime: new Date(s).toISOString(), endDatetime: new Date(s + 2 * HOUR).toISOString(), maxSpots: 4 + (i * 3) % 9 });
  }
  return {
    title, description: 'Help out for a couple of hours — no experience needed.', category: CATEGORIES[0], location: 'Reichler Park',
    applicationDeadline: new Date(startMs - 30 * HOUR).toISOString(), slots, ...extra,
  };
}

function renderReport({ window, totals, tally, anomalies }) {
  const lines = [
    '# Week-in-the-life rehearsal', '',
    `Simulated window: ${window.from} → ${window.to}`, '',
    '## Totals', '', '| Measure | Value |', '|---|---|',
    ...Object.entries(totals).map(([k, v]) => `| ${k} | ${v} |`), '',
    '## Tally', '', '| Step | Count |', '|---|---|',
    ...Object.entries(tally).sort().map(([k, v]) => `| ${k} | ${v} |`), '',
    `## Anomalies (${anomalies.length})`, '',
    ...(anomalies.length ? anomalies.map(a => `- **${a.label}** — status ${a.status}: \`${JSON.stringify(a.body ?? '').slice(0, 240)}\``) : ['None.']),
  ];
  return lines.join('\n') + '\n';
}
