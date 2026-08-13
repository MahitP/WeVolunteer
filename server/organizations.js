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

export const ORG_NAME_MAX = 120;
export const ORG_DESCRIPTION_MAX = 2000;
export const MAX_ORG_TAGS = 8;

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

export function uniqueSlug(db, name) {
  const base = slugify(name) || 'organization';
  let candidate = base;
  let n = 1;
  /* COLLATE NOCASE to match idx_organizations_slug, so the uniqueness check and
     the unique index agree about what a collision is. */
  const taken = db.prepare('SELECT 1 FROM organizations WHERE slug = ? COLLATE NOCASE');
  while (taken.get(candidate)) {
    n += 1;
    candidate = `${base}-${n}`.slice(0, 64);
  }
  return candidate;
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
 * The longest a single organization tag may be.
 *
 * Per tag, never across the collection — see `normaliseOrgTags`.
 */
export const MAX_ORG_TAG_LENGTH = 40;

/**
 * Turns whatever the editor sent into a clean list of tag labels.
 *
 * ── The bug this exists to make impossible ──
 *
 * The check used to be one `.some()` doing three jobs:
 *
 *     payload.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 40)
 *
 * with a single message about the 40-character limit. `TagInput` is shared with
 * the event editor and emits `{tag, label}` OBJECTS, so every real submission
 * failed on the FIRST clause and was reported against the THIRD — an organizer
 * was told their perfectly short tags were too long. Submitting no tags worked,
 * because `.some()` over an empty array is false, which is precisely what hid
 * the fault: the feature looked merely broken rather than mistyped.
 *
 * So this accepts both shapes. The client sends strings now, but a validator
 * that only understands one shape is a validator that breaks again the next
 * time a shared control is reused, and the object form carries strictly more
 * information than it needs rather than less.
 *
 * ── What it guarantees ──
 *
 *   · every tag is a trimmed, non-empty string
 *   · every tag is at most `MAX_ORG_TAG_LENGTH`, measured per tag
 *   · duplicates are dropped, matched case-insensitively, first spelling wins
 *   · the count limit is applied AFTER de-duplication, so "Food Drive" twice
 *     does not consume two of somebody's eight slots
 *   · a refusal names the offending tag, because an organizer with eight tags
 *     and one mistake should not have to bisect their own input
 *
 * Duplicates are dropped rather than refused: two spellings of one thing is a
 * typo, and stopping the whole submission for it teaches people to avoid the
 * control.
 */
export function normaliseOrgTags(raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, field: 'tags', error: 'Tags must be a list.' };
  }

  const seen = new Set();
  const value = [];

  for (const entry of raw) {
    /* `{tag, label}` from the shared editor, or a plain string. Anything else
       is a shape nobody meant to send. */
    const text = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' && typeof entry.label === 'string' ? entry.label : null);

    if (text === null) {
      return { ok: false, field: 'tags', error: 'Each tag must be text.' };
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, field: 'tags', error: 'A tag cannot be blank.' };
    }
    if (trimmed.length > MAX_ORG_TAG_LENGTH) {
      return {
        ok: false,
        field: 'tags',
        error: `"${trimmed}" is too long — each tag must be ${MAX_ORG_TAG_LENGTH} characters or fewer.`,
      };
    }

    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    value.push(trimmed);
  }

  if (value.length > MAX_ORG_TAGS) {
    return { ok: false, field: 'tags', error: `Please use ${MAX_ORG_TAGS} tags or fewer.` };
  }

  return { ok: true, value };
}

/**
 * True when this principal may edit this organization.
 *
 * The single place the question is answered, so a second route cannot answer it
 * differently. Takes an explicit `hasModerate` rather than importing `can`,
 * keeping this module free of the authorization kernel the way `blocking.js` is.
 */
export function canManage(db, organizationId, userId, { hasModerate = false } = {}) {
  if (hasModerate) return true;
  if (!userId) return false;
  const row = db.prepare(`
    SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?
  `).get(organizationId, userId);
  return row?.member_role === 'manager';
}

export function createOrganization(db, { name, description = '', tags = [], creator, now = new Date().toISOString() }) {
  const orgId = `org-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO organizations
      (id, name, slug, description, tags, created_by, created_by_name_snapshot, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(orgId, name, uniqueSlug(db, name), description, JSON.stringify(tags), creator.id, creator.name, now, now);

  /* The creator is seeded as a manager rather than being implicit in
     `created_by`. One membership table answers "who may manage this", which
     keeps working after the creator's account is deleted and `created_by` goes
     NULL. */
  db.prepare(`
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
 * Members of an organization, for the notification fan-out.
 *
 * One query returning ids. The caller then writes notifications in a single
 * transaction — never a query per member, which for a club of three hundred is
 * three hundred round trips inside the request that created the event.
 */
export function memberIds(db, organizationId, { excluding = [] } = {}) {
  const rows = db.prepare(`
    SELECT m.user_id FROM organization_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND u.account_status = 'active'
  `).all(organizationId);
  const skip = new Set(excluding);
  return rows.map(r => r.user_id).filter(id => !skip.has(id));
}
