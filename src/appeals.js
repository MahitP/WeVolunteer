/**
 * Client mirror of the appeal vocabulary.
 *
 * ── Why this file exists ──
 *
 * Same reasoning as `src/authz.js`, and the same incident shape. `SuspendedWall`
 * decided whether an appeal was finished by comparing against the string
 * `'decided'`:
 *
 *     const open    = appeals.find(a => a.status !== 'decided');
 *     const decided = appeals.filter(a => a.status === 'decided');
 *
 * No appeal has ever had that status. The server writes `open` → `reviewing` →
 * `resolved` (`APPEAL_FINAL_STATUSES` below). So `open` matched every appeal
 * including finished ones, `decided` was permanently empty, and the block that
 * renders the reviewer's decision and their reasoning was unreachable code.
 *
 * A suspended student who appealed — and won — read "Your appeal is with us. We
 * reply within five business days. You do not need to send another" forever, with
 * the re-file form suppressed underneath it. On a platform whose users are mostly
 * minors, that is the single worst dead end the product had: the one screen a
 * locked-out person can reach, telling them to keep waiting for an answer that had
 * already been given.
 *
 * The suite did not catch it because the fixture invented the same status the
 * component invented. Two copies of a vocabulary agreeing with each other and
 * with nothing else is precisely what re-exporting prevents.
 *
 * `server/appeals.js` imports `node:crypto` and nothing else — no database, no
 * config — which is what makes this safe to pull into the browser bundle. Keep it
 * that way.
 */
export {
  APPEAL_SUBJECTS,
  APPEAL_DECISIONS,
  DECISION_LABELS,
  APPEAL_OPEN_STATUSES,
  APPEAL_FINAL_STATUSES,
  isFinal,
  MIN_STATEMENT_LENGTH,
  MAX_STATEMENT_LENGTH,
} from '../server/appeals.js';
