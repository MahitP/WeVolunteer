import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The Organizer Agreement gate.
 *
 * ── What this closes ──
 *
 * An organizer sees the students who applied to their event: names, email
 * addresses, grades, attendance. Nothing recorded whether they had ever accepted
 * the undertaking about handling it. An admin clicked approve and the
 * capabilities arrived, so adults held minors' contact details under no recorded
 * obligation at all — the oldest open RED finding in the compliance register
 * (R-04).
 *
 * ── What these tests are shaped to catch ──
 *
 * The dangerous failure is not "acceptance is not recorded". It is "acceptance is
 * recorded and enforces nothing" — a gate that writes a row and then lets the
 * request through anyway would satisfy every test about acceptance while leaving
 * the finding wide open. So the assertions below are mostly about the REFUSALS,
 * and specifically about `applicant.review`, which is the capability the finding
 * is about.
 *
 * Nothing that reaches `db.js` is statically imported — see CLAUDE.md's testing
 * section.
 */
describe('the Organizer Agreement', () => {
  let srv;
  let ORGANIZER_GATED_CAPABILITIES;

  /** rmiller — seeded as an organizer awaiting approval, with no acceptance row. */
  const PENDING_ORGANIZER = 'rmiller@sbpl.info';
  /** jkatzenback — seeded as approved, and seeded WITH an acceptance row. */
  const ACCEPTED_ORGANIZER = 'jkatzenback@vikings.org';

  beforeAll(async () => {
    srv = await startTestServer();
    ({ ORGANIZER_GATED_CAPABILITIES } = await import('./organizerAgreement.js'));
  });
  afterAll(async () => { await srv.close(); });

  /**
   * Approves rmiller and returns their token. Approval only — no acceptance.
   *
   * Clears any acceptance row first, because every test in this file shares one
   * server and one database. Without the delete, the first test that accepts
   * leaves rmiller accepted for every test after it, and the ones asserting the
   * REFUSALS — which are the tests that actually prove the finding is closed —
   * start passing for the wrong reason and then stop failing when the gate breaks.
   */
  async function approvedButNotAccepted() {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    db.prepare("DELETE FROM legal_acceptances WHERE user_id = 'user-org-pending'").run();
    db.close();

    const admin = await srv.login('admin@example.gov');
    await srv.call('POST', '/api/admin/organizers/user-org-pending/approve', undefined, admin);
    return srv.login(PENDING_ORGANIZER);
  }

  describe('an approved organizer who has not accepted', () => {
    it('cannot create an event', async () => {
      const token = await approvedButNotAccepted();
      const future = new Date(Date.now() + 30 * 864e5).toISOString();
      const res = await srv.call('POST', '/api/events', {
        title: 'Ungated', description: 'd', category: 'Other', location: 'Somewhere',
        applicationDeadline: new Date(Date.now() + 20 * 864e5).toISOString(),
        slots: [{
          name: 'S', description: 'd', startDatetime: future,
          endDatetime: new Date(Date.now() + 30 * 864e5 + 108e5).toISOString(), maxSpots: 3,
        }],
      }, token);
      expect(res.status).toBe(403);
    });

    it('sees no applicants at all — the finding this exists for', async () => {
      /**
       * 200 with an empty list, not 403, and that is the interesting part.
       *
       * `GET /api/applications` scopes its results with a capability cascade
       * rather than a middleware gate. An organizer with `applicant.review`
       * withheld matches neither `audit.read`, nor `applicant.review`, nor
       * `application.withdraw`, so it falls into the cascade's explicit deny
       * branch — `rows = []`.
       *
       * That is the whole argument for withholding at the capability layer
       * instead of gating routes one at a time: an existing inline cascade that
       * predates this feature does the right thing with no change, because it
       * asks `can()` and `can()` now says no.
       */
      const token = await approvedButNotAccepted();
      const res = await srv.call('GET', '/api/applications', undefined, token);
      expect(res.status).toBe(200);
      expect(res.body, 'an unaccepted organizer was shown applicant records').toEqual([]);
    });

    it('is refused outright by a middleware-gated organizer route', async () => {
      // The other shape: `PATCH /api/applications/bulk` is gated by
      // requireCapAny(['applicant.review', 'event.moderate']), so the refusal is
      // a 403 before the handler runs.
      const token = await approvedButNotAccepted();
      const res = await srv.call('PATCH', '/api/applications/bulk', {
        ids: ['whatever'], status: 'accepted',
      }, token);
      expect(res.status).toBe(403);
    });

    it('is still a real organizer, not silently demoted to a student', async () => {
      /**
       * The alternative implementation — leave the account as a student until
       * they accept — would hand an adult the STUDENT capability set, so failing
       * to accept a document would make an adult look like a minor to every part
       * of the system that scopes on role, including the messaging rules.
       *
       * Withholding is subtractive and cannot do that. Pinned here because the
       * "just don't promote them yet" approach is the obvious one to reach for.
       */
      const token = await approvedButNotAccepted();
      const me = await srv.call('GET', '/api/auth/me', undefined, token);
      expect(me.status).toBe(200);
      expect(me.body.role).toBe('organizer');

      // And holds none of the student capabilities an implicit demotion would grant.
      const apply = await srv.call('POST', '/api/events/evt-softball-1/apply', { slotId: 'x' }, token);
      expect(apply.status).not.toBe(201);
    });

    it('can still sign in, read their own account, and reach the agreement', async () => {
      // The escape hatch. An organizer who cannot reach the one action that
      // restores their account is locked out, and a lockout is what makes people
      // click through without reading.
      const token = await approvedButNotAccepted();

      expect((await srv.call('GET', '/api/auth/me', undefined, token)).status).toBe(200);
      const status = await srv.call('GET', '/api/legal/organizer-agreement', undefined, token);
      expect(status.status).toBe(200);
      expect(status.body.required).toBe(true);
      expect(status.body.accepted).toBe(false);
      expect(status.body.withheld.length).toBeGreaterThan(0);
    });
  });

  describe('accepting it', () => {
    it('grants the withheld capabilities', async () => {
      const token = await approvedButNotAccepted();

      // Refused before: the middleware-gated route is the unambiguous witness.
      expect((await srv.call('PATCH', '/api/applications/bulk', {
        ids: ['whatever'], status: 'accepted',
      }, token)).status).toBe(403);

      const accept = await srv.call('POST', '/api/legal/organizer-agreement/accept', { acknowledged: true }, token);
      expect(accept.status).toBe(200);
      expect(accept.body.accepted).toBe(true);

      // Past the capability gate afterwards. Not a 403 — whatever the handler
      // then makes of a nonexistent application id is its own business.
      expect((await srv.call('PATCH', '/api/applications/bulk', {
        ids: ['whatever'], status: 'accepted',
      }, token)).status).not.toBe(403);
    });

    it('takes effect on the same session, without re-signing-in', async () => {
      // Capabilities are derived per request from the database rather than baked
      // into the token, so the grant must be live. If this needed a new session
      // the acceptance flow would end in a confusing forced sign-out.
      const token = await approvedButNotAccepted();
      await srv.call('POST', '/api/legal/organizer-agreement/accept', { acknowledged: true }, token);

      const status = await srv.call('GET', '/api/legal/organizer-agreement', undefined, token);
      expect(status.body.accepted).toBe(true);
      expect(status.body.withheld).toEqual([]);
    });

    it('refuses a submission that acknowledges nothing', async () => {
      const token = await approvedButNotAccepted();
      for (const body of [{}, { acknowledged: false }, { acknowledged: 'false' }, { acknowledged: 1 }]) {
        const res = await srv.call('POST', '/api/legal/organizer-agreement/accept', body, token);
        expect(res.status, `accepted ${JSON.stringify(body)} as agreement`).toBe(400);
        expect(res.body.code).toBe('acknowledgement_required');
      }
      // And nothing was granted by the refused attempts.
      expect((await srv.call('PATCH', '/api/applications/bulk', {
        ids: ['whatever'], status: 'accepted',
      }, token)).status).toBe(403);
    });

    it('records the version and content hash, not just a timestamp', async () => {
      const token = await approvedButNotAccepted();
      await srv.call('POST', '/api/legal/organizer-agreement/accept', { acknowledged: true }, token);

      const { DatabaseSync } = await import('node:sqlite');
      const { ORGANIZER_DOCUMENTS } = await import('./legalDocuments.js');
      const db = new DatabaseSync(process.env.WEV_DB_PATH);
      const rows = db.prepare(
        "SELECT * FROM legal_acceptances WHERE user_id = 'user-org-pending' AND method = 'organizer_agreement'"
      ).all();
      db.close();

      expect(rows.length).toBe(ORGANIZER_DOCUMENTS.length);
      for (const doc of ORGANIZER_DOCUMENTS) {
        const row = rows.find(r => r.document_slug === doc.slug);
        expect(row, `no acceptance row for ${doc.slug}`).toBeTruthy();
        // A version with no hash is a record that cannot say WHAT was agreed to.
        expect(row.version).toBe(doc.version);
        expect(row.content_hash).toBe(doc.contentHash);
      }
    });

    it('does not write a second record when submitted twice', async () => {
      // "When did they accept v1.0" must have one answer.
      const token = await approvedButNotAccepted();
      const first = await srv.call('POST', '/api/legal/organizer-agreement/accept', { acknowledged: true }, token);
      const second = await srv.call('POST', '/api/legal/organizer-agreement/accept', { acknowledged: true }, token);

      expect(first.body.alreadyAccepted).toBe(false);
      expect(second.status).toBe(200);
      expect(second.body.alreadyAccepted).toBe(true);
      expect(second.body.recorded).toBe(0);
    });

    it('refuses to record an acceptance for somebody it does not bind', async () => {
      // An acceptance row for a student is a false record, and a false record in
      // this table is worse than a missing one.
      const student = await srv.login('colin.carbin29@outlook.com');
      const res = await srv.call('POST', '/api/legal/organizer-agreement/accept', { acknowledged: true }, student);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('not_an_organizer');
    });
  });

  describe('the seeded fixtures sit either side of the gate', () => {
    it('the approved seeded organizer has accepted and works normally', async () => {
      // If this ever fails, the demo has an organizer who cannot open the
      // applicant list for the events they are seeded as running.
      const token = await srv.login(ACCEPTED_ORGANIZER);
      const status = await srv.call('GET', '/api/legal/organizer-agreement', undefined, token);
      expect(status.body.accepted).toBe(true);
      expect(status.body.withheld).toEqual([]);
      expect((await srv.call('GET', '/api/applications', undefined, token)).status).toBe(200);
    });

    it('a student is told no agreement is required rather than refused', async () => {
      const student = await srv.login('colin.carbin29@outlook.com');
      const res = await srv.call('GET', '/api/legal/organizer-agreement', undefined, student);
      expect(res.status).toBe(200);
      expect(res.body.required).toBe(false);
    });
  });

  describe('the withheld set', () => {
    it('covers every organizer capability that reaches a student', async () => {
      /**
       * Derived from the role's own capability list rather than restated, so a
       * capability added to the organizer role in `authz.js` and forgotten here
       * fails the build.
       *
       * The four exempted capabilities are the escape hatch: an organizer must be
       * able to sign in, read their own account, and reach the agreement. Any
       * OTHER new organizer capability is student-facing until somebody argues
       * otherwise, which is the safe default for this list.
       */
      const { CAPABILITIES } = await import('./authz.js');
      /**
       * `analytics.impact` was on this escape-hatch list and is gone from it,
       * because it is gone from the organizer role entirely — the community impact
       * figures became an administrative capability. Nothing to withhold and
       * nothing to exempt: an organizer never holds it, signed or unsigned.
       *
       * The four that remain are what an organizer needs in order to sign in, read
       * their own account, and reach the agreement. Withholding any of those would
       * lock them out of the one action that unlocks the rest.
       *
       * `persona.preview.exit` is the fifth, and it is exempt for the same reason
       * it is held by every role: it reaches no student and no student's record.
       * It clears the CALLER'S OWN two preview columns and does nothing else, so
       * for an organizer — who cannot start a preview, since `persona.preview` is
       * SUPER_ONLY — it is an action with no effect at all. Withholding a no-op
       * would only make the withheld list harder to read.
       */
      const ALLOWED_WHILE_UNACCEPTED = [
        'event.view', 'self.read', 'self.write', 'geocode.use', 'persona.preview.exit',
      ];

      const unclassified = CAPABILITIES.organizer.filter(
        cap => !ORGANIZER_GATED_CAPABILITIES.includes(cap) && !ALLOWED_WHILE_UNACCEPTED.includes(cap)
      );

      expect(
        unclassified,
        'these organizer capabilities are neither withheld nor on the deliberate '
        + 'escape-hatch list. Decide which: if it can reach a student or their '
        + 'record, add it to ORGANIZER_GATED_CAPABILITIES.'
      ).toEqual([]);
    });

    it('withholds nothing from an administrator', async () => {
      /**
       * Admins are covered by the Admin Responsibilities Policy, not this one, and
       * they hold `attendance.mark` and `attendance.view` for oversight. Gating
       * those on an agreement that does not apply to them would withhold
       * administration from administrators — and withholding from the super_admin
       * would lock the platform owner out of their own instance.
       */
      const admin = await srv.login('admin@example.gov');
      const res = await srv.call('GET', '/api/legal/organizer-agreement', undefined, admin);
      expect(res.body.required).toBe(false);
      expect(res.body.withheld).toEqual([]);
    });
  });

  /**
   * ── The session payload ──
   *
   * `/api/auth/me` is the only response the client's `currentUser` is ever built
   * from, and the nav is one array filtered by client-side `can()`. Without
   * `withheld` on that payload the two capability tables disagree in exactly the
   * direction `src/authz.js`'s header names as the failure mode: the nav offers
   * "New event", "Calendar" and "Messages" to an organizer for whom all three
   * 403, with no explanation of why.
   *
   * That is UX, not a boundary — the server refuses either way, which the
   * refusal tests above establish independently. These pin the agreement between
   * the two.
   */
  describe('the session payload', () => {
    it('reports the withheld capabilities to the account they are withheld from', async () => {
      const token = await approvedButNotAccepted();
      const me = await srv.call('GET', '/api/auth/me', undefined, token);

      expect(me.status).toBe(200);
      expect(me.body.withheld).toEqual([...ORGANIZER_GATED_CAPABILITIES]);
    });

    it('empties the list on the same session once the agreement is accepted', async () => {
      // The nav has to come back without a re-sign-in, for the same reason the
      // capabilities do: the acceptance flow ending in a forced sign-out would
      // read as the acceptance having failed.
      const token = await approvedButNotAccepted();
      await srv.call('POST', '/api/legal/organizer-agreement/accept', { acknowledged: true }, token);

      const me = await srv.call('GET', '/api/auth/me', undefined, token);
      expect(me.body.withheld).toEqual([]);
    });

    it('withholds nothing from a student', async () => {
      const student = await srv.login('colin.carbin29@outlook.com');
      const me = await srv.call('GET', '/api/auth/me', undefined, student);
      expect(me.body.withheld).toEqual([]);
    });

    it('does not disclose it on payloads describing somebody else', async () => {
      /**
       * The field says whether a named person has signed an agreement. It belongs
       * on the account it describes and nowhere else — which is why it is added
       * at `/api/auth/me` rather than inside `formatUserResponse`, whose one
       * caller serving OTHER people is the pending-organizer queue below.
       *
       * Asserted against an organizer with no acceptance row, so it fails if the
       * field is ever moved into the shared formatter.
       *
       * rmiller is returned to the unapproved state first: the queue selects on
       * `verified = 0`, and earlier tests in this file approve them.
       */
      const { DatabaseSync } = await import('node:sqlite');
      const raw = new DatabaseSync(process.env.WEV_DB_PATH);
      raw.prepare("DELETE FROM legal_acceptances WHERE user_id = 'user-org-pending'").run();
      raw.prepare("UPDATE users SET verified = 0 WHERE id = 'user-org-pending'").run();
      raw.close();

      const admin = await srv.login('admin@example.gov');
      const queue = await srv.call('GET', '/api/admin/organizers/pending', undefined, admin);
      expect(queue.status).toBe(200);

      const pending = queue.body.find(u => u.email === PENDING_ORGANIZER);
      expect(pending, 'the seeded pending organizer should appear in the approval queue').toBeTruthy();
      expect(pending).not.toHaveProperty('withheld');
    });
  });
});
