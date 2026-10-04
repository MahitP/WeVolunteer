import express from 'express';
import '../email.js';
import { VALID_GRADES } from '../config.js';

import { authenticateToken, selfUserResponse } from '../utils.js';
import { can } from '../authz.js';
/* The milestone ladder. One definition, in a module — it was inline here, and
   duplicated byte-for-byte in utils.js where nothing imported it. See
   server/milestones.js for the badge/milestone boundary this sits on. */
import { buildMilestones } from '../milestones.js';
import { milestoneInputs, creditedTotalsFor } from '../volunteerInsights.js';
import { db } from '../db.js';
import { distinctionFor } from '../profileSerializer.js';
import { demonstrationShowcase } from '../demonstrationShowcase.js';
import { validateProfilePatch } from '../accountValidation.js';
import '../services/verification.js';
import { canSeeHours, isValidVisibility } from '../serviceVisibility.js';

const router = express.Router();

/**
 * ── Why `directory.read`, on a route that predates the directory ──
 *
 * This handler carried no capability gate at all: the PII fields are gated
 * inline by `canSeeContact`, and the reasoning recorded in the completeness
 * registry was that the remaining stats are non-PII and may be read by any
 * authenticated caller.
 *
 * That reasoning had one hole, and v1.3 opened it. `partner` is deliberately
 * denied `directory.read` (see the note in authz.js: a partner is an EXTERNAL
 * organization and the member directory is a searchable list of schoolchildren)
 * — and every NEW directory route enforces that, while this older one, which
 * returns a student's name, avatar, skills, credited hours, milestones and
 * service counts, did not. The exclusion was therefore a front door that was
 * locked while this window stood open beside it.
 *
 * The capability is held by student, organizer and admin, and by super_admin
 * through its wildcard, so this narrows exactly one role — the one it was
 * supposed to narrow.
 *
 * ── An inline `can()`, deliberately, and not `requireCap` ──
 *
 * `requireCap` refuses on `principal.tfaRequired` as well as on the capability,
 * so mounting it here would ALSO make this route unreadable to an organizer or
 * administrator who has not yet enrolled a second factor. That may well be
 * right, but it is a different decision about a different role, and quietly
 * attaching it to a partner fix would change behaviour nobody reviewed — a
 * pending organizer reading a volunteer's profile is not the hole being closed.
 * The route was already registered INLINE_GATED for its `canSeeContact` logic,
 * so this is the gate joining the one that is there rather than a new layer.
 */
router.get('/api/users/:id/profile', authenticateToken, async (req, res) => {
  if (!can(req.principal, 'directory.read')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    // `account_status <> 'deleted'` is part of the identity check, not a filter
    // bolted on afterwards: a deleted account is anonymised in place rather than
    // removed — the row survives so that audit history and foreign keys still
    // resolve — so without this a tombstone answers 200 as a live profile.
    // Suspended is deliberately NOT excluded: a suspended member still exists
    // and their profile is still theirs.
    /**
     * ── Who has a volunteer profile ──
     *
     * Every student, and anybody else who has actually volunteered.
     *
     * This used to be `role = 'student'` alone, and that was right while only
     * students volunteered. It stopped being right for an account that runs the
     * platform AND turns up to shifts: the platform owner's own service record —
     * real hours, real attendance, real badges — answered 404 to everybody
     * including themselves, because the row said `super_admin`.
     *
     * ── Why attendance and not a role list ──
     *
     * `role IN ('student', 'super_admin')` would have worked today and been
     * wrong in principle: it says "the owner is a volunteer" as a fact about a
     * ROLE, when what makes somebody a volunteer is that they volunteered. An
     * organizer who never takes a shift still has no profile here; one who does
     * has the record to show. The rule is about the ledger, which is the same
     * thing every figure ON the profile is derived from.
     *
     * Presentation is unaffected: `profileSerializer` derives everything from
     * the same columns whatever the role, and the one role-derived field
     * (`distinction`) is the role restated in words. So the owner's profile is
     * a volunteer's profile, with a word on it saying what else they are.
     *
     * `account_status <> 'deleted'` is part of the identity check, not a filter
     * bolted on afterwards: a deleted account is anonymised in place rather than
     * removed — the row survives so audit history and foreign keys still resolve
     * — so without it a tombstone answers 200 as a live profile. Suspended is
     * deliberately NOT excluded: a suspended member still exists and their
     * profile is still theirs.
     */
    const row = await db.prepare(`
      SELECT users.*,
             CASE WHEN role = 'student'
                    OR EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = users.id AND a.present = 1)
                  THEN 1 ELSE 0 END AS is_volunteer
        FROM users
       WHERE id = ?
         AND account_status <> 'deleted'
    `).get(req.params.id);
    /* A volunteer profile exists for a student, for anybody with confirmed
       service, and for the founder at any history (ruling 21: his page is a
       student's, with honest zeros). The last is the server's own flag from
       the address, never a client's claim. Every other account with no
       service answers 404 exactly as before, so this route still says nothing
       about who exists beyond what it said already. */
    const distinction = row ? distinctionFor(row.role, row.email) : null;
    const isVolunteer = row && (Number(row.is_volunteer) === 1 || distinction?.studentProfile === true);
    if (!isVolunteer) return res.status(404).json({ error: 'Volunteer not found' });

    const isSelf = req.params.id === req.principal.userId;

    // Organizers only see contact/PII fields for students who have applied
    // to an event they host — not for every student on the platform.
    // `applicant.review` is the "kind of actor" check (organizer, and
    // super_admin via the wildcard); the subquery is the ownership check —
    // an actual applicant of an event this principal actually hosts.
    const hostsApplicant = can(req.principal, 'applicant.review') && !!await db.prepare(`
      SELECT 1 FROM applications a
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? AND e.organizer_id = ?
      LIMIT 1
    `).get(req.params.id, req.principal.userId);
    const canSeeContact = isSelf || can(req.principal, 'user.contact.read') || hostsApplicant;

    /**
     * Whether the AGGREGATE service figures may be shown.
     *
     * The itemised `completed` array below has always been gated on
     * `canSeeContact`, and correctly so. What was never gated was everything
     * around it: total hours, events completed, shifts completed, the
     * hours-by-category breakdown and the milestone tiers. Those were returned
     * to every caller holding `directory.read`, which is every student.
     *
     * Individually each is only a number. Together they are a fairly complete
     * picture of how much somebody volunteers and at what, and a student who
     * wants that kept to themselves had no way to ask. Now they do.
     *
     * `canSeeContact` is deliberately part of the test rather than a separate
     * branch: staff who may already read a student's particulars, and an
     * organizer reviewing somebody who applied to their own event, are reading
     * this as part of a workflow that is already a reviewed decision. Hiding a
     * total from them would break applicant review without protecting anything
     * they cannot reach another way.
     */
    const hoursVisible = canSeeHours(row, { viewerId: req.principal.userId, canSeeContact });

    /**
     * Shared with the dashboard rather than restated here.
     *
     * This query and the dashboard's are the inputs to the same
     * `buildMilestones` call, so if they ever drift the two surfaces disagree
     * about whether a student has earned a tier — on the same afternoon, for
     * the same student. `milestoneInputs` is the single derivation for the
     * EVENTS argument, and `routes.volunteerInsights.test.js` asserts the
     * agreement — including on a credited cancelled event, which is the one
     * input that can tell the two derivations apart.
     */
    const totals = await milestoneInputs(db, req.params.id);

    /**
     * The HOURS figures, which are a different question from the tier above.
     *
     * `stats.hours` published `milestoneInputs().hours`, which counts a
     * cancelled event — while `completed[]` below carries
     * `AND e.status <> 'cancelled'` and says "Same rule as
     * volunteerStats.hoursCredited". So this response could show a student
     * seven hours beside an empty list of the events that produced them, and
     * `/api/auth/me` reported a different total for the same student on the
     * same afternoon.
     *
     * `git show 93756e4` shows this was never a decision: the query here was
     * already unfiltered when the milestone extraction moved it into
     * `volunteerInsights`. The extraction shared a derivation; it did not pick
     * one for the totals.
     *
     * `milestones` keeps the other derivation for its EVENTS tiers only — that
     * half IS a recorded decision ("because the service still happened"). Its
     * HOURS tiers read `credited.hours`, for the reason set out at the
     * `buildMilestones` call in `volunteerInsights.js`: a tier measured in
     * hours has to mean the same hours this response reports beside it.
     */
    const credited = await creditedTotalsFor(db, req.params.id);

    // Completed service, newest first
    const completed = await db.prepare(`
      SELECT e.id as event_id, e.title, e.category, e.location, u.name as organizer_name,
             s.name as slot_name, s.start_datetime, s.end_datetime, at.hours_awarded,
             /* Which organization ran it, so the transcript can be filtered to one
                club without a second endpoint. LEFT JOIN: most events have no
                owning organization and those rows must still appear. */
             e.organization_id as organization_id, o.name as organization_name,
             o.slug as organization_slug
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      JOIN events e ON at.event_id = e.id
      JOIN users u ON e.organizer_id = u.id
      LEFT JOIN organizations o ON o.id = e.organization_id
      /* A cancelled event is not completed service. It carries attendance -
         PUT /api/events/:id refuses to delete those rows - but the transcript
         built from this list is a record of what somebody DID, and a called-off
         event printed as a verified row under their name is a claim the platform
         cannot support. Same rule as volunteerStats.hoursCredited and every
         figure in organizationHours.js.
         No backticks in here: this comment sits inside a template literal and
         one would end the string mid-SQL. */
      WHERE at.user_id = ? AND at.present = 1 AND e.status <> 'cancelled'
      ORDER BY s.start_datetime DESC
    `).all(req.params.id);

    // Upcoming confirmed shifts
    const upcoming = await db.prepare(`
      SELECT e.id as event_id, e.title, e.category, e.location, s.name as slot_name,
             s.start_datetime, s.end_datetime
      FROM applications a
      JOIN slots s ON a.slot_id = s.id
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? AND a.status = 'accepted'
        AND s.start_datetime > ? AND e.status != 'cancelled'
      ORDER BY s.start_datetime ASC
    `).all(req.params.id, new Date().toISOString());

    const pendingCount = (await db.prepare(`
      SELECT COUNT(*) as c FROM applications
      WHERE user_id = ? AND status IN ('pending', 'waitlisted')
    `).get(req.params.id)).c;

    /* Hours by category — what kind of volunteer someone is.
       Cancelled excluded, so this breakdown sums to `stats.hours` and to the
       `completed` list above rather than to a third number. The join was
       already here for `e.category`; only the predicate was missing. */
    const byCategory = await db.prepare(`
      SELECT e.category, COALESCE(SUM(at.hours_awarded), 0) as hours
      FROM attendance at
      JOIN events e ON at.event_id = e.id
      WHERE at.user_id = ? AND at.present = 1 AND e.status <> 'cancelled'
      GROUP BY e.category ORDER BY hours DESC
    `).all(req.params.id);

    res.json({
      volunteer: {
        id: row.id,
        name: row.name,
        avatar: row.avatar,
        grade: canSeeContact ? row.grade : null,
        bio: canSeeContact ? row.bio : null,
        school: canSeeContact ? row.school : null,
        /* Gated with bio, school and grade above. It was unconditional, so this
           route published a private student's skills to every member while the
           public profile — after 2026-10-04 — withheld them. Null rather than
           an empty list: an empty list is a claim that they listed none. */
        skills: canSeeContact ? (row.skills ? JSON.parse(row.skills) : []) : null,
        joinedAt: row.created_at,
        // Contact details stay with the person and the adults coordinating them
        email: canSeeContact ? row.email : null
      },
      /* Omitted, not zeroed, when the subject keeps their history private: a
         zero is a claim about somebody, and it is a false one. `hoursVisible`
         is reported alongside so the page can say why the figures are absent. */
      hoursVisible,
      stats: {
        hours: hoursVisible ? (Number(credited.hours) || 0) : null,
        eventsCompleted: hoursVisible ? (credited.events || 0) : null,
        shiftsCompleted: hoursVisible ? (credited.shifts || 0) : null,
        // The count alone carries no whereabouts, so staff who legitimately
        // see contact info may see it too — the array itself (event location,
        // exact times) is self-only, below.
        upcomingCount: isSelf || canSeeContact ? upcoming.length : 0,
        /* Gated on the same terms as `upcomingCount` above. It was
           unconditional, which left a figure the public profile does not publish
           sitting next to one that is deliberately withheld — an asymmetry that
           read as an oversight rather than a decision. */
        pendingCount: isSelf || canSeeContact ? pendingCount : 0
      },
      /* Both are derived from the hours, so publishing them while withholding
         the total would hand the reader the same fact by another route — a
         milestone tier IS an hours threshold, and the category breakdown sums
         to the total. */
      /* Same pairing as `volunteerInsights`, and it has to stay the same:
         the two surfaces must not disagree about whether a tier is earned.
         `routes.volunteerInsights.test.js` asserts the agreement. */
      milestones: hoursVisible ? buildMilestones(Number(credited.hours) || 0, totals.events || 0) : [],
      byCategory: hoursVisible
        ? byCategory.map(c => ({ category: c.category, hours: Number(c.hours) }))
        : [],
      /**
       * The itemised service record is NOT public.
       *
       * Each row carries a past event's title, its LOCATION and its exact start
       * and end times. For a fifteen-year-old that is a week-by-week record of
       * where they have been, and it was returned to every authenticated caller
       * with nothing gating it — the single most sensitive thing this endpoint
       * disclosed. The counts above say how much somebody has volunteered
       * without saying where they were on Saturday.
       *
       * Self, or staff holding `user.contact.read`, which is the capability
       * that already names the power to see a student's particulars.
       */
      /**
       * The itemised service record is NOT public, and the gate is
       * `canSeeContact`.
       *
       * Each row carries a past event's title, its LOCATION and its exact start
       * and end times. Before v1.3 this was returned to EVERY authenticated
       * caller with nothing gating it — for a fifteen-year-old, a week-by-week
       * record of where they have been, handed to anybody with a login. That is
       * the leak this closes.
       *
       * `hostsApplicant` is deliberately inside the gate, and it is narrower
       * than it looks: it requires that this student applied to an event THIS
       * organizer hosts. An organizer cannot manufacture that. Reviewing an
       * applicant's service history is the applicant-review workflow — it is
       * how an organizer decides who to accept — and it is pinned by
       * "does not regress the organizer applicant-review workflow" in
       * routes.auth.test.js. Narrowing it would break a reviewed decision, not
       * fix a leak.
       *
       * `/api/users/:id/service-record` applies the identical rule, so the two
       * endpoints cannot disagree about the same rows.
       */
      completed: canSeeContact ? completed.map(formatServiceRow) : [],
      completedRedacted: !canSeeContact,
      // A confirmed future shift discloses a minor's physical whereabouts at a
      // known time — visible to the student themselves only, never to other
      // students, organizers, or admins.
      upcoming: isSelf ? upcoming.map(u => ({
        eventId: u.event_id, title: u.title, category: u.category, location: u.location,
        slotName: u.slot_name, startDatetime: u.start_datetime, endDatetime: u.end_datetime
      })) : [],
      /* Ruling 19: definitions labelled a demonstration, never an award.
         Same source as the public profile's (demonstrationShowcase.js). */
      ...(distinction?.showcase ? { showcase: await demonstrationShowcase(db) } : {}),
    });
  } catch (err) {
    console.error('Volunteer profile error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

function formatServiceRow(r) {
  return {
    eventId: r.event_id,
    title: r.title,
    category: r.category,
    location: r.location,
    organizerName: r.organizer_name,
    slotName: r.slot_name,
    startDatetime: r.start_datetime,
    endDatetime: r.end_datetime,
    hours: Number(r.hours_awarded),
    /* Null for an event no organization ran, which is most of them. */
    organizationId: r.organization_id ?? null,
    organizationName: r.organization_name ?? null,
    organizationSlug: r.organization_slug ?? null
  };
}


// ── Certificates ────────────────────────────────────────────────────
// One certificate per completed event. The verification code is derived
// from the record itself, so the same service always produces the same code
// and a school office can check a printed copy against the platform.

/**
 * Intentionally open to every authenticated role — declared as such in
 * authz.completeness.test.js's ROUTE_REGISTRY, not gated by a capability.
 *
 * This used to carry `requireCap('event.view')`, which every one of the five
 * roles holds. A gate no role can fail is indistinguishable from no gate, but
 * it is worse than no gate: it looks like a decision was made, and it removed
 * this route from Guard 2's reviewed registry — the one place where "why is
 * this open?" is actually written down and re-read. `GET /api/events` is the
 * identical case (every role holds event.view) and is handled the other way,
 * so the two now match. Whichever way a future reader looks, they find one
 * mechanism, and the reasoning lives with the route rather than in a
 * capability that only pretends to discriminate.
 */
router.get('/api/organizers/:id/profile', authenticateToken, async (req, res) => {
  try {
    // See the sibling volunteer profile above: a deleted account keeps its row
    // and its role, so the role predicate alone matches tombstones. The demo
    // administrator removed from the pilot database is exactly such a row — it
    // is `account_status = 'deleted'` and still `role = 'admin'`, and without
    // this it answered 200 here instead of 404.
    const row = await db.prepare(
      "SELECT * FROM users WHERE id = ? AND role IN ('organizer','admin') AND account_status <> 'deleted'"
    ).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Organizer not found' });

    /* Same rule as the volunteer profile above: self, or an actor holding the
       capability to read contact details. `hostsApplicant` has no meaning here —
       the subject is the host — so it is not part of the test. */
    const canSeeContact = req.params.id === req.principal.userId
      || can(req.principal, 'user.contact.read');

    const totals = await db.prepare(`
      SELECT COUNT(DISTINCT e.id) as events_hosted,
             COUNT(DISTINCT a.user_id) as volunteers_helped
      FROM events e
      LEFT JOIN applications a ON a.event_id = e.id AND a.status = 'accepted'
      WHERE e.organizer_id = ?
    `).get(req.params.id);

    const hoursAwarded = (await db.prepare(`
      SELECT COALESCE(SUM(at.hours_awarded), 0) as h
      FROM attendance at
      JOIN events e ON at.event_id = e.id
      WHERE e.organizer_id = ? AND at.present = 1
    `).get(req.params.id)).h;

    const events = await db.prepare(`
      SELECT e.id, e.title, e.category, e.location, e.status, e.application_deadline,
             (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) as start_datetime,
             (SELECT COALESCE(SUM(s.max_spots), 0) FROM slots s WHERE s.event_id = e.id) as max_spots,
             (SELECT COUNT(*) FROM applications a WHERE a.event_id = e.id AND a.status = 'accepted') as accepted
      FROM events e WHERE e.organizer_id = ?
      ORDER BY start_datetime DESC
    `).all(req.params.id);

    const now = new Date().toISOString();
    const shape = (e) => ({
      id: e.id, title: e.title, category: e.category, location: e.location,
      status: e.status, startDatetime: e.start_datetime,
      applicationDeadline: e.application_deadline,
      maxSpots: Number(e.max_spots), accepted: e.accepted
    });

    res.json({
      organizer: {
        id: row.id,
        name: row.name,
        avatar: row.avatar,
        bio: row.bio,
        organization: row.school,
        verified: row.verified === 1,
        joinedAt: row.created_at,
        /**
         * The login address is privileged here too, on the same terms as the
         * volunteer profile above.
         *
         * This was unconditional, and this route is reachable by EVERY
         * authenticated role — including `partner`, which is deliberately kept
         * out of the directory (authz.js) precisely so an outside organization
         * cannot mine member records. The subject rows are
         * `role IN ('organizer','admin')`, so what a student could collect by
         * walking the `organizerId` values that `GET /api/events` already hands
         * them was the address of every organizer AND every administrator — the
         * accounts holding `user.suspend`, `report.resolve` and
         * `capability.grant`. That is a phishing target list.
         *
         * `profileSerializer.js` has always listed `email` among
         * PRIVILEGED_FIELDS and states a public profile never shows one; the
         * sibling volunteer route implements exactly this check. This route was
         * the one place the rule was not applied.
         *
         * Reaching an organizer is a real need, but the answer to it is an
         * opt-in contact address, not the credential the account signs in with.
         */
        email: canSeeContact ? row.email : null
      },
      stats: {
        eventsHosted: totals.events_hosted || 0,
        volunteersHelped: totals.volunteers_helped || 0,
        hoursAwarded: Number(hoursAwarded) || 0
      },
      upcoming: events.filter(e => e.start_datetime && e.start_datetime > now && e.status !== 'cancelled').reverse().map(shape),
      past: events.filter(e => !e.start_datetime || e.start_datetime <= now || e.status === 'cancelled').map(shape)
    });
  } catch (err) {
    console.error('Organizer profile error:', err);
    res.status(500).json({ error: 'Failed to load organizer profile' });
  }
});

// 18. Favorites toggle and list

router.patch('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const { grade, leaderboardOptIn, emailOptOut } = req.body;

    /**
     * The text fields go through the same validator signup uses.
     *
     * This handler previously called `name.trim()` on an unvalidated value — so
     * a non-string `name` threw and answered 500 — accepted `"   "` as a
     * display name, and applied no length or type limit to bio, school or
     * avatar, all three of which are bounded at signup.
     */
    const check = validateProfilePatch(req.body);
    if (!check.ok) {
      return res.status(400).json({ error: check.error, field: check.field });
    }

    const updates = [];
    const values = [];

    for (const [column, value] of [
      ['name', check.value.name],
      ['avatar', check.value.avatar],
      /* The colour behind the emoji. A palette KEY, validated in
         `accountValidation`, never a colour from the client. */
      ['avatar_color', check.value.avatarColor],
      ['bio', check.value.bio],
      ['school', check.value.school]
    ]) {
      if (value !== undefined) { updates.push(`${column} = ?`); values.push(value); }
    }
    if (check.value.skills !== undefined) {
      updates.push('skills = ?'); values.push(JSON.stringify(check.value.skills));
    }
    if (check.value.hobbies !== undefined) {
      updates.push('hobbies = ?'); values.push(JSON.stringify(check.value.hobbies));
    }
    /**
     * The headline and highlights belong to a DISTINGUISHED account.
     *
     * They are the one-line introduction and the short list under an official
     * account's name. Refused for everybody else rather than merely hidden,
     * because a field that stores what it will not show is a field somebody
     * will later decide to show: the safe version of "a student's headline is
     * private" is a student having no headline at all. Ordinary accounts have
     * `bio`, which is the same kind of text and is gated by
     * `profile_visibility`.
     *
     * Derived from `distinctionFor(role)` — the same single source the profile
     * presentation reads — so this is not a role comparison living in a route.
     */
    const writingDistinguishedFields =
      check.value.headline !== undefined || check.value.highlights !== undefined;
    if (writingDistinguishedFields) {
      const self = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
      if (!distinctionFor(self?.role)) {
        return res.status(403).json({
          error: 'Your account does not have a profile headline. Use "About you" instead.',
          field: check.value.headline !== undefined ? 'headline' : 'highlights',
          code: 'not_distinguished',
        });
      }
    }
    if (check.value.headline !== undefined) {
      updates.push('profile_headline = ?'); values.push(check.value.headline || null);
    }
    if (check.value.highlights !== undefined) {
      updates.push('profile_highlights = ?');
      values.push(check.value.highlights.length ? JSON.stringify(check.value.highlights) : null);
    }
    if (check.value.location !== undefined) {
      updates.push('location = ?'); values.push(check.value.location || null);
    }

    /**
     * The two privacy switches this screen owns.
     *
     * `profileVisibility` had no write path at all before v1.3 — the column
     * existed, defaulted to 'private', and nothing could change it or read it.
     * Validated against the same closed set as the column's CHECK, so an
     * unexpected value is a 400 rather than a constraint error surfacing as a
     * 500.
     */
    if (req.body.profileVisibility !== undefined) {
      if (!['private', 'friends', 'public'].includes(req.body.profileVisibility)) {
        return res.status(400).json({ error: 'Choose private, friends, or public.', field: 'profileVisibility' });
      }
      updates.push('profile_visibility = ?'); values.push(req.body.profileVisibility);
    }
    if (req.body.friendActivityVisible !== undefined) {
      updates.push('friend_activity_visible = ?'); values.push(req.body.friendActivityVisible ? 1 : 0);
    }

    /**
     * Who may see the service history and the certificates.
     *
     * Two separate questions with two separate answers, deliberately. A student
     * may be happy for the school to see they volunteered forty hours while
     * keeping the certificates — which carry their full name, the organization
     * and a verification code — to themselves, or exactly the reverse.
     *
     * Validated against the closed set rather than coerced. `values.push(x ===
     * 'private' ? 'private' : 'public')` would accept a typo and silently store
     * the opposite of what the student chose, which for a privacy control is
     * the one failure mode that must not be quiet.
     */
    for (const [field, column] of [['hoursVisibility', 'hours_visibility'],
                                   ['certificatesVisibility', 'certificates_visibility']]) {
      if (req.body[field] !== undefined) {
        if (!isValidVisibility(req.body[field])) {
          return res.status(400).json({ error: 'Choose public or private.', field });
        }
        updates.push(`${column} = ?`); values.push(req.body[field]);
      }
    }

    /**
     * Consent to analytics.
     *
     * A strict boolean, and the strictness is the point. Every other switch on
     * this endpoint coerces — `leaderboardOptIn ? 1 : 0` — which is fine for a
     * preference and wrong for a consent record: `'false'`, the string, is
     * truthy, so a client bug would store a yes that nobody gave. The column
     * has three meaningful states (see migration 052) and only two of them may
     * be reached from here; `null` means "not asked" and is not something a
     * request may assert about a person.
     */
    if (req.body.analyticsConsent !== undefined) {
      if (typeof req.body.analyticsConsent !== 'boolean') {
        return res.status(400).json({
          error: 'Analytics consent must be true or false.',
          field: 'analyticsConsent',
        });
      }
      updates.push('analytics_consent = ?'); values.push(req.body.analyticsConsent ? 1 : 0);
    }

    if (grade !== undefined) {
      if (!VALID_GRADES.includes(grade)) {
        return res.status(400).json({ error: `Grade must be one of: ${VALID_GRADES.join(', ')}`, field: 'grade' });
      }
      updates.push('grade = ?'); values.push(grade);
    }
    if (leaderboardOptIn !== undefined) { updates.push('leaderboard_opt_in = ?'); values.push(leaderboardOptIn ? 1 : 0); }
    if (emailOptOut !== undefined) { updates.push('email_opt_out = ?'); values.push(emailOptOut ? 1 : 0); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.user.id);
    await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: await selfUserResponse(row) });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// 20. Statistics endpoint for a volunteer

router.get('/api/user/preferences', authenticateToken, async (req, res) => {
  try {
    const prefs = await db.prepare('SELECT category, channel, enabled FROM notification_preferences WHERE user_id = ?').all(req.user.id);
    const userRow = await db.prepare('SELECT email_opt_out FROM users WHERE id = ?').get(req.user.id);

    res.json({
      globalEmailOptOut: userRow ? userRow.email_opt_out === 1 : false,
      preferences: prefs
    });
  } catch (error) {
    console.error('Fetch preferences error:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

router.post('/api/user/preferences', authenticateToken, async (req, res) => {
  try {
    const { category, channel, enabled } = req.body;
    
    if (category === 'global' && channel === 'email') {
      await db.prepare('UPDATE users SET email_opt_out = ? WHERE id = ?').run(enabled ? 0 : 1, req.user.id);
      return res.json({ success: true });
    }

    await db.prepare(`
      INSERT INTO notification_preferences (user_id, category, channel, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, category, channel) DO UPDATE SET enabled = excluded.enabled
    `).run(req.user.id, category, channel, enabled ? 1 : 0);

    res.json({ success: true });
  } catch (error) {
    console.error('Update preference error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});


export default router;
