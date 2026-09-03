/**
 * Organizations — a club, a chapter, or a programme that runs events.
 *
 * "Example Valley High School Volunteering Club". "NHS". The thing a student
 * says they volunteer *with*, which until now the platform had no way to name:
 * every event belonged to an individual organizer account, so two events run by
 * the same club by two different teachers had nothing connecting them.
 *
 * ── Scoped membership is not a platform role ──
 *
 * `organization_members.member_role` is 'member' or 'manager'. Neither is ever
 * compared against `users.role`, and holding 'manager' grants nothing outside
 * the one organization it names. Which organization somebody may manage is an
 * ownership question, answered here against the membership table, in exactly
 * the way `event.edit.own` is paired with an `organizer_id` check — a
 * capability cannot express "this one and not that one".
 *
 * A member with `organization.moderate` (administrators) bypasses the
 * membership check. That bypass is a named capability rather than a role test
 * precisely so it is visible in the matrix.
 */

import crypto from 'node:crypto';
import { isAvatarColor } from './avatarColors.js';
/* Vocabulary only, and that module imports nothing at all — so reading it here
   costs no coupling, and the browser can import the same file for the settings
   form rather than holding a second copy of the words. */
import {
  JOIN_POLICIES, INVITE_POLICIES, VISIBILITIES,
  DEFAULT_VISIBILITY, DEFAULT_JOIN_POLICY, DEFAULT_INVITE_POLICY,
  normaliseJoinPolicy, normaliseInvitePolicy, normaliseVisibility,
} from './organizationPolicy.js';

export const ORG_NAME_MAX = 120;
export const ORG_DESCRIPTION_MAX = 2000;

/**
 * Tag rules live in `organizationTags.js` and are re-exported here.
 *
 * They moved because the organization form needs them in the browser, and this
 * module imports `node:crypto`. Re-exported rather than relocated outright so
 * the ~dozen existing importers of `organizations.js` keep working and there is
 * one obvious place to look.
 */
export {
  MAX_ORG_TAGS,
  MAX_ORG_TAG_LENGTH,
  cleanOrgTag,
  normaliseOrgTag,
  normaliseOrgTags,
} from './organizationTags.js';

/* `export … from` re-exports without binding the name locally, and
   `validateOrganizationPayload` below calls this one. */
import { normaliseOrgTags } from './organizationTags.js';
import { validateHandle, normaliseHandle, HANDLE_MAX } from './organizationHandles.js';

/**
 * A URL-safe identity derived from the name.
 *
 * Derived, not chosen, because an organization name is already the thing people
 * type — asking an organizer to invent a second identifier is a form nobody
 * fills in well. Collisions get a numeric suffix, the same resolution
 * `migrate_usernames.js` uses, and for the same reason: the alternative is
 * refusing to create the second "NHS" anybody tries to make.
 */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * The starting handle for a club whose organizer did not choose one.
 *
 * ── Why this now goes through validateHandle ──
 *
 * `slugify` answers "what is the URL-safe form of this name", which is not the
 * same question as "is this a usable public handle". It happily returns `new`
 * for a club called "New" — which used to be created with a permanently
 * unreachable page, because the router matches the literal `/organizations/new`
 * first — and `2024-team` for one called "2024 Team", and `hq` for "HQ".
 *
 * So the derived value is offered to `validateHandle` and repaired when it is
 * refused, rather than trusted. `org-` is the prefix used for the repair
 * because it is what a reader seeing `/organizations/@org-new` can make sense
 * of; the numeric-suffix loop underneath is unchanged, and still exists so the
 * second club anybody names "NHS" can be created at all.
 */
export async function uniqueSlug(db, name) {
  const derived = slugify(name);
  /* Repair before the collision loop, so a name that slugifies to a reserved or
     malformed handle does not get a numeric suffix pinned to a base that was
     never going to be accepted: "New" becomes `org-new`, then `org-new-2`. */
  const base = validateHandle(derived).ok ? derived : `org-${derived || 'anization'}`.slice(0, HANDLE_MAX);
  let candidate = base;
  let n = 1;
  /* COLLATE NOCASE to match idx_organizations_slug, so the uniqueness check and
     the unique index agree about what a collision is. */
  const taken = await db.prepare('SELECT 1 FROM organizations WHERE slug = ? COLLATE nocase');
  while (await taken.get(candidate) || !validateHandle(candidate).ok) {
    n += 1;
    /* The suffix is trimmed off the BASE, not off the whole candidate, so a
       long name cannot lose the digits that make it unique. */
    const suffix = `-${n}`;
    /* Trailing hyphens are stripped from the truncated base, because
       `abc-` + `-2` is `abc--2`, which `validateHandle` refuses — and refusing
       every candidate is how this loop would never end. */
    const trimmed = base.slice(0, HANDLE_MAX - suffix.length).replace(/-+$/, '');
    candidate = `${trimmed || 'organization'}${suffix}`;
  }
  return candidate;
}

/**
 * Whether a handle is free, asked of the database rather than guessed.
 *
 * `excluding` is the organization doing the asking, so a manager re-saving the
 * settings form without touching the handle is not told their own address is
 * taken.
 */
export async function handleAvailable(db, handle, { excluding = null } = {}) {
  const clean = normaliseHandle(handle);
  if (!clean) return false;

  /**
   * Both namespaces, in one statement.
   *
   * A handle that equals some club's ID is the collision that let an organizer
   * shadow another club: they read the victim's id off the directory payload,
   * claimed it as their handle, and every id-addressed link to the victim
   * resolved to them instead. `validateHandle` refuses a UUID-shaped value,
   * which covers every id `createOrganization` mints — but not the short
   * readable ids in the demo seed and any database seeded the same way, which
   * is how this was found.
   *
   * Asking the database is the check that cannot be out of date: it refuses
   * exactly the strings that would collide, with no pattern to keep in step
   * with however ids are minted next.
   */
  const row = await db.prepare(`
    SELECT id FROM organizations WHERE slug = ? COLLATE nocase OR id = ?
  `).get(clean, clean);
  return !row || row.id === excluding;
}

/**
 * Validates a create/update payload. Mirrors the shape of `validateEventPayload`
 * — `{ ok, error, field }` — so route handlers treat it identically.
 */
export function validateOrganization(payload, { partial = false } = {}) {
  const out = {};

  if (payload.name !== undefined || !partial) {
    if (typeof payload.name !== 'string' || !payload.name.trim()) {
      return { ok: false, field: 'name', error: 'Give the organization a name.' };
    }
    if (payload.name.trim().length > ORG_NAME_MAX) {
      return { ok: false, field: 'name', error: `The name must be ${ORG_NAME_MAX} characters or fewer.` };
    }
    out.name = payload.name.trim();
  }

  if (payload.description !== undefined) {
    if (payload.description !== null && typeof payload.description !== 'string') {
      return { ok: false, field: 'description', error: 'The description must be text.' };
    }
    const description = payload.description ?? '';
    if (description.length > ORG_DESCRIPTION_MAX) {
      return { ok: false, field: 'description', error: `The description must be ${ORG_DESCRIPTION_MAX} characters or fewer.` };
    }
    out.description = description;
  }

  if (payload.tags !== undefined) {
    const tags = normaliseOrgTags(payload.tags);
    if (!tags.ok) return tags;
    out.tags = tags.value;
  }

  /**
   * The emoji mark, under exactly the rule `users.avatar` uses.
   *
   * Eight characters, because a single emoji can be several code units once
   * skin tone and zero-width joiners are involved, and anything past that is
   * either a mistake or an attempt to smuggle a payload into a field that gets
   * rendered on every card. Copied in spirit rather than imported because
   * `accountValidation` is about a person's account and this module
   * deliberately depends on nothing.
   *
   * `null` clears it — an organization is allowed to go back to having no mark.
   */
  /**
   * Whether members may reply to this organization's announcements.
   *
   * An organization-level setting with no per-post override: a manager deciding
   * "we do not take replies" is describing how their club communicates, not
   * annotating one notice. Turning it off keeps the replies already written and
   * stops new ones — see migration 042.
   */
  if (payload.allowReplies !== undefined) {
    if (typeof payload.allowReplies !== 'boolean') {
      return { ok: false, field: 'allowReplies', error: 'That setting must be on or off.' };
    }
    out.allowReplies = payload.allowReplies;
  }

  /**
   * Who may join, and who may hand out the link.
   *
   * Validated against `organizationPolicy.js` rather than a literal here,
   * because migration 062 deliberately carries no CHECK constraint — SQLite
   * cannot add one without rebuilding this table — so this IS the constraint.
   * A value outside the vocabulary is refused rather than normalised, because
   * a manager who typed something unexpected should be told, not silently given
   * a different setting from the one they chose. The readers normalise; the
   * writer refuses.
   */
  if (payload.joinPolicy !== undefined) {
    if (!JOIN_POLICIES.includes(payload.joinPolicy)) {
      return { ok: false, field: 'joinPolicy', error: 'Choose one of the available join settings.' };
    }
    out.joinPolicy = payload.joinPolicy;
  }

  if (payload.visibility !== undefined) {
    if (!VISIBILITIES.includes(payload.visibility)) {
      return { ok: false, field: 'visibility', error: 'Choose whether this organization has a public page.' };
    }
    out.visibility = payload.visibility;
  }

  if (payload.invitePolicy !== undefined) {
    if (!INVITE_POLICIES.includes(payload.invitePolicy)) {
      return { ok: false, field: 'invitePolicy', error: 'Choose who may share the invitation link.' };
    }
    out.invitePolicy = payload.invitePolicy;
  }

  if (payload.avatar !== undefined) {
    if (payload.avatar !== null && (typeof payload.avatar !== 'string' || payload.avatar.length > 8)) {
      return { ok: false, field: 'avatar', error: 'Pick one of the available icons.' };
    }
    out.avatar = payload.avatar === null ? null : payload.avatar.trim() || null;
  }

  /* A key from the fixed palette, never a colour. A hex from a client would be
     arbitrary text rendered into a style attribute on every surface that draws
     this organization. */
  if (payload.avatarColor !== undefined) {
    if (!isAvatarColor(payload.avatarColor)) {
      return { ok: false, field: 'avatarColor', error: 'Pick one of the available colours.' };
    }
    out.avatarColor = payload.avatarColor;
  }

  return { ok: true, value: out };
}

/**
 * True when this principal may edit this organization.
 *
 * The single place the question is answered, so a second route cannot answer it
 * differently. Takes an explicit `hasModerate` rather than importing `can`,
 * keeping this module free of the authorization kernel the way `blocking.js` is.
 */
export async function canManage(db, organizationId, userId, { hasModerate = false } = {}) {
  if (hasModerate) return true;
  if (!userId) return false;
  const row = await db.prepare(`
    SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?
  `).get(organizationId, userId);
  return row?.member_role === 'manager';
}

/**
 * Is this person still part of this organization, and not banned from it?
 *
 * The question `canRunEvent` asks about somebody who hosts one of the club's
 * events. Membership alone is not enough — a ban removes the membership row, so
 * both halves matter: a former member who was banned and then somehow re-added
 * must not be running the club's shifts.
 */
async function stillWelcomeIn(db, organizationId, userId) {
  const member = await db.prepare(
    'SELECT 1 AS ok FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(organizationId, userId);
  if (!member) return false;

  const banned = await db.prepare(`
    SELECT 1 AS ok FROM organization_bans
     WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL
  `).get(organizationId, userId);
  return !banned;
}

/**
 * The ranks a membership row may hold, weakest first.
 *
 * `member` belongs to the club. `student_organizer` helps run it — posts and
 * events, and nothing else. `manager` is the organization itself: who else runs
 * it, who is banned, whether it continues to exist.
 *
 * Migration 046 carries the same three values as a CHECK constraint. This array
 * is the readable copy the routes validate against; the constraint is what stops
 * a fourth value reaching the column by some path nobody wrote a test for.
 */
export const MEMBER_ROLES = Object.freeze(['member', 'student_organizer', 'manager']);

/** This person's rank in this organization, or `null` if they are not in it. */
export async function memberRoleOf(db, organizationId, userId) {
  if (!organizationId || !userId) return null;
  const row = await db.prepare(`
    SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?
  `).get(organizationId, userId);
  return row?.member_role ?? null;
}

/**
 * True when this principal may act as the organization for the day-to-day work:
 * posting announcements and putting events up.
 *
 * ── Why this is a second function and not a flag on `canManage` ──
 *
 * `canManage` is asked by archive, member removal, role changes, bans and the
 * appeal inbox. Widening it — even behind an option — would make the safe answer
 * the one you have to remember to ask for, and a route added next year that
 * simply calls `canManage(db, id, user)` would silently hand a sixteen-year-old
 * the power to delete the club. Two functions means the dangerous question keeps
 * its own name and its own answer, and a new route has to say which it means.
 *
 * Managers are included: every power a student organizer has, a manager has.
 * Nobody should have to promote themselves downward to post a notice.
 */
export async function canHelpRun(db, organizationId, userId, { hasModerate = false } = {}) {
  if (hasModerate) return true;
  const role = await memberRoleOf(db, organizationId, userId);
  return role === 'manager' || role === 'student_organizer';
}

/**
 * The capabilities that make somebody staff on an event.
 *
 * ── Why a list rather than a middleware ──
 *
 * `canRunEvent` reads the membership table and knows nothing about agreements.
 * That is right for what it answers — "is this your event" — and it is why the
 * WRITE routes pair it with `requireCapAny`: the middleware is where a withheld
 * capability is refused, because `can()` is the only thing that consults
 * `principal.withheld`.
 *
 * Three READ routes had no middleware at all and stood on `canRunEvent` alone,
 * so a student who had been promoted but had not yet accepted the Student
 * Organizer Agreement could still open the applicant list with everybody's
 * grade and school on it — the exact data the agreement is about. They cannot
 * take the whole route behind a gate, because two of them also serve ordinary
 * attendees, so they ask this list where they compute "is the reader staff".
 */
export const EVENT_STAFF_CAPABILITIES = Object.freeze([
  'event.moderate',
  'event.edit.own',
  'applicant.review',
  'attendance.view',
  'organization.event.manage.own',
]);

/**
 * May this principal run this event — edit it, review its applicants, take its
 * attendance?
 *
 * ── The question this replaces, and why it was wrong ──
 *
 * Every one of those routes asked `event.organizer_id === userId`: personal
 * ownership, nothing else. That was right while only organizers could host,
 * because an event belonged to the adult who typed it in.
 *
 * It stopped being right the moment a Student Organizer could post for a club.
 * Two consequences, both bad, and the second is worse:
 *
 *   • The club's own MANAGER could not touch an event published under the
 *     club's name — not edit it, not cancel it, not accept an applicant, not
 *     record who turned up.
 *
 *   • Demoting or removing the student left the event with nobody. They lose
 *     the capability at the middleware, the manager never had the ownership,
 *     and `POST /api/events/:id/attendance` is the only path that writes
 *     credited hours. Everybody who worked that shift would silently never be
 *     credited for it, and the design actively encourages the demotion that
 *     causes it.
 *
 * So the question is now "do you host it, or do you MANAGE the organization it
 * belongs to". A personal event with no organization is unchanged: only its
 * host and a moderator.
 *
 * ── Why `canManage` here and `canHelpRun` on the create routes ──
 *
 * A Student Organizer runs the events they put up, and no more. They cannot
 * cancel the manager's event, edit its shifts, or decide its applicants —
 * being trusted to post the bake-sale shift is not being trusted to call off
 * the fundraiser somebody else built.
 *
 * That leaves nobody stranded, because the manager is above every event in the
 * club by construction: whatever a helper posts, and whatever becomes of the
 * helper, a manager can always act on it. Two helpers covering for each other
 * is the one thing this refuses, and the manager is the escalation for it.
 *
 * @param {object} event a row from `events` — needs `organizer_id` and
 *   `organization_id`
 */
export async function canRunEvent(db, event, userId, { hasModerate = false } = {}) {
  if (hasModerate) return true;
  if (!event || !userId) return false;
  /**
   * Hosting it is enough — UNLESS the club has since shown you the door.
   *
   * The host branch used to stand on its own, and that let removal be
   * incomplete. Somebody removed or banned from a club kept every power over the
   * events they had already posted for it: the roster export with names, emails,
   * schools and grades, the attendance write that credits hours, the broadcast
   * that emails everyone on it. A club that removed a helper had not removed
   * their access to the club's people, only their ability to add more.
   *
   * Re-asked against the membership table rather than remembered, so lifting a
   * ban or re-admitting somebody restores it without a second bookkeeping step.
   * An event with no organization is unaffected: there is no club to be removed
   * from, and its host keeps it.
   */
  if (event.organizer_id && event.organizer_id === userId) {
    if (!event.organization_id) return true;
    return await stillWelcomeIn(db, event.organization_id, userId);
  }

  /**
   * A row that does not CARRY `organization_id` is a caller bug, not an event
   * belonging to nobody, and the two must not look alike.
   *
   * Several call sites load the event through a join that names its columns
   * (`SELECT a.*, e.organizer_id, ...`). Omit `e.organization_id` from one of
   * those and this function reads `undefined`, decides the event belongs to no
   * organization, and refuses the club's own manager — silently, correctly-
   * shaped, and wrong. That happened on both application-review routes within
   * an hour of this function being written.
   *
   * `null` is a real answer and passes through. An absent property throws,
   * because the caller has not been asked the question this function needs.
   */
  if (!('organization_id' in event)) {
    throw new Error(
      'canRunEvent needs `organization_id` on the event row. The query that '
      + 'loaded it names its columns and does not select it — add '
      + '`e.organization_id` there rather than letting this read as "no organization".'
    );
  }

  if (!event.organization_id) return false;
  return await canManage(db, event.organization_id, userId);
}

export async function createOrganization(db, {
  name, description = '', tags = [], creator,
  /**
   * The three settings a creator can choose, and they are HONOURED.
   *
   * They used to be dropped: the route validated `visibility`, `joinPolicy` and
   * `invitePolicy` onto `check.value` and then called this function without
   * them, so every new club got the column defaults. For visibility that was a
   * privacy failure reachable on the first try through the ordinary form — an
   * organizer chose "Only people signed in", saved, and got a club whose page
   * was open to the internet, with the Share dialog then advertising the public
   * address to every member. For the two policies it was quieter and just as
   * wrong: a club created "Invitation only" was joinable by anybody.
   *
   * Defaulted here rather than required, because `bin/` scripts and the demo
   * seed create organizations too and should keep getting the product's
   * defaults without naming them.
   */
  visibility = DEFAULT_VISIBILITY,
  joinPolicy = DEFAULT_JOIN_POLICY,
  invitePolicy = DEFAULT_INVITE_POLICY,
  now = new Date().toISOString(),
}) {
  const orgId = `org-${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO organizations
      (id, name, slug, description, tags, created_by, created_by_name_snapshot, status,
       visibility, join_policy, invite_policy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(
    orgId, name, await uniqueSlug(db, name), description, JSON.stringify(tags),
    creator.id, creator.name,
    /**
     * Normalised on the way in, so a caller that skipped `validateOrganization`
     * — a `bin/` script, the demo seed — cannot write a value outside the
     * vocabulary. `normaliseVisibility` in particular fails closed towards not
     * publishing.
     *
     * The column DEFAULTs are deliberately NOT what these resolve to when
     * absent: the column says `unlisted` because migration 063 backfills every
     * club that predates the setting, and `DEFAULT_VISIBILITY` says `public`
     * because a club created today is created by somebody looking at the
     * setting. Stating the value here is what keeps those two answers apart.
     */
    normaliseVisibility(visibility),
    normaliseJoinPolicy(joinPolicy),
    normaliseInvitePolicy(invitePolicy),
    now, now,
  );

  /* The creator is seeded as a manager rather than being implicit in
     `created_by`. One membership table answers "who may manage this", which
     keeps working after the creator's account is deleted and `created_by` goes
     NULL. */
  await db.prepare(`
    INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
    VALUES (?, ?, 'manager', ?)
  `).run(orgId, creator.id, now);

  return orgId;
}

const parseTags = (raw) => {
  if (!raw) return [];
  try {
    const t = JSON.parse(raw);
    return Array.isArray(t) ? t.filter(v => typeof v === 'string') : [];
  } catch { return []; }
};

/**
 * The public shape of an organization.
 *
 * `memberCount` and `eventCount` arrive as columns from the caller's aggregate
 * query, never as a per-row lookup — see the queries in organizationRoutes.js,
 * which compute both in the same statement that selects the organizations.
 */
export function formatOrganization(row) {
  return {
    kind: 'organization',
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    tags: parseTags(row.tags),
    /**
     * The creator's name comes from the snapshot, and their id from the live
     * column. The snapshot is what survives account deletion — a record of who
     * founded a club should not become "Unknown" because they graduated — while
     * the nullable id is what stops the page linking to a profile that is gone.
     */
    createdBy: row.created_by
      ? { id: row.created_by, name: row.created_by_name_snapshot || 'Organizer' }
      : { id: null, name: row.created_by_name_snapshot || 'Former member' },
    /* Both, so the renderer can prefer the upload and fall back to the emoji —
       the same contract `users` publishes, so one avatar component serves
       people and organizations without learning which it was handed. */
    avatar: row.avatar || null,
    imageUrl: row.image_url || null,
    allowReplies: row.allow_replies !== 0,
    avatarColor: row.avatar_color || null,
    /**
     * The membership settings, normalised on the way out.
     *
     * Published to every reader, not only to managers, because the page has to
     * be able to say "this club admits by invitation" to somebody who is not in
     * it — that is the whole of §17: discovering a club and being allowed into
     * it are different questions, and one that hid its policy would leave a
     * student pressing a button that cannot work.
     *
     * `invitePolicy` is not a secret either: it says which ranks may pass the
     * link on, which is a fact about how the club is run and is visible from its
     * roster anyway.
     */
    joinPolicy: normaliseJoinPolicy(row.join_policy),
    invitePolicy: normaliseInvitePolicy(row.invite_policy),
    /**
     * Whether the club has a public page.
     *
     * Also published to every signed-in reader, and for a reason that is easy to
     * get backwards: this is not a secret being leaked, it is a WARNING being
     * given. A member about to post the club's address in a group chat needs to
     * know whether the people they send it to will be able to open it. Hiding
     * the setting from the members who share the link is how a club discovers
     * its visibility by accident.
     */
    visibility: normaliseVisibility(row.visibility),
    /* Present only on the "mine" listing, which joins membership. Undefined
       elsewhere rather than null, so a caller can tell "not asked" from "not a
       manager". */
    viewerRole: row.viewer_role ?? undefined,
    memberCount: row.memberCount ?? 0,
    eventCount: row.eventCount ?? 0,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * What a stranger holding an invitation link may see.
 *
 * ── An allowlist, and a separate function, on purpose ──
 *
 * `formatOrganization` serves signed-in readers and grows over time; every field
 * added to it is a field a member may see, which is the right default for that
 * function and the wrong one here. If this were `formatOrganization` with a flag,
 * the next field added would become public by default and nobody would notice
 * until it was.
 *
 * So this names, one by one, what is published to somebody with no account. Two
 * functions rather than a flag, for the same reason `canManage` and `canHelpRun`
 * are two functions: the narrow answer keeps its own name, so a route cannot get
 * the wide one by forgetting an argument.
 *
 * ── What is deliberately absent, and why ──
 *
 *   • **Every member.** No names, no handles, no avatars, no ranks, no count of
 *     managers. The roster is a list of children, and a link forwarded once into
 *     a group chat must not publish it. The member COUNT stays: "forty members"
 *     names nobody and is what tells a parent the club is real.
 *   • **The founder's name.** A person, published to an unauthenticated reader,
 *     for no reason the page needs.
 *   • **Event locations.** An upcoming event's title and date advertise the club;
 *     its location is where named minors will physically be at a stated time, and
 *     that is not something a share link should publish outside the platform.
 *   • **The organization id.** The slug is enough for the signed-in redirect, and
 *     an id would be a second handle on the record for no gain.
 *   • **Announcements, hours, bans, appeals, join requests, and the token.**
 *
 * @param {object} row an `organizations` row, with `memberCount`/`eventCount`
 * @param {Array}  upcoming already-narrowed event rows: title, startsAt, category
 */
export function publicOrganization(row, { upcoming = [] } = {}) {
  return {
    kind: 'organization',
    /* The handle travels so a signed-in reader can be sent to the real page, and
       so the address bar can say the club's name rather than a token. It is not
       a capability: the signed-in page requires a session and `directory.read`,
       exactly as it did before this feature existed. */
    slug: row.slug,
    /* The canonical address, built once on the server so no client has to know
       that the `@` is punctuation rather than part of the stored handle. */
    handle: `@${row.slug}`,
    name: row.name,
    description: row.description || '',
    tags: parseTags(row.tags),
    avatar: row.avatar || null,
    imageUrl: row.image_url || null,
    avatarColor: row.avatar_color || null,
    memberCount: row.memberCount ?? 0,
    eventCount: row.eventCount ?? 0,
    joinPolicy: normaliseJoinPolicy(row.join_policy),
    /* So the invitation page can say what pressing Join will actually do —
       "join straight away" against "ask a manager" — before somebody makes an
       account for it. */
    upcoming: upcoming.map(e => ({
      title: e.title,
      startsAt: e.startsAt ?? null,
      category: e.category ?? null,
    })),
  };
}

/**
 * The counts every organization payload carries, as a SELECT fragment.
 *
 * Shared by the two resolvers below so they cannot disagree about what a
 * member count is — one of them feeds the public projection and the other feeds
 * the page, and a club that reported different numbers on the two would be a
 * bug nobody could see from either.
 */
const WITH_COUNTS = `
  SELECT o.*,
         (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS "memberCount",
         (SELECT COUNT(*) FROM events e WHERE e.organization_id = o.id) AS "eventCount"
    FROM organizations o
`;

/**
 * The organization a route key names — a handle, or an id.
 *
 * ── Two questions, in order, and never one OR ──
 *
 * It used to be `WHERE o.slug = ? COLLATE nocase OR o.id = ?`, and the
 * ambiguity was exploitable. An organization id is `org-` plus a UUID: exactly
 * `HANDLE_MAX` characters, starts with a letter, lowercase alphanumerics and
 * single hyphens — so it satisfied every rule `validateHandle` applied, and a
 * manager could set their own handle to another club's id. The union plan
 * returned the slug match first, so the attacker's club shadowed the victim's
 * on every id-addressed path: the notification and audit links this feature
 * deliberately keeps working would land the victim's own members on the
 * attacker's page.
 *
 * ── The ID is asked FIRST, and that order is the fix ──
 *
 * Handle-first was tried and is wrong: it hands the attacker exactly what they
 * wanted, because their chosen handle wins over the victim's assigned id.
 * Verified against a running server before this was written — with handle-first,
 * `/api/organizations/org-robotics` resolved to the club that had claimed that
 * string as its handle rather than to the club whose id it is.
 *
 * Ids are assigned by the system; handles are chosen by people. A value that
 * somebody typed must never override an identifier the system minted, so the
 * id namespace is consulted first. If a handle does collide with some club's
 * id, the club that loses its address is the one that chose the colliding name
 * — which is the right way round for the harm to fall.
 *
 * `handleAvailable` refuses such a handle outright, so the collision should not
 * exist; this order is what makes it harmless if one ever does.
 *
 * Lives here rather than in the route for the reason `db.accessSurface.test.js`
 * ratchets: this module receives a handle, so these statements can be given a
 * pooled client during the PostgreSQL port.
 */
export async function organizationByKey(db, key) {
  const raw = String(key ?? '');

  /* The id branch is not only for legacy links — it is the precedence rule.
     Notification payloads and audit rows written before handles existed do also
     name organizations by id, and must keep resolving. */
  const byId = raw ? await db.prepare(`${WITH_COUNTS} WHERE o.id = ?`).get(raw) : null;
  if (byId) return byId;

  const handle = normaliseHandle(raw);
  return (handle
    ? await db.prepare(`${WITH_COUNTS} WHERE o.slug = ? COLLATE nocase`).get(handle)
    : null) ?? null;
}

/**
 * The organization at a handle, if it has a public page.
 *
 * ── One function, so "is this public" has one answer ──
 *
 * Three conditions, and getting any of them wrong publishes something: the
 * handle has to match, the club has to be active, and its visibility has to be
 * `public`. `normaliseVisibility` rather than a raw comparison, so a row that
 * predates the column — NULL — reads as unlisted rather than as neither value
 * and therefore not-not-public.
 *
 * `null` for all three failures, which is what lets the route answer one
 * identical 404: handles are guessable by design, so distinguishing "not
 * public" from "does not exist" would make the endpoint a directory of every
 * club that chose not to be listed.
 *
 * The read lives here rather than in the route for the reason
 * `db.accessSurface.test.js` ratchets — this module receives a handle and can
 * be given a pooled client — and because the SELECT then sits beside the
 * allowlist that decides what leaves it.
 */
export async function publicOrganizationByHandle(db, handle) {
  const slug = normaliseHandle(handle);
  if (!slug) return null;
  const row = await db.prepare(`${WITH_COUNTS} WHERE o.slug = ? COLLATE nocase`).get(slug);

  if (!row || row.status !== 'active') return null;
  return normaliseVisibility(row.visibility) === 'public' ? row : null;
}

/**
 * Reads what `publicOrganization` needs, and returns the projection.
 *
 * ── Why the queries live here and not in the route ──
 *
 * Two reasons, and both matter. The first is the one
 * `db.accessSurface.test.js` ratchets: this module RECEIVES a handle, so these
 * two statements can be given a pooled client during the PostgreSQL port, while
 * the same statements written in the route file reach for the imported global
 * and cannot.
 *
 * The second is that the projection and the reads that feed it are one decision.
 * `publicOrganization` promises that no event location and no member reaches an
 * unauthenticated reader; a route free to write its own query is free to select
 * `e.location` and hand it in. Keeping the SELECT beside the allowlist means the
 * promise is checkable in one place.
 *
 * @param {object} db     a database handle
 * @param {object} org    an `organizations` row
 */
export async function publicOrganizationSnapshot(db, org, { upcomingLimit = 3, now = Date.now() } = {}) {
  /* Both counts in one statement rather than two round trips, the shape
     `ORG_SELECT` uses — and only these two, because they are the only aggregate
     the projection publishes. */
  const counts = await db.prepare(`
    SELECT (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = ?) AS "memberCount",
           (SELECT COUNT(*) FROM events e WHERE e.organization_id = ?) AS "eventCount"
  `).get(org.id, org.id);

  /**
   * A few upcoming opportunities, by title and date.
   *
   * Enough to show the club is active — an invitation page with nothing on it
   * reads as an empty club rather than a new one — and deliberately NOT the
   * location. An event's location is where named minors will physically be at a
   * stated time, and a share link has no business publishing that outside the
   * platform. Cancelled events are excluded for the reason the signed-in page
   * gives: an event that is not happening is not something to advertise.
   *
   * Filtered in SQL on the derived start, then bounded in JavaScript, because
   * the start is a correlated MIN over `slots` and an event with no slot yet has
   * none at all — a WHERE against it would silently drop the ordering the
   * LIMIT depends on.
   */
  const rows = await db.prepare(`
    SELECT e.title, e.category,
           (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) AS "startsAt"
    FROM events e
    WHERE e.organization_id = ? AND e.status <> 'cancelled'
    ORDER BY "startsAt" ASC
    LIMIT 40
  `).all(org.id);

  const upcoming = rows
    .filter(e => e.startsAt && Date.parse(e.startsAt) >= now)
    .slice(0, upcomingLimit);

  return publicOrganization({ ...org, ...counts }, { upcoming });
}

/**
 * May this principal hand out the organization's invitation link?
 *
 * ── Why this is not `canManage` and not `canHelpRun` ──
 *
 * It is whichever of those two the ORGANIZATION has chosen, which is a question
 * neither of them can answer on its own. `invite_policy` is the club's setting;
 * this is the one place it is turned into a yes or a no, so a second route
 * cannot answer it differently.
 *
 * Takes the ranks as parameters rather than re-reading them, because both
 * callers have already loaded the membership row for other reasons and a second
 * lookup on every organization page load is a query nobody needs.
 *
 * Sharing only. Creating, rotating and switching the link off is always
 * `canManage` — those are decisions about the club's front door rather than
 * about passing its address on, and the route asks `canManage` for them
 * directly.
 */
export function canInvite({ invitePolicy, memberRole, hasModerate = false }) {
  if (hasModerate) return true;
  if (!memberRole) return false;
  if (normaliseInvitePolicy(invitePolicy) === 'members') return true;
  return memberRole === 'manager' || memberRole === 'student_organizer';
}

/**
 * Members of an organization, for the notification fan-out.
 *
 * One query returning ids. The caller then writes notifications in a single
 * transaction — never a query per member, which for a club of three hundred is
 * three hundred round trips inside the request that created the event.
 */
export async function memberIds(db, organizationId, { excluding = [] } = {}) {
  const rows = await db.prepare(`
    SELECT m.user_id FROM organization_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND u.account_status = 'active'
  `).all(organizationId);
  const skip = new Set(excluding);
  return rows.map(r => r.user_id).filter(id => !skip.has(id));
}
