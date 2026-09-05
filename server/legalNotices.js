import { effectiveDocuments, currentRevision, legalDay } from './legalStore.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { documentBySlug, publishedBody, POLICY_DIR } from './legalDocuments.js';
import { buildExcerpt } from './legalExcerpt.js';
import {
  CHANNEL_ACCEPTANCE, CHANNEL_AGREEMENT, MATERIAL, changeSeverity, isBehind,
  newestSeenVersion, noticeChannelFor,
} from './legalConsentGate.js';
import { runInTransaction } from './db/connectionContext.js';

/**
 * Telling people that a legal document changed.
 *
 * ── Why this exists ──
 *
 * The published Terms say, in the product's own words: "If a change matters, we
 * will tell you in the app at least 30 days before it takes effect… We will not
 * change them quietly." The Privacy Policy says the same. Until now nothing
 * implemented it for anyone except organizers, who are re-gated on the
 * Organizer Agreement as a side effect of how their capabilities are withheld.
 *
 * So this is not a feature so much as a promise being kept.
 *
 * ── What counts as "changed" ──
 *
 * A document has changed for a user when the version now in effect is newer than
 * the newest version they have either acknowledged or accepted. Version, not
 * content hash: an editorial fix that leaves the hash different but the meaning
 * identical still bumps a version deliberately, and the version is the thing the
 * acceptance record is keyed on.
 *
 * ── And how much it matters ──
 *
 * Each change is labelled with a `channel`, which decides which surface carries
 * it, and the rule behind that label lives in `legalConsentGate.js` — the same
 * module the capability gate reads, so the banner cannot call routine a change
 * the server is withholding capabilities over. In short:
 *
 *   'notice'     → the ordinary banner. A clarification, or a material change
 *                  that has not reached its effective date yet.
 *   'acceptance' → the mandatory modal. A signup document whose MAJOR version
 *                  moved and has taken effect.
 *   'agreement'  → dropped from this list entirely. The Organizer Agreement and
 *                  the Student Organizer Agreement have their own re-acceptance
 *                  screens, already enforced by capability withholding, and a
 *                  notice about a change that is about to be put in front of
 *                  somebody in full is the same thing said twice.
 *
 * A brand-new user is not "behind" on anything — they get the current version at
 * signup and nothing to acknowledge. This is handled by treating an absent
 * acceptance for a signup-scope document as up to date rather than as a change,
 * because there is nothing they could have been told about.
 *
 * ── Cost ──
 *
 * One query for the effective versions (already batched by `effectiveDocuments`),
 * one for this user's acknowledgements, one for their acceptances. Three
 * queries, no per-document round trip, and the excerpt is only computed for
 * documents that actually differ — which is almost always none, so the common
 * case reads three rows and returns an empty array.
 */

/**
 * The body of the version immediately before the current one, or null.
 *
 * Two sources by necessity. Documents edited through the Legal Center have every
 * revision in `legal_document_revisions`, bodies included. Documents still at
 * their original 1.0 have no revision row at all — their text lives on disk — so
 * the first edit of any document has to diff against the file. Without that
 * fallback the very first change of every document would produce no excerpt,
 * which is the one time users most need to see what moved.
 */
async function previousBody(db, slug, currentVersion) {
  const rows = await db.prepare(`
    SELECT version, body FROM legal_document_revisions
    WHERE slug = ? ORDER BY id DESC LIMIT 2
  `).all(slug);

  const earlier = rows.find(r => r.version !== currentVersion);
  if (earlier) return earlier.body;

  /* No earlier revision: the previous text is whatever is on disk. */
  return fileBody(slug);
}

/**
 * A document's published text as it sits in the repository.
 *
 * Wrapped in a try because `publishedBody` throws when a file has lost its
 * `## Draft` marker — correct behaviour there, since serving the drafting brief
 * as the terms would be far worse than failing. Here the consequence of a
 * missing file is only a notice without a quote, which the modal already
 * handles, so it degrades rather than taking the whole request down.
 */
function fileBody(slug) {
  const doc = documentBySlug(slug);
  if (!doc?.file) return null;
  try {
    return publishedBody(readFileSync(path.join(POLICY_DIR, doc.file), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The two baselines, kept apart because they answer different questions.
 *
 * ── Why one number is not enough ──
 *
 * "Has this person been TOLD the document changed" and "has this person AGREED
 * to it" are different facts, and a single high-water mark across both tables
 * conflates them in a way that is worse than merely imprecise. It produced a
 * lockout, found by `routes.legalReconsent.test.js`:
 *
 *   1. A major revision takes effect. The capability gate withholds, correctly,
 *      because `pendingSignupAcceptances` reads ACCEPTANCES only.
 *   2. Something dismisses the notice for that version — a stale banner, a
 *      retry, a client calling the acknowledge endpoint.
 *   3. The combined baseline now equals the current version, so this function
 *      reports nothing pending.
 *
 * The account is left unable to apply to an event, with the endpoint that
 * exists to tell it why answering "nothing to do". The dialog that is the only
 * way out never renders, and there is nothing on screen connecting the refusals
 * to anything the person can act on.
 *
 * So `acknowledged` decides whether to ANNOUNCE, and `accepted` alone decides
 * whether an acceptance is still owed. That also keeps the promise migration
 * 039 was written for from the other direction: dismissing a popup cannot
 * discharge an obligation to agree.
 *
 * Both are lists rather than one value each — see `newestSeenVersion` for the
 * three separate ways "whichever row came back last" was wrong.
 */
async function seenVersionsFor(db, userId) {
  const acknowledged = new Map();
  const accepted = new Map();
  const add = (map, slug, version) => {
    const list = map.get(slug) ?? [];
    list.push(version);
    map.set(slug, list);
  };

  for (const r of await db.prepare(
    'SELECT slug, version FROM legal_change_notices WHERE user_id = ? AND acknowledged_at IS NOT NULL'
  ).all(userId)) add(acknowledged, r.slug, r.version);

  for (const r of await db.prepare(
    'SELECT document_slug AS slug, version FROM legal_acceptances WHERE user_id = ?'
  ).all(userId)) add(accepted, r.slug, r.version);

  return { acknowledged, accepted };
}

/**
 * Legal documents this user has not been shown the change to.
 *
 * @returns {Array<{slug, title, version, previousVersion, effectiveAt, severity,
 *   channel, requiresAcceptance, excerpt, changeCount, isSample}>}
 */
export async function pendingNoticesFor(db, userId, { now = new Date() } = {}) {
  if (!userId) return [];

  const { acknowledged, accepted } = await seenVersionsFor(db, userId);
  const today = legalDay(now);

  const pending = [];
  for (const doc of await effectiveDocuments(db)) {
    /**
     * The acceptance question first, because an acknowledgement cannot answer it.
     *
     * If this document still owes an acceptance then it is reported however
     * many notices have been dismissed for it, at the version last ACCEPTED.
     * See the note on `seenVersionsFor`: the alternative is an account the
     * capability gate is withholding from and an endpoint that says there is
     * nothing to do.
     */
    const acceptedSeen = newestSeenVersion(accepted.get(doc.slug) ?? []);
    const owesAcceptance = Boolean(acceptedSeen)
      && isBehind(acceptedSeen, doc.version)
      && noticeChannelFor(doc, acceptedSeen, today) === CHANNEL_ACCEPTANCE;

    /**
     * Nothing to be behind on.
     *
     * A signup-scope document with no acceptance means the account predates the
     * consent record or the scope changed — either way there is no "previous
     * version they were shown", so announcing a change would be announcing
     * something that never happened to them. Notice-scope documents were never
     * accepted by anybody, so an absent record is normal and the current version
     * is the baseline.
     */
    const seen = owesAcceptance
      ? acceptedSeen
      : newestSeenVersion([
        ...(acknowledged.get(doc.slug) ?? []),
        ...(accepted.get(doc.slug) ?? []),
      ]);

    if (!seen) continue;
    /* Behind, not merely different — see `isBehind`. An account whose recorded
       version is AHEAD of the one in effect is not owed a notice about a change
       that has not happened. */
    if (!isBehind(seen, doc.version)) continue;

    const channel = noticeChannelFor(doc, seen, today);

    /* Owned by `/organizer-agreement` or `/student-organizer-agreement`, which
       will put the whole document in front of them. Saying it here first would
       be the same news twice, the second time with more authority. */
    if (channel === CHANNEL_AGREEMENT) continue;

    const current = await currentRevision(db, doc.slug, { withBody: true });
    const newBody = current?.body ?? fileBody(doc.slug);

    const excerpt = newBody
      ? buildExcerpt(await previousBody(db, doc.slug, doc.version), newBody)
      : { text: null, changeCount: 0, isSample: false };

    pending.push({
      slug: doc.slug,
      title: doc.title,
      version: doc.version,
      previousVersion: seen,
      effectiveAt: doc.effectiveAt ?? null,
      /**
       * `severity` and `channel` are not the same fact, and both are published.
       *
       * A MAJOR bump published today with an effective date in three weeks is
       * `severity: 'material'` and `channel: 'notice'` — material, and not yet
       * enforceable. The banner needs both: the first to say what kind of change
       * this is, the second to know it is the surface that carries it. Sending
       * only the channel would leave the client unable to tell an advance notice
       * of a material change from a clarification, and it says different things
       * about the two.
       */
      severity: changeSeverity(seen, doc.version),
      channel,
      /* The one the client routes on, stated as a boolean so no caller has to
         re-derive it from a string comparison. */
      requiresAcceptance: channel === CHANNEL_ACCEPTANCE,
      excerpt: excerpt.text,
      changeCount: excerpt.changeCount,
      isSample: excerpt.isSample,
    });
  }

  return pending;
}

/**
 * Records that a user has seen the notice for a version.
 *
 * Upsert on the primary key rather than an INSERT, so a double-click, a retry
 * and a second tab all converge on one row instead of racing to a constraint
 * error the caller has to interpret.
 */
export async function acknowledgeNotice(db, userId, slug, version, { now = new Date() } = {}) {
  await db.prepare(`
    INSERT INTO legal_change_notices (user_id, slug, version, acknowledged_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, slug, version)
      DO UPDATE SET acknowledged_at = COALESCE(legal_change_notices.acknowledged_at, excluded.acknowledged_at)
  `).run(userId, slug, version, now.toISOString());
}

/**
 * CLAIMS the right to notify this account about this version, exactly once.
 *
 * ── Why it returns a boolean, and why that is the whole design ──
 *
 * `notified_at` is not a log line written after the fact; it is a lease. The
 * sweep calls this FIRST, in the same transaction as the enqueue, and sends
 * nothing unless it comes back true. So the sequence of events is:
 *
 *   BEGIN → claim the row → enqueue the mail job → COMMIT
 *
 * and every failure mode lands somewhere safe. Two sweep passes racing (two
 * ticks overlapping, two processes, a restart mid-pass) both attempt the same
 * conditional update; the database decides, one of them gets `false`, and
 * exactly one mail job exists. A crash between the claim and the commit rolls
 * back both, so the next pass tries again. A crash after the commit leaves the
 * job in `notification_jobs`, which the outbox worker owns and retries with
 * backoff — so delivery is at-least-once against the provider and the CLAIM is
 * exactly-once, which is the correct split.
 *
 * The previous version wrote the timestamp with `COALESCE` and returned
 * nothing, which made it impossible for a caller to tell whether it had just
 * recorded the notification or was looking at somebody else's. That is fine for
 * a log and useless for a lease, and it is why nothing could safely use it.
 *
 * ── `DO UPDATE … WHERE`, not `COALESCE` ──
 *
 * The conditional form is what makes `changes` meaningful: 1 when this call
 * inserted the row or filled in a null `notified_at`, and 0 when the row
 * already carried one. `COALESCE` reports a change either way, because the row
 * is rewritten with the value it already had.
 *
 * The row may well already exist with `acknowledged_at` set and `notified_at`
 * null — somebody who dismissed the in-app banner before the sweep ran — and
 * that has to remain claimable. Acknowledgement is not delivery. Which is also
 * why this touches only `notified_at`: the two columns record two different
 * facts about two different actors and neither may overwrite the other.
 *
 * @returns {Promise<boolean>} true if THIS call recorded the notification.
 */
export async function recordNotified(db, userId, slug, version, { now = new Date() } = {}) {
  const result = await db.prepare(`
    INSERT INTO legal_change_notices (user_id, slug, version, notified_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, slug, version)
      DO UPDATE SET notified_at = excluded.notified_at
      WHERE legal_change_notices.notified_at IS NULL
  `).run(userId, slug, version, now.toISOString());

  return (result?.changes ?? 0) > 0;
}

/**
 * The dedupe key, in one place.
 *
 * A SECOND line of defence rather than the primary one. `recordNotified` above
 * is what makes delivery exactly-once; this is passed to
 * `notificationService.dispatch`, whose own seven-day window then also refuses
 * a duplicate in-app row. Belt and braces on purpose: the two mechanisms fail
 * differently — a lease survives a restart and a rolling window does not, and a
 * window catches a caller who forgot to lease.
 */
export function noticeDedupeKey(slug, version) {
  return `legal:${slug}:${version}`;
}

/* ────────────────────────────────────────────────────────────────────────────
   Delivery
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Telling people, through the channels that reach them when the app does not.
 *
 * ── Why this exists as a sweep and not as a fan-out at publish time ──
 *
 * Publishing a revision is one owner pressing Save inside a transaction that
 * also spends a step-up grant and writes an audit row. Fanning out to every
 * account inside it would put an unbounded loop in the critical path of the
 * one action that must not half-succeed, and would lose the whole notification
 * set if the process died between commit and the last send.
 *
 * A sweep inverts that: the durable state is the revision row, and the sweep
 * derives what still needs sending from it. So a publish that commits is enough
 * — the notifications follow within a tick whether or not the publishing
 * process survives, and a database restored from a backup taken mid-fan-out
 * simply resumes.
 *
 * It runs from `runNotificationSweep` (boot, then every fifteen minutes),
 * beside the shift reminders and deadline nudges, because it is the same kind
 * of thing and a second scheduler would be a second thing to start, stop and
 * forget.
 *
 * ── One message per person per document version ──
 *
 * Enforced by `recordNotified`, which is a lease rather than a log — see its
 * header. Nothing here is driven by a request, so no amount of refreshing,
 * signing in and out, navigating or polling can produce a second message: the
 * only thing that decides is whether the lease was still open.
 *
 * ── Which message ──
 *
 * By SEVERITY, not by which surface currently owns the change. A major revision
 * dated a month out is `channel: 'notice'` today and `channel: 'acceptance'`
 * next month, and it is the same change: the reader should be told once, at
 * publication, that it is significant and that they will be asked to accept it.
 * Keying the mail off the channel would send an ordinary "we clarified
 * something" note during the notice period and then a second, contradictory
 * one on the effective date.
 *
 * ── Delivery is not enforcement ──
 *
 * Nothing in this file gates anything. `signupConsentWithholdingsFor` reads
 * acceptance rows and the effective date and knows nothing about mail, so a
 * provider outage, a bounced address, an opted-out preference or a sweep that
 * never ran cannot release a capability or satisfy a re-consent. Equally, a
 * delivered email does not release one. The two systems share only the
 * `legal_change_notices` table, and only the columns that mean what they say.
 */

/**
 * The real dispatcher, reached lazily.
 *
 * `notificationService.js` imports `db.js`, and `db.js` opens its connection at
 * module scope — so a static import here would mean that merely importing this
 * module opens a database file. Two suites import it for `pendingNoticesFor`
 * and its pure helpers without ever intending to, and a test that skips
 * `WEV_DB_PATH` would then share `server/wevolunteer.db` with every other one
 * and flake on "database is locked".
 *
 * The same `await import()` dance `auditLog.js` and `errorReporter.js` use for
 * `telemetry.js`, for the same reason. The sweep is the only caller and it runs
 * once every fifteen minutes, so resolving the module then costs nothing.
 */
async function defaultDispatch(...args) {
  const { notificationService } = await import('./services/notificationService.js');
  return notificationService.dispatch(...args);
}

/**
 * How many accounts one document may notify per pass.
 *
 * A cap rather than a batch size: the sweep runs every fifteen minutes, so a
 * backlog larger than this drains over the following passes instead of holding
 * one tick open for minutes and delaying the shift reminders behind it. The
 * lease makes resuming free — the next pass simply finds whoever is left.
 */
const NOTIFY_BATCH = Number(process.env.LEGAL_NOTICE_BATCH) || 500;

/**
 * Everybody who has a record of having been shown some version of this
 * document, with the newest version each of them has.
 *
 * Both tables, for the same reason `pendingNoticesFor` reads both: an
 * acknowledgement of 1.1 is a record of having been shown 1.1, so somebody
 * whose only record is an acknowledgement is still owed notice of 1.2. Keeping
 * this in step with the in-app rule is what stops the banner and the mail
 * disagreeing about who is behind.
 *
 * Deleted accounts are excluded here rather than left to the outbox worker.
 * The worker does drop their jobs — the address is a reserved placeholder that
 * resolves nowhere — but it drops them one at a time after claiming them, and
 * writing an in-app row for an account nobody can sign into is pointless. A
 * SUSPENDED account is deliberately included: they are still bound by the
 * document, and email is the only channel that reaches them.
 */
async function noticeAudienceFor(db, slug) {
  const seen = new Map();
  const consider = (userId, version) => {
    const list = seen.get(userId) ?? [];
    list.push(version);
    seen.set(userId, list);
  };

  for (const row of await db.prepare(`
    SELECT a.user_id AS user_id, a.version AS version
    FROM legal_acceptances a
    JOIN users u ON u.id = a.user_id
    WHERE a.document_slug = ? AND u.account_status <> 'deleted'
  `).all(slug)) consider(row.user_id, row.version);

  for (const row of await db.prepare(`
    SELECT n.user_id AS user_id, n.version AS version
    FROM legal_change_notices n
    JOIN users u ON u.id = n.user_id
    WHERE n.slug = ? AND n.acknowledged_at IS NOT NULL AND u.account_status <> 'deleted'
  `).all(slug)) consider(row.user_id, row.version);

  return seen;
}

/**
 * Enqueues one in-app notification and one email per account that is behind on
 * a published revision and has not been told about it.
 *
 * Returns `{ notified, documents }` so the caller can log something meaningful
 * and a test can assert on it rather than on side effects.
 *
 * @param {object} db a database handle
 * @param {object} [opts]
 * @param {Date} [opts.now] the clock, pinnable by tests
 * @param {(event: string, payload: object, userId: string, dedupeKey: string) => Promise<unknown>}
 *   [opts.dispatch] the notification dispatcher; defaults to the real one
 */
export async function dispatchLegalChangeNotices(db, {
  now = new Date(),
  dispatch = defaultDispatch,
} = {}) {
  const today = legalDay(now);
  let notified = 0;
  const documents = [];

  for (const doc of await effectiveDocuments(db)) {
    /**
     * The fast path, and it is the path taken on every tick of a normal week.
     *
     * `source === 'file'` means no revision has ever been published for this
     * document, so the version in effect is the registry's — the same version
     * every acceptance row was written at. Nobody can be behind on it, so there
     * is no audience to query.
     */
    if (doc.source !== 'revision') continue;

    /* Owned by `/organizer-agreement` and `/student-organizer-agreement`, which
       withhold capabilities on any version change and render the whole document.
       `noticeChannelFor` returns CHANNEL_AGREEMENT for these; asking it keeps
       the exclusion in one module rather than restating the scope list here. */
    if (noticeChannelFor(doc, doc.version, today) === CHANNEL_AGREEMENT) continue;

    const audience = await noticeAudienceFor(db, doc.slug);
    if (audience.size === 0) continue;

    /**
     * The excerpt is computed once per DOCUMENT, not once per recipient.
     *
     * It is a diff between two revisions and does not depend on who is reading
     * it. `pendingNoticesFor` builds it per user because it answers a per-user
     * question about one document; here the same value would otherwise be
     * recomputed — including a file read — for every account on the platform.
     */
    const current = await currentRevision(db, doc.slug, { withBody: true });
    const newBody = current?.body ?? fileBody(doc.slug);
    const excerpt = newBody
      ? buildExcerpt(await previousBody(db, doc.slug, doc.version), newBody)
      : { text: null, changeCount: 0, isSample: false };

    let sentForDoc = 0;

    for (const [userId, versions] of audience) {
      if (sentForDoc >= NOTIFY_BATCH) break;

      /**
       * The newest version this account has a record of that is OLDER than the
       * one in effect — not simply the newest record it has.
       *
       * ── The difference is a state conflation, and it cost an email ──
       *
       * The first version of this took `newestSeenVersion(versions)` and
       * skipped anyone whose newest record already matched the current version.
       * That silently made DISMISSING THE IN-APP BANNER cancel the email:
       * `acknowledgeNotice` writes a row at the current version, so a reader who
       * clicked the X within the fifteen minutes before the sweep ran was
       * removed from the audience entirely. Found by
       * `legalNoticeDelivery.test.js`.
       *
       * Two different questions were being answered with one number.
       * `pendingNoticesFor` asks "should the banner still be on screen", and an
       * acknowledgement is exactly the right answer to that — they dismissed
       * it. This asks "is this person behind on this document", and a dismissed
       * banner says nothing about that: they accepted 1.0, the document is at
       * 1.1.0, and a stray click on an X is not a substitute for the durable
       * record in their inbox and their notification centre.
       *
       * So the acknowledgement still counts as EVIDENCE of a version having
       * been shown — which is what makes a notice-scope document, where nobody
       * has an acceptance row, notifiable at all — but it counts at the version
       * it names, and a record of the current version simply is not an older
       * one.
       */
      const seen = newestSeenVersion(versions.filter(v => isBehind(v, doc.version)));
      if (!seen) continue;

      const severity = changeSeverity(seen, doc.version);
      const material = severity === MATERIAL;

      /**
       * `LEGAL_ACCEPTANCE_REQUIRED` for a material change even while it is
       * still only announced — see the header. The copy is written for both
       * tenses and is told which one it is rather than guessing from the date.
       */
      const event = material ? 'LEGAL_ACCEPTANCE_REQUIRED' : 'LEGAL_DOCUMENT_UPDATED';

      const payload = {
        slug: doc.slug,
        title: doc.title,
        version: doc.version,
        previousVersion: seen,
        severity,
        effectiveAt: doc.effectiveAt ?? null,
        effectiveDateLabel: formatEffectiveDate(doc.effectiveAt),
        alreadyInEffect: material
          && noticeChannelFor(doc, seen, today) === CHANNEL_ACCEPTANCE,
        excerpt: excerpt.text,
        changeCount: excerpt.changeCount,
        isSample: excerpt.isSample,
      };

      try {
        /**
         * Claim and enqueue in ONE transaction.
         *
         * `notificationService.dispatch` reads the module-level handle, which
         * `runInTransaction` binds through `AsyncLocalStorage` — so the in-app
         * row and the mail job join this transaction without being passed a
         * handle. Its own docstring asks to be called this way.
         *
         * If the claim fails the transaction does nothing and costs one
         * statement: another pass, or another process, already has it.
         */
        const claimed = await runInTransaction(db, async () => {
          if (!await recordNotified(db, userId, doc.slug, doc.version, { now })) return false;
          await dispatch(event, payload, userId, noticeDedupeKey(doc.slug, doc.version));
          return true;
        });

        if (claimed) {
          notified++;
          sentForDoc++;
        }
      } catch (err) {
        /**
         * One recipient's failure is not the sweep's failure.
         *
         * The transaction rolled back, so the lease is still open and the next
         * pass will try this person again — which is the behaviour that matters
         * and the reason this is safe to swallow at this level. Continuing also
         * means a single malformed row cannot stop everybody else being told.
         */
        console.error(
          `[legal] Could not enqueue the ${doc.slug}@${doc.version} notice for ${userId}:`,
          err.message
        );
      }
    }

    if (sentForDoc > 0) documents.push({ slug: doc.slug, version: doc.version, notified: sentForDoc });
    if (sentForDoc >= NOTIFY_BATCH) {
      console.log(
        `[legal] ${doc.slug}@${doc.version}: reached the ${NOTIFY_BATCH}-notice cap for this `
        + 'pass; the remainder goes out on the next one.'
      );
    }
  }

  if (notified > 0) {
    console.log(
      `[legal] Enqueued ${notified} legal-change notice(s): `
      + documents.map(d => `${d.slug}@${d.version} (${d.notified})`).join(', ')
    );
  }

  return { notified, documents };
}

/**
 * `2026-10-06` → `October 6, 2026`, for prose.
 *
 * Built from the parts rather than by parsing: `new Date('2026-10-06')` is
 * midnight UTC, which formats as the 5th for every reader west of Greenwich.
 * `src/views/legal/legalDates.js` makes the same argument on the rendering side
 * and this is the server's copy of it, deliberately fixed to `en-US` because a
 * server has no reader locale to consult — the recipient's is unknown here, and
 * the date also appears in the document itself in this form.
 */
function formatEffectiveDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}
