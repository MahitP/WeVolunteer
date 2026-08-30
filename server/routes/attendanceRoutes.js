import express from 'express';

import QRCode from 'qrcode';

import { recordCheckins, checkinWindowState, getCheckins, finalizeAttendance, computeEventCompletion, slotHasStarted } from '../attendance.js';
import { authenticateToken } from '../utils.js';
import { runInTransaction } from '../db/connectionContext.js';
import { can, requireCap, requireCapAny } from '../authz.js';
import {
  issueCheckinToken, resolveCheckinToken, consumeCheckinToken, CODE_TTL_MS,
} from '../checkinTokens.js';
import { checkinCodeLimiter, checkinScanLimiter } from '../checkinLimiters.js';
import { notificationService } from '../services/notificationService.js';
import { certificateCodesFor } from '../certificates.js';
import { badgeService } from '../services/badgeService.js';
import { db } from '../db.js';
import { recordAudit } from '../auditLog.js';
import { canRunEvent } from '../organizations.js';
import { canSeeCertificates } from '../serviceVisibility.js';
import { markEventDirty } from '../search/eventIndexer.js';

const router = express.Router();

router.post('/api/events/:id/checkin', authenticateToken, requireCapAny(['attendance.mark', 'organization.event.manage.own']), async (req, res) => {
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const refusal = await hostRefusal(req.principal, event);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    /**
     * A cancelled event has no attendance to take.
     *
     * The finalise route below has refused this since it was written; check-in
     * did not, which left the two halves of one workflow disagreeing about
     * whether a cancelled event is still happening. Nothing here credits hours,
     * so the immediate cost was low — but it let a roster be marked present for
     * an event nobody held, and that record is what finalisation reads from if
     * the event is ever reinstated.
     */
    if (event.status === 'cancelled') {
      return res.status(409).json({
        error: 'This event was cancelled, so attendance cannot be taken for it.',
        code: 'event_cancelled',
      });
    }

    const now = new Date().toISOString();

    /* Marking a roster present before the shift exists is a prediction, not
       attendance. See `checkinWindowState` for why there is no closing time. */
    const window = await checkinWindowState(db, event, now);
    if (!window.open) {
      return res.status(409).json({
        error: 'Check-in opens two hours before the first shift starts.',
        code: 'checkin_not_open',
        opensAt: window.opensAt,
      });
    }

    const result = await recordCheckins(db, {
      event,
      checkinMap: req.body.checkinMap,
      actor: req.user,
      now
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Check-in error:', error);
    res.status(500).json({ error: 'Internal server error saving check-in' });
  }
});

router.get('/api/events/:id/checkin', authenticateToken, requireCapAny(['attendance.view', 'organization.event.manage.own']), async (req, res) => {
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const refusal = await hostRefusal(req.principal, event);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    res.json((await getCheckins(db, req.params.id)).map(c => ({
      slotId: c.slot_id, userId: c.user_id, present: c.present === 1, markedAt: c.marked_at
    })));
  } catch (error) {
    console.error('Check-in fetch error:', error);
    res.status(500).json({ error: 'Internal server error loading check-in' });
  }
});

// 9b. Finalise attendance and credit hours (Organizer only)
//
// The only path that changes a volunteer's credited hours. It touches only the
// records named in the request — never the rest — so a partial or stale submission
// can no longer mark anyone absent, and a credit can only be removed by an
// explicit instruction that carries a reason.
router.post('/api/events/:id/attendance', authenticateToken, requireCapAny(['attendance.mark', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;
  const { attendanceMap, hoursMap, reason } = req.body;

  if (!attendanceMap || typeof attendanceMap !== 'object' || Array.isArray(attendanceMap)) {
    return res.status(400).json({ error: 'attendanceMap is required' });
  }

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    // Deliberate correction (v1.2a): admin may confirm attendance on any event,
    // same as attendance.mark grants them elsewhere — only an organizer
    // (lacking event.moderate) is additionally bound to hosting the event
    // themselves.
    const refusal = await hostRefusal(req.principal, event);
    if (refusal) return res.status(refusal.status).json(refusal.body);
    if (event.status === 'cancelled') {
      return res.status(409).json({ error: 'This event was cancelled, so hours cannot be credited for it.' });
    }

    const now = new Date().toISOString();
    let outcome;

    await runInTransaction(db, async (tx) => {
      outcome = await finalizeAttendance(tx, { event, attendanceMap, hoursMap, reason, actor: req.user, now });
      if (!outcome.ok) throw new AttendanceRefused(outcome);

      // Completion is what makes an event immutable, so it is only reached when
      // every shift has ended and every accepted volunteer has been accounted
      // for. A multi-day event is no longer frozen after its first morning.
      const completion = await computeEventCompletion(tx, eventId, now);
      outcome.completion = completion;
      if (completion.complete && event.status !== 'completed') {
        await tx.prepare("UPDATE events SET status = 'completed' WHERE id = ?").run(eventId);
        /* `completed` is indexed metadata, so the index has to hear about it —
           this is the transition that moves an event out of the default
           `listable` scope a student browses. It is NOT the hours close-out,
           which is a separate lifecycle and deliberately not indexed at all. */
        await markEventDirty(tx, eventId);
        outcome.eventCompleted = true;
      }
    });

    for (const c of outcome.credited) {
      /**
       * Which sentence the volunteer reads, decided from what actually happened.
       *
       * This dispatched `HOURS_APPROVED` — "Volunteer hours added — you earned N
       * hours" — for every row in `credited`, and `credited` means "ends up with
       * a credit", not "gained one". Two things came out wrong:
       *
       *   • An organizer correcting four hours down to one sent the volunteer a
       *     message announcing they had EARNED one hour. The `HOURS_ADJUSTED`
       *     template already existed and said the right thing; it was reachable
       *     only when somebody was marked absent.
       *   • A participation event — a donation drive, `credits_hours = 0` —
       *     told everybody who turned up "you earned 0 hours". Every other
       *     surface in the product checks that flag before printing a number.
       *     This loop was the one that did not.
       */
      const wentDown = c.action === 'adjusted'
        && c.hoursBefore !== null && Number(c.hours) < Number(c.hoursBefore);

      await notificationService.dispatch(
        wentDown ? 'HOURS_ADJUSTED' : 'HOURS_APPROVED',
        {
          eventId: event.id,
          eventTitle: event.title,
          hours: Number(c.hours),
          /* Lets the template drop the figure entirely for an event that does
             not measure service in hours. */
          awardsHours: c.awardsHours !== false,
        },
        c.userId
      );

      // Evaluate badge eligibility with newly approved hours
      await badgeService.evaluateBadges(c.userId);
      
      // If the event is fully completed and this user was credited hours, their certificate is ready
      if (outcome.eventCompleted) {
        await notificationService.dispatch(
          'CERTIFICATE_AVAILABLE',
          { eventId: event.id, eventTitle: event.title },
          c.userId,
          `cert:${event.id}` // dedupe key
        );
      }
    }
    for (const r of outcome.revoked) {
      /**
       * Re-evaluated BEFORE the `wasCredited` guard, and deliberately.
       *
       * This loop used to notify and move on, so the single action that can
       * take a badge away was the one path that never recomputed one. A
       * volunteer marked absent kept an hour tier they no longer reached, and
       * kept a reliability badge their record no longer supported —
       * `evaluateBadges` has always known how to withdraw an automatic award,
       * it was simply never asked on the way down.
       *
       * Above the guard because that guard is about NOTIFYING. Somebody who was
       * never credited has had nothing taken from them and should not be told
       * their hours changed — but being marked absent still changes the
       * denominator their reliability is computed from, so their badges still
       * need recomputing.
       */
      await badgeService.evaluateBadges(r.userId);

      if (!r.wasCredited) continue; // never credited, so nothing was taken away
      await notificationService.dispatch(
        'HOURS_ADJUSTED',
        { eventId: event.id, eventTitle: event.title, hours: 0 },
        r.userId
      );
    }

    res.json({ success: true, ...outcome });
  } catch (error) {
    if (error instanceof AttendanceRefused) {
      const { error: code, message, ...rest } = error.outcome;
      /* `reason_required` and `invalid_hours` are both malformed submissions —
         400. `shift_not_ended`, `slot_unpriceable` and `hours_locked` are
         well-formed requests refused by the state of the world — the shift has
         not happened yet, the event's own times are broken, or the event has
         been closed out and its hours are final — so all three are 409s. The
         distinction is whether the caller could fix it by resending different
         values. */
      const badRequest = code === 'reason_required' || code === 'invalid_hours';
      return res.status(badRequest ? 400 : 409).json({ error: message, code, ...rest });
    }
    console.error('Confirm attendance error:', error);
    res.status(500).json({ error: 'Internal server error confirming attendance records' });
  }
});

/** Thrown to roll the transaction back when finalisation is refused. */
class AttendanceRefused extends Error {
  constructor(outcome) {
    super(outcome.message);
    this.outcome = outcome;
  }
}

/**
 * 9c. Close the hours out — the deliberate act that makes them permanent.
 *
 * ── Why this exists as an act rather than as a consequence ──
 *
 * The alternative was to freeze hours the moment `events.status` becomes
 * `completed`, and it fails on what `completed` actually is: not a decision, but
 * a side effect of `computeEventCompletion` finding that every accepted
 * volunteer now has a record. On a single-volunteer event the first save would
 * both credit the student and freeze the number, so a mistyped 40 would be
 * permanent before anybody looked at it — and the whole reason `finalizeAttendance`
 * demands a reason and writes a ledger entry is that corrections are expected.
 * It would also contradict this API's own words: `PUT /api/events/:id` refuses a
 * completed event with "…its details can no longer be changed. Attendance can
 * still be corrected."
 *
 * So closing out is pressed, not reached.
 *
 * ── The preconditions, and why each one ──
 *
 *   · The event must be `completed`. That is the platform's existing statement
 *     that every shift has ended and every accepted volunteer is accounted for,
 *     so it is exactly the condition under which "these are the final numbers"
 *     can be true. Closing out earlier would freeze a roster with people still
 *     to credit, and they could then never be credited by anyone.
 *   · A cancelled event has no hours to close out, and `finalizeAttendance`
 *     already refuses to credit one.
 *   · Not already closed out — 409 rather than a silent success, because the
 *     second caller is either a double-click or a second organizer, and both
 *     deserve to be told which of them it was and when.
 *
 * ── One-way, deliberately ──
 *
 * There is no reopen route and no `DELETE`. "No takebacksies" is the product
 * requirement, and a reopen endpoint is the hole through which every bypass of
 * it would go. `PATCH /api/events/:id/status` already refuses a completed event,
 * so the precondition cannot be unwound either.
 */
router.post('/api/events/:id/hours/close-out', authenticateToken, requireCapAny(['attendance.mark', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const refusal = await hostRefusal(req.principal, event);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    if (event.hours_closed_out_at) {
      return res.status(409).json({
        error: 'The hours for this event were already closed out.',
        code: 'already_closed_out',
        closedOutAt: event.hours_closed_out_at,
      });
    }
    if (event.status === 'cancelled') {
      return res.status(409).json({
        error: 'This event was cancelled, so there are no hours to close out.',
        code: 'event_cancelled',
      });
    }
    if (event.status !== 'completed') {
      return res.status(409).json({
        error: 'Every shift has to have ended and every confirmed volunteer has to be '
          + 'accounted for before the hours can be closed out. Finalise the roster first.',
        code: 'event_not_complete',
      });
    }

    const now = new Date().toISOString();
    /**
     * Guarded in the UPDATE as well as above.
     *
     * The read and the write are two statements, so two organizers pressing at
     * once could both pass the check. `WHERE hours_closed_out_at IS NULL` makes
     * the database the arbiter, and `changes === 0` means somebody else won —
     * which is reported as the same 409 rather than as a success that overwrote
     * their attribution with ours.
     */
    const result = await db.prepare(
      `UPDATE events SET hours_closed_out_at = ?, hours_closed_out_by = ?
        WHERE id = ? AND hours_closed_out_at IS NULL`
    ).run(now, req.user.id, eventId);

    if (result.changes === 0) {
      const fresh = await db.prepare('SELECT hours_closed_out_at FROM events WHERE id = ?').get(eventId);
      return res.status(409).json({
        error: 'The hours for this event were already closed out.',
        code: 'already_closed_out',
        closedOutAt: fresh?.hours_closed_out_at ?? null,
      });
    }

    /**
     * Recorded in the audit trail, because this is the one action on the
     * platform that makes a student's service record unchangeable. The ledger
     * records every change to hours and had nothing to say about the decision to
     * allow no more.
     */
    await recordAudit(db, {
      adminId: req.user.id,
      action: 'EVENT_HOURS_CLOSED_OUT',
      targetUserId: null,
      details: `Closed out the hours for "${event.title}" (${event.id}). `
        + 'Credited hours for this event can no longer be changed.',
    });

    res.json({ success: true, closedOutAt: now, closedOutBy: req.user.id });
  } catch (error) {
    console.error('Close out hours error:', error);
    res.status(500).json({ error: 'Internal server error closing out hours' });
  }
});

// 10. Edit Event Details and Slots (Organizer only)

router.get('/api/events/:id/roster.csv', authenticateToken, requireCapAny(['attendance.view', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    // event.moderate is the "may act on any event" bypass; an organizer
    // (lacking it) is bound to the event they host.
    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const rows = await db.prepare(`
      SELECT u.name, u.email, u.school, u.grade, s.name as slot_name,
             s.start_datetime, s.end_datetime, a.status, a.applied_at
      FROM applications a
      JOIN users u ON a.user_id = u.id
      JOIN slots s ON a.slot_id = s.id
      WHERE a.event_id = ? AND a.status = 'accepted'
      ORDER BY s.start_datetime, u.name
    `).all(eventId);

    const calcHours = (start, end) => Math.max(0.1, Number(((new Date(end) - new Date(start)) / 3600000).toFixed(2)));
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const csvLines = [
      'Name,Email,School,Grade,Slot,Start,End,Hours,Status,Applied At',
      ...rows.map(r => [
        cell(r.name),
        cell(r.email),
        cell(r.school),
        cell(r.grade),
        cell(r.slot_name),
        cell(new Date(r.start_datetime).toLocaleString()),
        cell(new Date(r.end_datetime).toLocaleString()),
        calcHours(r.start_datetime, r.end_datetime),
        r.status,
        cell(new Date(r.applied_at).toLocaleString())
      ].join(','))
    ];

    const filename = `${event.title.replace(/[^a-z0-9]/gi, '_')}_roster.csv`;
    /**
     * The one bulk export of minors' contact details on the platform, recorded.
     *
     * A Student Organizer reaches this for the events they run, which is the
     * point of the rank — but "who took the whole roster, and when" is the
     * question an organization asks after something goes wrong, and it had no
     * answer anywhere. The row names the caller and the event; it does not
     * repeat the data.
     */
    await recordAudit(db, {
      adminId: req.principal.userId,
      action: 'ORGANIZATION_ROSTER_EXPORTED',
      targetUserId: null,
      details: `Exported the accepted roster for "${event.title}" (${event.id})`,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvLines.join('\n'));
  } catch (error) {
    console.error('CSV export error:', error);
    res.status(500).json({ error: 'Internal server error exporting roster' });
  }
});

router.get('/api/certificates', authenticateToken, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT e.id as event_id, e.title, e.category, e.location,
             u.name as organizer_name, u.verified as organizer_verified,
             COALESCE(SUM(at.hours_awarded), 0) as hours,
             COUNT(*) as shifts,
             MIN(s.start_datetime) as first_start,
             MAX(s.end_datetime) as last_end,
             /* So a certificate can be shown in its organization's context
                without a second certificate system. See §11 of the brief:
                certificates stay their own feature and are merely associated. */
             e.organization_id as organization_id, o.name as organization_name,
             o.slug as organization_slug
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      JOIN events e ON at.event_id = e.id
      JOIN users u ON e.organizer_id = u.id
      LEFT JOIN organizations o ON o.id = e.organization_id
      /* A called-off event is not completed service, so it has no certificate
         to list - the same rule the transcript and the hours figures follow.
         An already-issued certificate is never revoked; see the note in
         certificates.js. */
      WHERE at.user_id = ? AND at.present = 1 AND e.status <> 'cancelled'
      /* The joined tables' keys are grouped too, not just the event's.
         PostgreSQL lets an aggregate query select a column it did not group by
         only when that column is functionally dependent on a grouped PRIMARY
         KEY, and that reasoning is per table. Grouping by e.id alone covers
         e.title and e.category, but u.name and o.name come from other tables,
         so PostgreSQL refused the whole query and this endpoint answered 500.
         SQLite picks an arbitrary row for a bare column instead, which is why
         it worked there. Adding the keys changes no grouping: an event has
         exactly one organizer and one organization. */
      GROUP BY e.id, u.id, o.id
      ORDER BY last_end DESC
    `).all(req.user.id);

    /* One query for the page's codes rather than a lookup per row. See
       `certificateCodesFor`: a volunteer's list grows with their service record,
       so a per-row lookup made the page cost more the more somebody had
       volunteered — measured at p50 914ms for an 80-event history. */
    const codes = await certificateCodesFor(db, req.user.id, rows.map(r => r.event_id));

    res.json(rows.map((r) => ({
      eventId: r.event_id,
      title: r.title,
      category: r.category,
      location: r.location,
      organizerName: r.organizer_name,
      organizerVerified: r.organizer_verified === 1,
      hours: Number(r.hours),
      shifts: r.shifts,
      startDatetime: r.first_start,
      endDatetime: r.last_end,
      organizationId: r.organization_id ?? null,
      organizationName: r.organization_name ?? null,
      organizationSlug: r.organization_slug ?? null,
      code: codes.get(r.event_id) ?? null
    })));
  } catch (err) {
    console.error('Certificates error:', err);
    res.status(500).json({ error: 'Failed to load certificates' });
  }
});

/**
 * Somebody else's certificates — what they earned, never a way to hold it.
 *
 * ── The two things this must not do ──
 *
 * 1. It must not emit `code`. The code is a BEARER CREDENTIAL: whoever holds it
 *    can call `/api/certificates/verify/:code` and be handed a verified record
 *    in this student's name. `/api/certificates` gives you your own codes so you
 *    can print them; handing somebody else's out would turn "see that Sam
 *    volunteered" into "produce Sam's certificate on demand", which is the
 *    difference between a profile and an impersonation kit.
 *
 * 2. It must not answer at all when the subject has made certificates private —
 *    and that includes not answering with a COUNT. An empty array and a
 *    forbidden response are different facts, and returning `[]` for a private
 *    collection tells the caller the setting is on while a 200 with three rows
 *    tells them it is off. So a private collection is a 403 with a code the UI
 *    reads, not an empty success.
 *
 * The subject always sees their own here, so one page can serve both readers.
 */
router.get('/api/users/:id/certificates', authenticateToken, requireCap('directory.read'), async (req, res) => {
  try {
    const subject = await db.prepare(
      "SELECT id, name, username, certificates_visibility FROM users WHERE id = ? AND account_status <> 'deleted'"
    ).get(req.params.id);
    /* Same refusal for "no such account" and "not visible" would be wrong here:
       the account's existence is already public from the profile route, so a
       404 that means both would make a live profile look broken. */
    if (!subject) return res.status(404).json({ error: 'No such account.', code: 'not_found' });

    const viewerId = req.principal?.userId ?? req.user?.id ?? null;
    const canSeeContact = can(req.principal, 'user.contact.read');

    if (!canSeeCertificates(subject, { viewerId, canSeeContact })) {
      return res.status(403).json({
        error: 'This volunteer keeps their certificates private.',
        code: 'certificates_private',
      });
    }

    const rows = await db.prepare(`
      SELECT e.id as event_id, e.title, e.category,
             u.name as organizer_name, u.verified as organizer_verified,
             COALESCE(SUM(at.hours_awarded), 0) as hours,
             COUNT(*) as shifts,
             MIN(s.start_datetime) as first_start,
             MAX(s.end_datetime) as last_end
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      JOIN events e ON at.event_id = e.id
      JOIN users u ON e.organizer_id = u.id
      WHERE at.user_id = ? AND at.present = 1
      /* u.id as well as e.id — see the note on the same shape above. */
      GROUP BY e.id, u.id
      ORDER BY last_end DESC
    `).all(req.params.id);

    res.json({
      volunteer: { id: subject.id, name: subject.name, username: subject.username || null },
      isSelf: viewerId === subject.id,
      certificates: rows.map(r => ({
        eventId: r.event_id,
        title: r.title,
        category: r.category,
        organizerName: r.organizer_name,
        organizerVerified: r.organizer_verified === 1,
        hours: Number(r.hours),
        shifts: r.shifts,
        startDatetime: r.first_start,
        endDatetime: r.last_end,
        /* No `code`, and no `location`. The code is a bearer credential; the
           location is where a named minor physically was on a given date, which
           the itemised service record is already gated on and which a
           certificate list has no reason to republish. */
      })),
    });
  } catch (err) {
    console.error('Public certificates error:', err);
    res.status(500).json({ error: 'Failed to load certificates' });
  }
});

// Public check of a certificate code — how a school office verifies a
// printout. A single indexed lookup by the stored code — never a scan over
// every certificate — and deliberately omits grade from the response: the
// code is a bearer credential handed to whoever is verifying, not proof of
// who they are, so it should disclose only what a printed certificate
// itself would (name, event, organizer, hours, date).
router.get('/api/certificates/verify/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    const cert = await db.prepare('SELECT * FROM certificates WHERE code = ?').get(code);
    if (!cert) return res.status(404).json({ valid: false, error: 'No certificate matches that code' });

    if (cert.volunteer_name_snapshot) {
      return res.json({
        valid: true,
        volunteerName: cert.volunteer_name_snapshot,
        eventTitle: cert.event_name_snapshot,
        organizerName: cert.organization_snapshot,
        hours: Number(cert.hours_snapshot),
        completedAt: cert.completed_at_snapshot
      });
    }

    const row = await db.prepare(`
      SELECT u.name AS volunteer_name, e.title, org.name AS organizer_name,
             COALESCE(SUM(at.hours_awarded),0) AS hours, MAX(s.end_datetime) AS last_end
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      JOIN events e ON at.event_id = e.id
      JOIN users u ON at.user_id = u.id
      JOIN users org ON e.organizer_id = org.id
      WHERE at.user_id = ? AND at.event_id = ? AND at.present = 1
      /* The joined tables' keys are grouped too. PostgreSQL allows an ungrouped
         column only when it is functionally dependent on a grouped PRIMARY KEY,
         and that holds per table, so u.name and org.name need u.id and org.id
         here, exactly as the certificate list above does. Without them this
         endpoint answered 500. (No backticks: this comment lives inside a
         template literal.) */
      GROUP BY at.user_id, e.id, u.id, org.id
    `).get(cert.user_id, cert.event_id);
    if (!row) return res.status(404).json({ valid: false, error: 'No certificate matches that code' });

    res.json({
      valid: true,
      volunteerName: row.volunteer_name,
      eventTitle: row.title,
      organizerName: row.organizer_name,
      hours: Number(row.hours),
      completedAt: row.last_end
    });
  } catch {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── Organizer profile ───────────────────────────────────────────────
// The page a student checks before trusting an event.

/* ── QR check-in ─────────────────────────────────────────────────────────── */

/**
 * The one place the "do you host this event?" question is answered.
 *
 * The same four lines were copy-pasted at every organizer-scoped route in this
 * file, and the QR scan route would have been the fifth. Extracted rather than
 * copied again; the four existing sites now call it too, so a change to the
 * rule reaches all of them.
 *
 * `event.moderate` is the "may act on any event" bypass, the same idiom used
 * for `event.edit.own` elsewhere.
 */
async function hostRefusal(principal, event) {
  /* `canRunEvent`, not a bare `organizer_id` compare: an event published under
     a club's name is the club's to run, so its managers reach check-in and
     attendance too. Without that, an event posted by a Student Organizer who
     was later demoted had NOBODY who could record who turned up — and this is
     the only path that writes credited hours. */
  if (await canRunEvent(db, event, principal.userId, { hasModerate: can(principal, 'event.moderate') })) return null;
  return { status: 403, body: { error: 'Access denied: You do not host this event' } };
}

/**
 * Mints a five-minute check-in code for one of the caller's own accepted shifts.
 *
 * POST rather than GET because it creates a token and retires the previous one.
 * A GET that mutated would also land the code in browser history and be
 * prefetchable by anything that speculatively loads links.
 *
 * The application is the resource because it is the one object naming a user, a
 * slot and an event at once — and because `recordCheckins`, the canonical
 * writer this eventually reaches, is keyed by application id.
 */
router.post(
  '/api/applications/:applicationId/checkin-code',
  authenticateToken,
  requireCap('qr.present'),
  checkinCodeLimiter,
  async (req, res) => {
    try {
      const app = await db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.applicationId);

      /**
       * An application that is not the caller's own gets the same 404 as one
       * that does not exist.
       *
       * A 403 would confirm the id is real, and application ids are
       * `app-<timestamp>-<six chars>` — a walkable space. The same reasoning,
       * and the same 404, as `POST /api/appeals`.
       */
      if (!app || app.user_id !== req.user.id) {
        return res.status(404).json({ error: 'We could not find that shift signup.', code: 'application_not_found' });
      }
      if (app.status !== 'accepted') {
        return res.status(409).json({
          error: 'Your place at this shift is not confirmed yet, so there is no code to show.',
          code: 'not_accepted',
        });
      }

      const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(app.event_id);
      const slot = await db.prepare('SELECT * FROM slots WHERE id = ?').get(app.slot_id);
      if (!event || !slot) {
        return res.status(404).json({ error: 'We could not find that shift signup.', code: 'application_not_found' });
      }

      if (event.status === 'cancelled') {
        return res.status(409).json({
          error: 'This event was cancelled, so attendance cannot be taken for it.',
          code: 'event_cancelled',
        });
      }

      const now = new Date();
      const started = slotHasStarted(slot, now);
      if (started === null) {
        return res.status(409).json({
          error: "This shift's start time cannot be read. Ask the organizer to check you in by name.",
          code: 'slot_unreadable',
        });
      }
      if (started === false) {
        return res.status(409).json({
          error: 'Your code becomes available when the shift starts.',
          code: 'checkin_not_started',
          startsAt: slot.start_datetime,
        });
      }

      const issued = await runInTransaction(db, async (tx) => await issueCheckinToken(tx, { application: app, now }));

      /**
       * Rendered server-side, with the existing `qrcode` dependency.
       *
       * Three reasons rather than sending the string and drawing it in the
       * browser: it keeps a QR library out of the client bundle, it makes the
       * black-on-white quiet zone unconditional regardless of the viewer's
       * theme (a dark-mode QR is unreadable), and it keeps the colour literals
       * in server code, which the no-hardcoded-colours guard does not scan.
       */
      const qr = await QRCode.toDataURL(issued.token, {
        errorCorrectionLevel: 'M',
        margin: 4,
        width: 320,
        color: { dark: '#000000ff', light: '#ffffffff' },
      });

      res.json({
        token: issued.token,
        qr,
        issuedAt: issued.issuedAt,
        expiresAt: issued.expiresAt,
        ttlSeconds: Math.round(CODE_TTL_MS / 1000),
        eventTitle: event.title,
        slotName: slot.name,
        displayName: req.user.username ? `@${req.user.username}` : req.user.name,
      });
    } catch (err) {
      console.error('Check-in code error:', err.message);
      res.status(500).json({ error: 'Could not create a check-in code' });
    }
  },
);

/**
 * Scans a volunteer's code and checks them in.
 *
 * ── The guard order matters, and this is the order ──
 *
 * The host check runs BEFORE the token is looked at, so somebody who does not
 * host this event cannot burn a stranger's live code by scanning it. The whole
 * refusal cascade is the manual route's, verbatim, so a QR refusal is shaped
 * exactly like the refusal an organizer already knows.
 *
 * ── What is deliberately NOT here ──
 *
 * No new time bound. Generation already requires the slot to have started, so a
 * code cannot exist before then, and check-in has an opening time and no
 * closing time on purpose — organizers reconcile after the fact. A volunteer
 * arriving two hours late is an ordinary case, not an attack.
 *
 * ── The capability ──
 *
 * `attendance.scan` names the power and is withheld until the Organizer
 * Agreement is signed, which must survive. But it alone would lock out admins,
 * who hold `attendance.mark` and can already do this by hand — an arbitrary gap
 * with no security story. Granting admins `attendance.scan` instead would
 * silently widen an agreement-gated capability onto the one role that agreement
 * deliberately does not bind. `requireCapAny` says "either way in is
 * legitimate" without touching the capability table.
 */
router.post(
  '/api/events/:id/checkin/scan',
  authenticateToken,
  requireCapAny(['attendance.scan', 'attendance.mark', 'organization.event.manage.own']),
  checkinScanLimiter,
  async (req, res) => {
    try {
      /* Exactly one field is read from the body. A `slotId` or `userId` here
         would be a value the volunteer's device chose, and a field that does
         not exist cannot be trusted by a later edit. */
      const { token } = req.body || {};
      if (typeof token !== 'string' || !token || token.length > 200) {
        return res.status(400).json({ error: 'No code was read. Try scanning again.', code: 'token_required' });
      }

      const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const refusal = await hostRefusal(req.principal, event);
      if (refusal) return res.status(refusal.status).json(refusal.body);

      if (event.status === 'cancelled') {
        return res.status(409).json({
          error: 'This event was cancelled, so attendance cannot be taken for it.',
          code: 'event_cancelled',
        });
      }

      const now = new Date();
      const nowIso = now.toISOString();

      const window = await checkinWindowState(db, event, nowIso);
      if (!window.open) {
        return res.status(409).json({
          error: 'Check-in opens two hours before the first shift starts.',
          code: 'checkin_not_open',
          opensAt: window.opensAt,
        });
      }

      const resolved = await resolveCheckinToken(db, { token, eventId: event.id, now });
      if (!resolved.ok) {
        /* The real reason goes to the log, never to the caller, and never with
           the code or its hash in it. */
        console.warn(`[check-in] ${resolved.logReason} (event ${event.id}, actor ${req.user.id})`);
        /**
         * Only these three fields are sent.
         *
         * Destructuring the rest of `resolved` would have shipped `logReason`
         * to the caller — the precise reason the code failed, which is the one
         * thing the collapsed refusals exist to withhold. Naming the fields
         * means a field added to the resolver later cannot leak by default.
         */
        return res.status(resolved.status).json({
          ok: false,
          code: resolved.code,
          error: resolved.error,
        });
      }

      const row = resolved.row;

      /**
       * The row is a pointer, not an authority.
       *
       * Minutes may have passed since the code was minted, and a volunteer can
       * have been un-accepted in them. Everything is re-read and re-checked
       * here, and then `recordCheckins` validates it a third time — it is the
       * canonical writer and stays the single source of truth about what a
       * check-in means.
       */
      const app = await db.prepare('SELECT * FROM applications WHERE id = ?').get(row.application_id);
      if (!app || app.event_id !== event.id || app.status !== 'accepted') {
        console.warn(`[check-in] signup no longer eligible (event ${event.id}, actor ${req.user.id})`);
        return res.status(422).json({
          code: 'code_invalid',
          error: 'That code did not work. Ask the volunteer to refresh it, or check them in by name.',
        });
      }

      const volunteer = await db.prepare('SELECT id, name, avatar FROM users WHERE id = ?').get(app.user_id);
      const slot = await db.prepare('SELECT id, name FROM slots WHERE id = ?').get(app.slot_id);

      const already = await db.prepare(
        'SELECT present FROM attendance_checkin WHERE slot_id = ? AND user_id = ?'
      ).get(app.slot_id, app.user_id);

      const outcome = await runInTransaction(db, async (tx) => {
        /**
         * Spending the code is what makes a replay safe, and it is done inside
         * the transaction with the mark.
         *
         * The `status = 'pending'` predicate is the whole of it: two organizers
         * scanning the same phone in the same instant both reach here, and
         * exactly one UPDATE matches a row.
         */
        if (!await consumeCheckinToken(tx, { tokenId: row.id, actorId: req.user.id, now })) {
          return { raced: true };
        }
        return await recordCheckins(tx, {
          event,
          checkinMap: { [app.id]: true },
          actor: req.user,
          now: nowIso,
          method: 'qr',
        });
      });

      if (outcome.raced) {
        console.warn(`[check-in] code spent concurrently (event ${event.id}, actor ${req.user.id})`);
        return res.status(422).json({
          code: 'code_invalid',
          error: 'That code did not work. Ask the volunteer to refresh it, or check them in by name.',
        });
      }

      /**
       * Already present is a 200, not an error.
       *
       * The outcome the organizer wanted is already true. Returning an error
       * would tell them it failed, and they would redo it by hand — turning a
       * successful check-in into a support question.
       */
      res.json({
        success: true,
        marked: outcome.marked,
        alreadyPresent: already?.present === 1,
        volunteer: volunteer
          ? { id: volunteer.id, name: volunteer.name, avatar: volunteer.avatar }
          : null,
        slot: slot ? { id: slot.id, name: slot.name } : null,
      });
    } catch (err) {
      console.error('Check-in scan error:', err.message);
      res.status(500).json({ error: 'Internal server error recording check-in' });
    }
  },
);

export default router;
