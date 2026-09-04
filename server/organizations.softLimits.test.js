import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SOFT_MAX_LIVE_LINKS, createShareLink, liveLinkCount, revokeShareLink, shareLinksFor,
} from './organizationShareLinks.js';
import { SOFT_MAX_PENDING_INVITATIONS, inviteUser, pendingInvitationCount } from './organizationInvitations.js';
import migration062 from './migrations/062_organization_membership_policy.js';
import migration063 from './migrations/063_organization_public_identity.js';

/**
 * The two ceilings are PRODUCT SANITY LIMITS, and this file is what stops them
 * being mistaken for security boundaries.
 *
 * ── The decision, and the evidence behind it ──
 *
 * Both are checked with a read followed by a write, so a concurrent burst can
 * overshoot. That was reviewed properly rather than assumed away, and advisory
 * came out the right answer on four grounds — each of which is asserted below,
 * because a claim in a comment is a claim nobody re-checks:
 *
 *   1. **Nothing in authorization reads either constant.** Who may create a
 *      link or send an invitation is decided by `requireCap` and `canManage`,
 *      and neither consults a count.
 *   2. **Overshoot is bounded and self-correcting.** Each attempt re-reads, so
 *      a burst of N against a club at the ceiling minus one yields at most
 *      ceiling − 1 + N, and the next attempt refuses everything.
 *   3. **The bounds that matter are enforced elsewhere, properly.** One pending
 *      invitation per person per club is a partial UNIQUE index — the database,
 *      not a count — and the invitation route carries a per-account rate limit.
 *   4. **Exceeding either crosses no privilege boundary.** The actor is a
 *      manager of that club, who can already hand the club's link to any number
 *      of people.
 *
 * Hard enforcement would mean a lock held across a write, or a counter column
 * with its own drift problem, paid to prevent a club briefly holding seventeen
 * links it can see and revoke.
 *
 * ── And the system must not CLAIM enforcement it does not have ──
 *
 * The last assertions check that no database constraint mentions either
 * ceiling, and that the user-facing copy does not describe it as a hard cap.
 * That half matters as much as the behaviour: a limit documented as absolute is
 * one somebody will later build on.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'wev-softlimits-'));
let db;

function schema() {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT,
      avatar TEXT, avatar_color TEXT, profile_picture_url TEXT,
      role TEXT NOT NULL DEFAULT 'volunteer', location TEXT,
      account_status TEXT DEFAULT 'active'
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE organization_members (
      organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
      member_role TEXT NOT NULL DEFAULT 'member', joined_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id)
    );
  `);
  db.prepare(`
    INSERT INTO organizations (id, name, slug, created_at, updated_at)
    VALUES ('org-1', 'Chess Club', 'chess-club', '2026-01-01', '2026-01-01')
  `).run();
  migration062.up(db);
  migration063.up(db);
}

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(path.join(dir, `s-${Math.random().toString(36).slice(2)}.db`));
  schema();
});

afterAll(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('both ceilings are named as soft limits', () => {
  /**
   * The `SOFT_` prefix is load-bearing.
   *
   * It was `MAX_LIVE_LINKS` and `MAX_PENDING_INVITATIONS`, which read as hard
   * caps at every call site. The rename is what makes a reader of
   * `if (count >= SOFT_MAX_LIVE_LINKS)` ask the right question about
   * concurrency instead of assuming the database is holding the line.
   */
  it('carry the prefix in their exported names', () => {
    expect(SOFT_MAX_LIVE_LINKS).toBe(10);
    expect(SOFT_MAX_PENDING_INVITATIONS).toBe(100);
  });

  it('are not referred to by a hard-sounding name anywhere', () => {
    for (const file of [
      'server/organizationShareLinks.js',
      'server/organizationInvitations.js',
      'server/routes/organizationRoutes.js',
    ]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const bare = src.match(/(?<!SOFT_)\bMAX_(LIVE_LINKS|PENDING_INVITATIONS)\b/g) ?? [];
      expect(bare, `${file} still names a soft limit as MAX_`).toEqual([]);
    }
  });
});

describe('normal operation respects the link ceiling', () => {
  it('permits exactly the ceiling, then refuses', async () => {
    for (let i = 0; i < SOFT_MAX_LIVE_LINKS; i += 1) {
      await createShareLink(db, 'org-1', { label: `L${i}` });
    }
    expect(await liveLinkCount(db, 'org-1')).toBe(SOFT_MAX_LIVE_LINKS);

    /* The route's own guard, which is the only thing that applies it. */
    expect(await liveLinkCount(db, 'org-1') >= SOFT_MAX_LIVE_LINKS).toBe(true);
  });

  /** Revoked links are history and do not hold a slot. */
  it('frees a slot when a link is switched off', async () => {
    const first = await createShareLink(db, 'org-1', { label: 'First' });
    for (let i = 1; i < SOFT_MAX_LIVE_LINKS; i += 1) {
      await createShareLink(db, 'org-1', { label: `L${i}` });
    }
    expect(await liveLinkCount(db, 'org-1')).toBe(SOFT_MAX_LIVE_LINKS);

    await revokeShareLink(db, 'org-1', first.id);
    expect(await liveLinkCount(db, 'org-1')).toBe(SOFT_MAX_LIVE_LINKS - 1);
    /* And the revoked row is still there, so its join count survives. */
    expect(await shareLinksFor(db, 'org-1')).toHaveLength(SOFT_MAX_LIVE_LINKS);
  });
});

describe('the overshoot is bounded and self-correcting', () => {
  /**
   * The measurement that decided the design, kept as a test.
   *
   * A burst against a club one below the ceiling overshoots by at most the
   * burst size — never without bound — because every attempt re-reads. Asserted
   * as a BOUND rather than an exact number, since the interleaving is the
   * scheduler's business.
   */
  it('overshoots by at most the number of requests in flight', async () => {
    for (let i = 0; i < SOFT_MAX_LIVE_LINKS - 1; i += 1) {
      await createShareLink(db, 'org-1', { label: `L${i}` });
    }

    const BURST = 8;
    const attempt = async (i) => {
      if (await liveLinkCount(db, 'org-1') >= SOFT_MAX_LIVE_LINKS) return 'refused';
      await createShareLink(db, 'org-1', { label: `burst-${i}` });
      return 'created';
    };
    await Promise.all(Array.from({ length: BURST }, (_, i) => attempt(i)));

    const live = await liveLinkCount(db, 'org-1');
    expect(live).toBeGreaterThanOrEqual(SOFT_MAX_LIVE_LINKS);
    expect(
      live - SOFT_MAX_LIVE_LINKS,
      'overshoot must be bounded by the burst size, not unbounded',
    ).toBeLessThanOrEqual(BURST);

    /* And the next attempt refuses, which is what "self-correcting" means: the
       breach does not compound. */
    expect(await attempt(99)).toBe('refused');
    expect(await liveLinkCount(db, 'org-1')).toBe(live);
  });

  it('does the same for invitations', async () => {
    for (let i = 0; i < SOFT_MAX_PENDING_INVITATIONS; i += 1) {
      db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(`u${i}`, `Student ${i}`);
      db.prepare(`
        INSERT INTO organization_invitations
          (id, organization_id, invited_user_id, status, created_at, expires_at)
        VALUES (?, 'org-1', ?, 'pending', '2026-09-04', '2026-09-18')
      `).run(`i${i}`, `u${i}`);
    }
    expect(await pendingInvitationCount(db, 'org-1')).toBe(SOFT_MAX_PENDING_INVITATIONS);

    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('extra', 'One More');
    expect(await inviteUser(db, 'org-1', 'extra')).toEqual({ ok: false, reason: 'full' });
  });
});

describe('neither ceiling is a security boundary', () => {
  /**
   * Nothing in authorization reads them.
   *
   * Read out of the source, because that is the claim: `requireCap` and
   * `canManage` are what decide who may create a link or send an invitation,
   * and if a count ever appeared in an authorization decision the ceiling would
   * stop being advisory and this file would be wrong.
   */
  it('is not consulted by any authorization helper', () => {
    for (const file of ['server/authz.js', 'server/organizations.js', 'server/organizationRoles.js']) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(src, `${file} reads a soft ceiling`).not.toMatch(/SOFT_MAX_(LIVE_LINKS|PENDING_INVITATIONS)/);
    }
  });

  /**
   * And no database constraint claims to enforce either one.
   *
   * If one ever appears, the limit has become hard and the reasoning in both
   * constants is stale — which is the thing this asserts, rather than that a
   * constraint would be wrong.
   */
  it('has no database constraint standing behind it', async () => {
    const ddl = db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE name IN ('organization_share_links', 'organization_invitations')
    `).all().map(r => r.sql ?? '').join('\n');

    expect(ddl).not.toMatch(/\b10\b\s*\)/);
    expect(ddl).not.toMatch(/COUNT\s*\(/i);
    expect(ddl).not.toMatch(/CHECK[^)]*(100|10)\b/i);
  });

  /**
   * The bounds that ARE enforced, asserted so the trade is visible.
   *
   * One pending invitation per person per club is the database's job, and it is
   * the control that actually answers the spam question the invitation ceiling
   * looks like it answers.
   */
  it('leans on the partial unique index for the bound that matters', async () => {
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u1', 'Leo');
    expect((await inviteUser(db, 'org-1', 'u1')).ok).toBe(true);
    /* Refused by the index, not by a count. */
    expect(await inviteUser(db, 'org-1', 'u1')).toEqual({ ok: false, reason: 'pending' });

    const index = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_org_invitations_live'",
    ).get();
    expect(index?.sql).toMatch(/UNIQUE/i);
    expect(index.sql).toMatch(/WHERE\s+status\s*=\s*'pending'/i);
  });
});

describe('the product does not claim a hard cap', () => {
  /**
   * The copy a manager reads.
   *
   * It said "This organization has as many working links as it can have",
   * which describes a constraint. It now states the number the server applied,
   * which is a fact about the rule rather than a claim about the schema.
   */
  it('tells a manager the number rather than describing a limit', () => {
    const src = readFileSync(
      new URL('../src/components/organizations/ShareOrganizationDialog.jsx', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/as many working links as it can have/);
    expect(src).toMatch(/already has \{state\.maxLinks/);
  });

  it('documents both as product sanity limits, not security boundaries', () => {
    const linksSrc = readFileSync(new URL('../server/organizationShareLinks.js', import.meta.url), 'utf8');
    const invSrc = readFileSync(new URL('../server/organizationInvitations.js', import.meta.url), 'utf8');
    for (const [name, src] of [['share links', linksSrc], ['invitations', invSrc]]) {
      /* Whitespace-tolerant, because the house comment style wraps at 80 and
         "PRODUCT SANITY\n * LIMIT" is the same sentence. Asserting on the
         unwrapped form would be a test about line length. */
      const prose = src.replace(/\n\s*\*\s?/g, ' ');
      expect(prose, `${name} should say it is not a security boundary`)
        .toMatch(/not a security boundary|PRODUCT SANITY LIMIT/i);
      /* And says the thing that makes it one: nothing in authorization reads
         it. */
      expect(prose, `${name} should say authorization does not read it`)
        .toMatch(/Nothing in authorization reads it/i);
    }
  });
});
