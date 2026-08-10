/**
 * Capability-based authorization.
 *
 * Before this module, authorization was ~40 copies of `req.user.role !== 'admin'`
 * spread across route files. That pattern has one fatal property: adding a role
 * silently DENIES it everywhere, because 'super_admin' !== 'admin' is true. The
 * platform owner would have been locked out of every admin route, and no test
 * would have failed.
 *
 * Route files now ask for a named capability and never look at a role string.
 * `authz.completeness.test.js` enforces that.
 *
 * ── The cascade rule (read this before writing an if/else-if over can()) ──
 *
 * `super_admin` holds the '*' wildcard, so `can()` returns TRUE for every
 * capability it is asked about. A chain of `else if (can(...))` branches is
 * therefore NOT a set of mutually exclusive cases: a wildcard principal matches
 * whichever branch happens to be tested first. Two rules follow, and both are
 * load-bearing:
 *
 *   1. Order branches MOST-PRIVILEGED-FIRST. Testing the narrow capability
 *      first (say `application.withdraw`, held by students) captures the
 *      wildcard in the narrow branch, and super_admin silently gets a student's
 *      scoped view of the data — a content bug no status-code assertion can
 *      see, because the response is still a 200.
 *
 *   2. End the cascade in an EXPLICIT deny/empty branch, never a bare `else`.
 *      "No recognised capability" must default to seeing and doing nothing. A
 *      trailing `else` that grants unscoped access hands every future role
 *      full reach on the day it is added — which is the exact class of bug
 *      this module exists to eliminate, just inverted.
 *
 * Worked examples: applicationRoutes.js's GET /api/applications scoping and
 * messageRoutes.js's user-search scoping.
 *
 * This module is pure: it imports nothing at all — no db.js, no utils.js, no
 * config.js — so it is unit-testable with no fixtures, cannot decay into a
 * data-access layer, and stays cheap for `src/authz.js` to mirror into the
 * client bundle. `authz.test.js`'s module-hygiene test enforces that.
 */

export const ROLES = ['student', 'organizer', 'admin', 'super_admin', 'partner'];

/**
 * The role names, addressable by identifier.
 *
 * ── Why this exists ──
 *
 * `authz.completeness.test.js` fails the build on any `.role` property compared
 * against a role-name LITERAL, and its failure message names the remedy: "import 
 * role names from authz.js's ROLES rather than hardcoding them". `ROLES` is an
 * array, so it answers "is this a real role" but gives no way to name one.
 *
 * A handful of decisions genuinely are about a role rather than a capability. The
 * example that prompted this is the Organizer Agreement: it binds organizers, and
 * it deliberately does not bind admins, who are covered by the Admin
 * Responsibilities Policy instead. That cannot be expressed as a capability —
 * admins hold `attendance.mark` and `attendance.view` too, so gating on those
 * would withhold oversight from administrators for not signing a document that
 * does not apply to them.
 *
 * So the rule the guard is really enforcing is "role names live in one file", not
 * "roles are never named". This is that one file. A typo here is a build failure
 * (`can()` refuses any role not in `ROLES`); a typo in a scattered string literal
 * is a silent deny, which is the class of bug this module was written to end.
 */
export const ROLE = Object.freeze({
  STUDENT: 'student',
  ORGANIZER: 'organizer',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin',
  PARTNER: 'partner',
});

/**
 * Roles for which a second authentication factor is mandatory.
 *
 * ── Why it lives here rather than being spelled out at each site ──
 *
 * It was written inline as `['admin', 'super_admin'].includes(role)` in four
 * places — twice in `utils.js`, twice in `twoFactorRoutes.js`. CLAUDE.md's rule
 * is that route files never compare a role string, and the sanctioned remedy
 * (see this file's header) is that role names live in ONE file. That spelling
 * also happens to be one the completeness guard cannot see, so it passed the
 * build while breaking the rule — which is the worst of both.
 *
 * Four copies of a security policy is four places to update when it changes and
 * three places to forget.
 *
 * ── Why a role list and not a capability ──
 *
 * Deliberate, and worth stating because everything else in this file is a
 * capability question. "Which accounts must carry a second factor" is about how
 * much damage a stolen session does, not about what the holder may do — and it
 * has to be answerable for an account whose capabilities are currently WITHHELD
 * (an organizer mid-agreement) or wildcarded (`super_admin` holds `'*'`, so a
 * capability test would match every role). The blast radius is the question, and
 * the role is the honest expression of it.
 */
export const SECOND_FACTOR_REQUIRED_ROLES = Object.freeze([ROLE.ADMIN, ROLE.SUPER_ADMIN]);

/** Whether `role` must carry a second factor. Accepts anything; only roles match. */
export function requiresSecondFactor(role) {
  return SECOND_FACTOR_REQUIRED_ROLES.includes(role);
}

export const CAPABILITIES = {
  student: [
    'event.view', 'event.apply', 'application.withdraw',
    'self.read', 'self.write', 'portfolio.write', 'message.send', 'qr.present',
    /**
     * Leaving a persona preview, held by EVERY role including this one.
     *
     * A preview narrows an owner's capabilities to a plain member of some role,
     * so if the way out were owner-only the owner would lose it the instant they
     * previewed as a student — trapped until the expiry, by a feature whose whole
     * purpose is to be stepped in and out of.
     *
     * Universal rather than an exception carved into the gate, because the safe
     * version of "this route ignores the effective role" is a route that does not
     * need to. It clears the caller's own preview and nothing else; for an account
     * that has none it does nothing at all, so holding it grants no one anything.
     */
    'persona.preview.exit',
    // A student reading their own volunteer statistics (Task 7d). Organizers
    // cannot reach GET /api/stats/volunteer today (the handler denies anyone
    // whose role is not 'student'), so this stays a student-only capability
    // rather than being widened to organizer as well.
    'stats.self',
    /**
     * The v1.3 member directory: reading another member's public profile, and
     * searching people and organizations.
     *
     * One capability rather than `profile.view` plus `user.search`, because
     * they are the same power. Search returns the public profile fields in a
     * list; the profile returns them one at a time. Splitting them would name a
     * distinction the serializer does not make, and would invite a future route
     * to hold one and leak the other.
     *
     * It grants nothing about a *private* profile. What `private` withholds is
     * withheld from every holder of this capability equally, including
     * organizers — see publicProfile() in profileSerializer.js, where the
     * decision is made once for all callers.
     */
    'directory.read',
    /**
     * Friending, muting, and restricting another member.
     *
     * Blocking is deliberately not in here: it is already gated by `event.apply`
     * on the existing route, and the asymmetry documented in blocking.js (that
     * students block and organizers do not) is a safety property that folding
     * it into a capability every role holds would quietly undo.
     */
    'relationship.manage',
    /** Joining and leaving an organization. */
    'organization.join',
    /**
     * `analytics.impact` is deliberately NOT here — it became an administrative
     * capability, and this is the role it was taken from.
     *
     * A student's own figures are `stats.self`, which is about them. The
     * community impact page is about everybody: how many hours this school's
     * children served, in which categories, and whether participation is rising.
     * Aggregated and suppressed, it still describes a cohort of minors to a
     * reader with no responsibility for them, and "the numbers identify nobody"
     * answers the wrong question — the one worth asking is whose figures these
     * are to read.
     *
     * See the note beside `analytics.impact` in the `admin` list below.
     */
  ],
  organizer: [
    'event.view', 'event.create', 'event.edit.own', 'applicant.review',
    'attendance.mark', 'attendance.view', 'attendance.scan', 'announcement.post',
    'message.send', 'self.read', 'self.write', 'service.verify.own_event',
    /**
     * Leaving a persona preview, held by EVERY role including this one.
     *
     * A preview narrows an owner's capabilities to a plain member of some role,
     * so if the way out were owner-only the owner would lose it the instant they
     * previewed as a student — trapped until the expiry, by a feature whose whole
     * purpose is to be stepped in and out of.
     *
     * Universal rather than an exception carved into the gate, because the safe
     * version of "this route ignores the effective role" is a route that does not
     * need to. It clears the caller's own preview and nothing else; for an account
     * that has none it does nothing at all, so holding it grants no one anything.
     */
    'persona.preview.exit',
    'geocode.use',
    // An organizer reading statistics for the events they run (Task 7d).
    // `analytics.own_events` is the organizer's analytics capability, and it is
    // scoped to the events they ran. `analytics.impact` — the whole community —
    // is not theirs to read; see the note in the `admin` list below.
    'analytics.own_events',
    // The member directory, on the same terms as a student — see the note there.
    'directory.read', 'relationship.manage', 'organization.join',
    /**
     * Creating an organization, and managing one this account created or was
     * made a manager of.
     *
     * `organization.manage.own` is the capability; *which* organization is an
     * ownership question the route answers against `organization_members`, in
     * exactly the way `event.edit.own` is paired with an `organizer_id` check.
     * A capability cannot express "this one and not that one", and pretending
     * otherwise is how a scoped permission becomes a global one.
     */
    'organization.create', 'organization.manage.own',
  ],
  admin: [
    'event.view', 'event.moderate', 'organizer.approve', 'user.suspend',
    /**
     * Issuing a formal warning, split from `user.suspend`.
     *
     * Not folded into `user.suspend` even though every holder of that capability
     * can obviously do worse: the name would then be lying about what it permits,
     * and the split is what makes the useful grant possible — a triage helper who
     * can tell somebody to stop, and cannot lock them out. `REPORT_RESOLUTIONS`
     * has offered `warning_issued` since v1.2, so until now the outcome existed as
     * a label on a closed report and the person was never told.
     *
     * Not `report.resolve` either. A warning is an action against a PERSON, and
     * anyone who can sort a queue should not thereby be able to put a permanent
     * disciplinary notice on a student's record.
     */
    'user.warn',
    'report.resolve', 'appeal.review', 'analytics.school',
    /**
     * `audit.read` is deliberately NOT here — it moved to SUPER_ONLY when the
     * Audit Explorer shipped (M1c).
     *
     * The administrative audit trail records administrators acting on students,
     * and on each other. An administrator who can read it can see who reviewed
     * a report naming them, who looked at their record, and what was written
     * about them — which makes the trail an instrument of the people it exists
     * to hold accountable. Oversight of administrators belongs to the tier above
     * them.
     *
     * These two exist because `audit.read` used to be doing three unrelated jobs
     * at once, and only one of them was about the audit trail. Splitting them is
     * what made the move possible without taking anything away from an
     * administrator that they legitimately need:
     *
     *   - `application.read_all` gates the unscoped branch of GET /api/applications.
     *   - `user.contact.read` gates contact PII on a student profile.
     *
     * Both are named for what they authorize. Reusing `audit.read` for either
     * was the original defect: a capability whose name describes one power and
     * whose removal silently withdraws two others. Removing it without this
     * split would have emptied every administrator's application list — a 200
     * with an empty array, which the status-only authorization matrix cannot
     * detect. `routes.adminCapabilitySplit.test.js` asserts the CONTENT, not the
     * status, for exactly that reason.
     */
    'application.read_all', 'user.contact.read',
    /**
     * Reading the message bodies preserved with a safety report is split from
     * deciding the report, and holds the same roles today, so nothing changes
     * for anybody now. The split is what makes a per-user grant (migration 002)
     * able to create a triage-only helper who sorts the queue and never reads a
     * student's private messages — the most invasive power on this platform.
     * It cannot go in SUPER_ONLY, because SUPER_ONLY capabilities are
     * unreachable by grant, and grantability is the entire reason it exists as
     * a separate name.
     */
    'report.evidence.read',
    /**
     * `service.verify.external` used to sit here, and it is deliberately gone.
     *
     * Nothing ever checked it. Its existence was read — by the release that
     * built external hours — as evidence that somebody intended an
     * administrative review of a student's self-reported service, and a whole
     * approval queue was written on the strength of the name. It was never the
     * product; see server/routes/externalHoursRoutes.js and migration 032.
     *
     * A capability no route consults is not inert. It is a claim about what this
     * platform lets an administrator do, sitting in the one file people read to
     * find out.
     */
    'capability.grant',
    /**
     * Messaging, granted only now that there is a conversation shape that can
     * hold an administrator.
     *
     * This was tried once before and reverted, correctly. `conversations` was
     * `(event_id, student_id, organizer_id)` all NOT NULL, and
     * `resolveConversation` always wrote the row between the student and the
     * organizer — so an admin who opened one was not a participant and got 404 on
     * both read and send. The capability replaced a permission error with an empty
     * inbox, which is a worse outcome, not a better one.
     *
     * Migration 018 added the `admin_student` / `admin_organizer` kinds and
     * membership through `conversation_participants`, so the capability now
     * describes something the data model can actually do.
     */
    'message.send',
    'attendance.mark', 'attendance.view',
    'self.read', 'self.write', 'geocode.use',
    /**
     * Leaving a persona preview, held by EVERY role including this one.
     *
     * A preview narrows an owner's capabilities to a plain member of some role,
     * so if the way out were owner-only the owner would lose it the instant they
     * previewed as a student — trapped until the expiry, by a feature whose whole
     * purpose is to be stepped in and out of.
     *
     * Universal rather than an exception carved into the gate, because the safe
     * version of "this route ignores the effective role" is a route that does not
     * need to. It clears the caller's own preview and nothing else; for an account
     * that has none it does nothing at all, so holding it grants no one anything.
     */
    'persona.preview.exit',
    // Deliberate widening (Task 7d, same pattern as attendanceRoutes.js's
    // attendance.mark correction in Task 7b): GET /api/stats/organizer denies
    // admin today (`role !== 'organizer'`), which is an inconsistency with the
    // rest of admin's platform-wide oversight capabilities — an admin can see
    // every application and every event, but not one organizer's own stats
    // page. `analytics.own_events` closes that gap.
    'analytics.own_events',
    /**
     * The community impact figures (`GET /api/impact`, `/impact`).
     *
     * ── What changed, and why the capability moved rather than the route ──
     *
     * This was held by student, organizer, admin AND partner, and the comment
     * where it used to live said that was the point: "a gate whose answer is
     * currently yes for everyone signed in". It also said what to do if the
     * answer stopped being yes — "withholding them from a role becomes an edit to
     * this table rather than to a route" — and this is that edit. The nav entry,
     * the client route guard and the API handler all name this one word, so
     * narrowing the holders narrows all three at once, and none of them had to
     * learn a new spelling.
     *
     * The figures are an internal view of how the programme is doing. That is not
     * a new conclusion: it is the same one that DELETED `/api/public/impact`
     * rather than re-gating it, on the grounds that the surface had been built
     * for an audience (strangers, grant readers, marketing) that turned out not
     * to be who the figures were for. Everyone-signed-in was the same mistake one
     * step in: a cohort of minors at a named school, described to every account
     * on the platform, with the suppression threshold doing all of the work.
     *
     * ── Why not `analytics.school`, which admin already holds ──
     *
     * Because it gates something else. `analytics.school` is the administrative
     * dashboard's own numbers (`GET /api/admin/stats`) and platform health
     * (`GET /api/admin/system/status`). Reusing it here would make one capability
     * authorize three unrelated surfaces — which is precisely the defect that
     * forced `audit.read` to be split into `application.read_all` and
     * `user.contact.read`: a name that describes one power and whose removal
     * silently withdraws two others. It would also make a grant of school
     * analytics quietly hand over the community figures, and leave
     * `analytics.impact` registered with no route and no holder.
     *
     * ── Why not a new capability name ──
     *
     * `analytics.impact` already means exactly this surface, and it is already
     * spelled in the route table, the nav table, the API handler and the refusal
     * copy (`denialDetail.js`). A new name would edit four files to say the same
     * thing, and leave this one to be deleted from the docs' capability matrix.
     * The honest change is to who holds it, not to what it is called.
     *
     * ── Why not SUPER_ONLY ──
     *
     * SUPER_ONLY is checked before per-user grants, which makes a capability
     * ungrantable — right for `audit.read`, wrong here. The policy is "admin and
     * above", and `analytics.platform` (the platform-wide superset at
     * `/admin/impact`) already occupies the owner-only tier. Leaving this
     * grantable means an administrator can deliberately extend the figures to one
     * account through `capability.grant`, which is audited and revocable, instead
     * of that being impossible or done by promoting somebody to admin.
     */
    'analytics.impact',
    // The member directory, on the same terms as every other member.
    'directory.read', 'relationship.manage', 'organization.join',
    /**
     * Administrators create and manage organizations too, and additionally hold
     * `organization.moderate` — the unscoped power to edit or archive an
     * organization they did not create.
     *
     * Split from `organization.manage.own` for the same reason `event.moderate`
     * is split from `event.edit.own`: the route's ownership check is what makes
     * "own" mean something, and the moderator's bypass of that check has to be a
     * capability somebody can be seen to hold.
     */
    'organization.create', 'organization.manage.own', 'organization.moderate',
  ],
  /* Holds everything, including `persona.preview.exit` — which is the role a
     preview is always started FROM, so it is the one that must never lose it. */
  super_admin: ['*'],
  // `event.view` and `geocode.use`: neither route these gate (GET
  // /api/organizers/:id/profile, GET /api/geocode) has ever had a partner-
  // specific restriction — today's role checks only ever named 'student' or
  // 'admin'/'organizer', so partner already passes both. Granting the
  // capabilities keeps that unchanged now that the routes ask `can()` instead
  // of comparing role strings.
  //
  // `directory.read` is deliberately NOT here, and it is the same decision as
  // `analytics.impact` below applied to individuals instead of aggregates. A
  // partner is an EXTERNAL organization. The member directory is a searchable
  // list of schoolchildren by name, with their service history and general
  // location attached; "the profiles are public to members" answers the wrong
  // question, because the point of the public baseline is that it is visible to
  // the school community a student volunteers alongside, not to every outside
  // body holding a login. `relationship.manage`, `organization.join` and
  // `organization.create` are absent for the same reason: none of them is a
  // thing an external partner does.
  //
  // `analytics.impact` is deliberately NOT here, and partner is the role where
  // the decision needed making rather than following. A partner is an EXTERNAL
  // organization: it is the audience `/api/public/impact` was built for, and that
  // route was deleted rather than re-gated because these figures are an internal
  // view of how the programme is doing. Handing a partner the full community
  // breakdown — categories, month-by-month participation, a cohort of minors at a
  // named school — is the disclosure the deletion refused, with a login on top.
  // `analytics.public` stays registered and still reads nothing: it is the name
  // for figures chosen FOR an outside reader, and that surface has not been
  // designed. A partner who should see a figure is the argument for building it,
  // not for reusing the administrators' page.
  partner: ['analytics.public', 'event.view', 'geocode.use', 'persona.preview.exit'],
};

/**
 * Capabilities only super_admin may hold.
 *
 * Declared explicitly rather than left implicit under the '*' wildcard, because
 * `can()` refuses any capability not named somewhere in this file. Without this
 * list a typo ('error.raed') would resolve TRUE for super_admin and 403 for
 * everyone else — the worst kind of authorization bug, because it looks like it
 * works when the person testing it is the owner.
 */
export const SUPER_ONLY = [
  'error.read', 'error.write',
  'analytics.platform',
  'impersonation.start',
  'admin.create',
  /**
   * Reading the administrative audit trail (M1c, the Audit Explorer).
   *
   * Here rather than in the `admin` list for the reason given beside its removal
   * there: a trail that records what administrators do is not a thing
   * administrators should be able to read about each other.
   *
   * SUPER_ONLY also makes it UNGRANTABLE — the check runs before per-user grants
   * are consulted, and `userCapabilities.js` refuses to store a grant naming one.
   * That is deliberate. A grant is the natural way to create a "triage helper",
   * and audit access is exactly what such a helper should not quietly acquire.
   */
  'audit.read',
  /**
   * STARTING a persona preview (`persona.preview.exit` is the other half, and is
   * held by every role — see the note beside it).
   *
   * SUPER_ONLY makes it ungrantable as well as owner-only: the check runs before
   * per-user grants are consulted and `userCapabilities.js` refuses to store a
   * grant naming one. That matters more here than the owner-only part. A preview
   * cannot escalate — `can()` intersects the previewed role with the real one —
   * so the risk is not that a grantee would gain access, it is that "let the
   * helpdesk see what a student sees" is an extremely reasonable-sounding grant
   * that would put a role switch in the hands of an account nobody audited for
   * it. Ungrantable means that conversation happens as a role change instead.
   */
  'persona.preview',
  /**
   * Editing the published text of a legal document (the Legal Center editor).
   *
   * ── Why owner-only rather than an administrator power ──
   *
   * Every other administrative capability acts on one person or one event, and
   * an administrator who misuses it harms a bounded set of people who can be
   * identified afterwards. This one rewrites the agreement that every account on
   * the platform is held to, including the fourteen-year-olds who accepted it at
   * signup and the organizers whose obligations it defines. There is no bounded
   * blast radius and no version of "we caught it early" that undoes somebody
   * having relied on the wrong text.
   *
   * ── SUPER_ONLY also makes it UNGRANTABLE, which is the larger point ──
   *
   * The check runs before per-user grants are consulted and `userCapabilities.js`
   * refuses to store a grant naming one. "Let the person handling our compliance
   * paperwork fix the Terms" is an extremely reasonable-sounding grant, and it
   * would hand the contract to an account nobody vetted for it. Ungrantable means
   * that conversation has to happen as a role change instead.
   *
   * This gates the editor SURFACE — reading the editable text as well as writing
   * it, because the requirement is that an ordinary user cannot retrieve editable
   * content either. The separate act of publishing additionally requires a fresh
   * proof of identity: see `legal.publish` in sensitiveActions.js.
   */
  'legal.edit',
];

export const ALL_CAPABILITIES = [...new Set([
  ...Object.values(CAPABILITIES).flat().filter(c => c !== '*'),
  ...SUPER_ONLY,
])].sort();

const CAPABILITY_SET = new Set(ALL_CAPABILITIES);
const SUPER_ONLY_SET = new Set(SUPER_ONLY);

/**
 * Builds the request principal from a users row.
 *
 * `effectiveRole` is separate from `actualRole` so impersonation (v2.0) is a
 * change of the effective role only — never a second role on the account.
 *
 * `aal` and `aalAction` travel together and are meaningless apart. AAL2 is
 * never a general property of a session — it is always "this request proved
 * identity, for THIS action" — so the field naming the action defaults to null
 * and is always present, rather than appearing only on re-verified requests.
 * An always-present field is one `requireAAL2` can compare without first
 * asking whether assurance resolution ran at all.
 */
export function principalFor(
  userRow,
  { grants = [], aal = 1, aalAction = null, actorId = null, effectiveRole = null, withheld = [] } = {}
) {
  if (!userRow) return null;
  return {
    userId: userRow.id,
    actualRole: userRow.role,
    effectiveRole: effectiveRole || userRow.role,
    actorId,
    grants,
    aal,
    aalAction,
    withheld,
    impersonating: Boolean(actorId),
  };
}

/**
 * The persona this principal is previewing as, or null.
 *
 * ── Why this is a function here rather than a comparison there ──
 *
 * "Is a preview in force" is `effectiveRole !== actualRole`, and a route that
 * writes that out is a role-string comparison in a route — which Guard 1 fails
 * the build on, correctly and for a reason that applies here. The comparison is
 * one line and it is not an authorization decision, but it is the sort of line
 * that gets copied to a place where the next reader treats it as one, and the
 * spelling of a "preview" is exactly the kind of thing two files should not each
 * hold an opinion about.
 *
 * Reporting only. Nothing may be authorised on the strength of this — `can()` is
 * the only answer to whether something is allowed, and it applies the narrowing
 * rule itself.
 */
export function previewPersonaOf(principal) {
  if (!principal || !principal.actualRole) return null;
  if (principal.effectiveRole === principal.actualRole) return null;
  return principal.effectiveRole;
}

/** Deny-by-default authorization decision. */
export function can(principal, capability) {
  if (!principal || !capability) return false;
  if (!CAPABILITY_SET.has(capability)) return false;   // unknown/typo → deny, always

  const role = principal.effectiveRole;
  if (!ROLES.includes(role)) return false;

  /**
   * Withheld capabilities: an absolute deny, tested before anything grants.
   *
   * ── Why this exists ──
   *
   * An organizer receives students' names, email addresses and attendance
   * records. The Organizer Agreement is the undertaking they make about handling
   * it, and until v1.2 nothing recorded whether they had ever made it — an admin
   * clicked approve and the capabilities arrived, so adults held minors' contact
   * details under no recorded obligation at all.
   *
   * ── Why the check is here rather than on the routes ──
   *
   * Route-level gates have to be remembered. There are ten capabilities in the
   * organizer set and more will be added; a gate missed on one new route is a
   * silent hole, and it would pass every functional test. Withholding at the
   * capability layer means a route that asks `can()` — which every route does,
   * enforced by six build-failing guards — cannot accidentally answer yes.
   *
   * ── Why BEFORE the wildcard ──
   *
   * Ordering is the whole correctness argument, and it is the same argument as
   * the cascade rule in this file's header. `super_admin` holds '*', so a
   * withheld check placed after it would be unreachable for exactly the
   * principal with the most reach. Nothing withholds from super_admin today —
   * `buildPrincipal` computes the list from the organizer agreement only — but
   * "it happens not to matter yet" is not a property worth depending on.
   *
   * ── Why it is passed in rather than computed here ──
   *
   * This module imports nothing and must keep importing nothing. Deciding
   * whether an acceptance row exists needs the database, so the caller decides
   * WHAT to withhold and this function only enforces THAT it is withheld. See
   * `server/organizerAgreement.js`.
   */
  if (Array.isArray(principal.withheld) && principal.withheld.includes(capability)) return false;

  /**
   * ── The narrowing rule ──
   *
   * When `effectiveRole` differs from `actualRole`, BOTH must permit the
   * capability. A differing effective role can therefore only ever take
   * capabilities away; it can never add one the account does not really hold.
   *
   * ── Why this is structural rather than a check at the place that sets it ──
   *
   * `effectiveRole` is what a persona preview changes, and a persona preview is
   * a role switch. Role switches are the classic privilege-escalation shape: the
   * bug is never "the feature was designed to escalate", it is "some path set
   * the field without re-asking who was allowed to". There are several places
   * that could come to set it — the preview routes, impersonation (v2.0), a
   * future support tool — and a rule enforced at each of them is a rule that one
   * of them will eventually miss, silently, with every functional test green.
   *
   * Enforced HERE, the guarantee does not depend on the caller at all. A
   * `preview_persona` of 'super_admin' written straight into a student's row by
   * a SQL-injection bug, a compromised admin, or a mistake in this repository
   * grants that student exactly nothing, because their `actualRole` is read from
   * the database on every request and still says 'student'.
   *
   * ── Why the intersection is computed by recursion, not by set maths ──
   *
   * Asking `can()` again under the real role means the wildcard, `SUPER_ONLY`,
   * `withheld` and the grants rules are all applied to it too, by the same code.
   * A hand-written intersection of the two capability arrays would be a second
   * implementation of this function, and the day they disagree is the day the
   * disagreement is a security bug.
   */
  if (principal.actualRole && principal.actualRole !== role) {
    if (!ROLES.includes(principal.actualRole)) return false;
    const asActual = { ...principal, effectiveRole: principal.actualRole, actualRole: null };
    if (!can(asActual, capability)) return false;
  }

  const roleCaps = CAPABILITIES[role] || [];
  if (roleCaps.includes('*')) return true;             // super_admin
  if (roleCaps.includes(capability)) return true;

  /**
   * Per-user grants (Task 4) extend a role, but can never reach a super-only
   * capability — otherwise `capability.grant` would be a path to root.
   *
   * They are also ignored while a different effective role is in force. A grant
   * is an extension of what THIS account may do; a preview asks a different
   * question — what does a plain member of that role see — and answering it with
   * this account's extras would show the owner a student's view containing
   * something no student has. That would make the preview quietly useless for
   * the one job it exists to do.
   */
  if (SUPER_ONLY_SET.has(capability)) return false;
  if (principal.actualRole && principal.actualRole !== role) return false;
  return Array.isArray(principal.grants) && principal.grants.includes(capability);
}

/**
 * Which base roles hold a capability, derived from the table above.
 *
 * ── Why this exists ──
 *
 * Some work is not a request. "Tell every moderator an urgent safety report just
 * arrived" has to find the moderators before there is a principal to ask `can()`
 * about, and the obvious way to write that — `WHERE role IN ('admin',
 * 'super_admin')` — is a role-string comparison with all the usual problems: it
 * is a second source of truth about who moderates, it goes stale the moment the
 * table changes, and it is invisible to Guard 1, which cannot see inside a SQL
 * string literal.
 *
 * So the role list is computed FROM the capability table, through `can()`, which
 * means `SUPER_ONLY` and the `'*'` wildcard are honoured by construction and a
 * capability moved between roles moves the query with it. Callers still have to
 * union in per-user grants themselves — those live in the database, and this
 * module deliberately imports nothing.
 *
 * Not a substitute for `requireCap` on a request. This answers "who are they",
 * never "may this caller".
 */
export function rolesWithCapability(capability) {
  if (!CAPABILITY_SET.has(capability)) return [];
  return ROLES.filter(role => can(principalFor({ id: `role:${role}`, role }), capability));
}

/**
 * The only authorization primitive route files may use.
 *
 * Must be mounted AFTER authenticateToken, which is what populates
 * req.principal. A missing principal is a 401 (not authenticated), never a 403,
 * because the two mean different things to a client: one says "sign in", the
 * other says "you cannot do this".
 */
export function requireCap(capability) {
  if (!ALL_CAPABILITIES.includes(capability)) {
    // Thrown at module load, not per request, so a typo fails the boot and the
    // test suite rather than quietly 403ing in production.
    throw new Error(`requireCap: unknown capability '${capability}'`);
  }
  return function capabilityGate(req, res, next) {
    if (!req.principal) return res.status(401).json({ error: 'Access token required' });
    if (req.principal.tfaRequired) {
      return res.status(403).json({ 
        error: 'Two-factor authentication must be enabled to perform this action', 
        code: 'tfa_required' 
      });
    }
    if (!can(req.principal, capability)) return res.status(403).json({ error: 'Access denied' });
    return next();
  };
}

/**
 * Like `requireCap`, but passes if the principal holds ANY of the listed
 * capabilities.
 *
 * Exists for routes an admin and an organizer both legitimately reach through
 * two different capabilities (e.g. `event.moderate` for admin's platform-wide
 * reach, `applicant.review` for the organizer who owns the event). A single
 * `requireCap` would 403 whichever side's capability was not named, at the
 * middleware layer, before any per-row ownership check could run.
 *
 * The returned middleware is deliberately also named `capabilityGate` — the
 * same name `requireCap` uses — so a single detector (Task 8's completeness
 * test) recognises both as coverage without special-casing either.
 */
export function requireCapAny(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    // A gate with nothing to check admits everyone, which is never intended —
    // fail the boot rather than silently no-op the route's authorization.
    throw new Error('requireCapAny: capabilities must be a non-empty array');
  }
  for (const capability of capabilities) {
    if (!ALL_CAPABILITIES.includes(capability)) {
      // Thrown at module load, not per request, so a typo fails the boot and
      // the test suite rather than quietly 403ing in production.
      throw new Error(`requireCapAny: unknown capability '${capability}'`);
    }
  }
  return function capabilityGate(req, res, next) {
    if (!req.principal) return res.status(401).json({ error: 'Access token required' });
    if (req.principal.tfaRequired) {
      return res.status(403).json({ 
        error: 'Two-factor authentication must be enabled to perform this action', 
        code: 'tfa_required' 
      });
    }
    if (!capabilities.some((capability) => can(req.principal, capability))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    return next();
  };
}

/**
 * Requires a fresh proof of identity for this action.
 *
 * Mounted after authenticateToken and after any requireCap — capability first
 * ("may this kind of actor ever do this"), then assurance ("prove it is still
 * you"). Reversing them tells an unauthorised caller that re-verifying might
 * help, which it never would.
 *
 * ── Why `code: 'reauth_required'` and not a bare 403 ──
 *
 * A bare 403 says "you may never do this". This one says "prove yourself and
 * try again", and those are different instructions for the client: one is a
 * dead end, the other is a prompt. Conflating them means the UI either offers
 * re-verification for genuinely forbidden actions or offers nothing for
 * recoverable ones.
 *
 * ── Why the action is compared, not merely the level ──
 *
 * Assurance is never a property of a session, only of a request: a grant
 * proves identity for ONE action. Checking `aal >= 2` alone would let a
 * verification obtained to change an email address delete the account instead.
 * `aalAction` is what `authenticateToken` resolved this request's grant to be
 * for, and it must be this route's action.
 *
 * This gate is not the authority on params, and does not pretend to be —
 * `consumeChallenge`, inside the handler's transaction, re-checks the action,
 * the params, the session and single use before the work is allowed to land.
 * This is the cheap early refusal that keeps the handler from starting.
 *
 * `action` is validated against the sensitive-action registry at the CALL SITE
 * in route files, not here: importing sensitiveActions.js would cost this
 * module its zero-imports property, which authz.test.js asserts and which is
 * what lets src/authz.js mirror the table into the client bundle.
 *
 * Pure: reads a value already resolved onto the principal and performs no I/O.
 */
export function requireAAL2(action) {
  // Thrown at module load, not per request. A gate built with no action would
  // compare `undefined` against `principal.aalAction` and refuse every caller
  // forever — a route that is 403 for everyone, discovered in production.
  if (!action) throw new Error('requireAAL2: an action is required');
  return function assuranceGate(req, res, next) {
    if (!req.principal) return res.status(401).json({ error: 'Access token required' });
    if (req.principal.aal < 2 || req.principal.aalAction !== action) {
      return res.status(403).json({ error: 'Identity verification required', code: 'reauth_required', action });
    }
    return next();
  };
}
