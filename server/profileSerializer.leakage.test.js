/**
 * The allowlist, asserted as an allowlist.
 *
 * ── Why this file exists ──
 *
 * `profileSerializer.js` opens by explaining that a field is invisible unless
 * that file names it, and says "`profileSerializer.leakage.test.js` asserts that
 * the emitted key set is exactly the expected one — so widening it silently is
 * not possible either."
 *
 * That file did not exist. The header described a guard nobody had written, which
 * is worse than describing no guard at all: the argument for the allowlist rests
 * on it being checked, and every reader of that header was told it was.
 *
 * So the assertions here are EXACT key sets, per audience, not `toContain`. A new
 * column on `users` reaches a profile only through an edit to the serializer, and
 * an edit to the serializer that widens the payload fails here — which is the
 * point at which somebody has to decide, in a review, whether a fifteen-year-old's
 * new field belongs in front of every other member.
 *
 * ── Why the row is hand-built ──
 *
 * A `users` row with every sensitive column populated, including several that
 * arrived after the original handlers were written (`date_of_birth`,
 * `graduation_year`, `suspension_reason`, `tfa_secret`, `password_hash`). The
 * negative assertions are then about VALUES as well as keys: a leak that renamed
 * a field on the way out would still carry the value, and searching the whole
 * serialized payload for the secret catches that where a key list would not.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let dir, db, publicProfile, profileSummary, distinctionFor;

/** Only the tables the serializer touches. */
function schema(handle) {
  handle.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, status TEXT DEFAULT 'open');
    CREATE TABLE slots (id TEXT PRIMARY KEY, event_id TEXT, start_datetime TEXT, end_datetime TEXT);
    CREATE TABLE applications (id TEXT PRIMARY KEY, user_id TEXT, event_id TEXT, slot_id TEXT, status TEXT);
    CREATE TABLE attendance (
      event_id TEXT, slot_id TEXT, user_id TEXT, present INTEGER, hours_awarded REAL,
      PRIMARY KEY (slot_id, user_id)
    );
    CREATE TABLE external_hours (id TEXT PRIMARY KEY, user_id TEXT, occurred_on TEXT, hours REAL);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, slug TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE organization_members (organization_id TEXT, user_id TEXT, member_role TEXT);
  `);
}

/** Every field the platform knows about one person, sensitive ones included. */
const ROW = {
  id: 'u1',
  username: 'alice',
  name: 'Alice Rivera',
  avatar: '🦊',
  profile_picture_url: '/uploads/a.png',
  role: 'student',
  location: 'Example Valley, NJ',
  hobbies: JSON.stringify(['Baking']),
  skills: JSON.stringify(['First aid']),
  created_at: '2026-01-01T00:00:00.000Z',
  profile_visibility: 'public',
  bio: 'Hello.',
  school: 'Example Valley High',
  grade: '10',
  graduation_year: 2028,
  profile_headline: 'Runs the food drive.',
  profile_highlights: JSON.stringify(['Organized 40 shifts']),
  friend_activity_visible: 1,
  email: 'alice@example.org',
  email_verified: 1,
  /* None of the following may appear on any payload, at any visibility. */
  password_hash: '$2a$10$SECRETHASHVALUE',
  tfa_secret: 'SECRETTOTPSEED',
  date_of_birth: '2010-04-02',
  phone: '+1 555 0100',
  address: '12 Somewhere Lane',
  suspension_reason: 'SECRETSUSPENSIONREASON',
  token_version: 7,
  account_status: 'active',
  deleted_at: null,
};

const FORBIDDEN_VALUES = [
  '$2a$10$SECRETHASHVALUE', 'SECRETTOTPSEED', '2010-04-02',
  '+1 555 0100', '12 Somewhere Lane', 'SECRETSUSPENSIONREASON',
];

/**
 * The baseline every reader gets, IMPORTED rather than restated.
 *
 * This list used to be a local copy. That is how it came to disagree with the
 * module: `PUBLIC_BASELINE_FIELDS` still named `externalService` after it became
 * self-only and did not name `distinction`, and nothing failed, because the
 * exported constant the module header points a reviewer at had no consumer at
 * all. Importing it makes the documented allowlist and the enforced one the same
 * object — adding a key to it is now a deliberate disclosure decision about a
 * minor's profile that shows up in a review, which is the whole point of having
 * it written down.
 */
let BASELINE_KEYS, SENSITIVE_KEYS, CONTACT_KEYS;

/**
 * The fields a DISTINGUISHED account carries unconditionally.
 *
 * `headline` and `highlights` an ordinary account does not carry at all — they
 * are free text under a name, so on a student they would be a second `bio`, and
 * the safe version of "a student's headline is private" is a student having no
 * headline.
 *
 * `bio` is deliberately NOT in this list, even though an institutional account
 * carries it unconditionally too. It already belongs to `SENSITIVE_KEYS` —
 * every account has a bio, and on a student it stays behind
 * `profile_visibility` exactly as it always has — so listing it here as well
 * would double it in the concatenations below. The institutional exemption is
 * asserted directly instead, in both directions, in the two tests that name it.
 */
const DISTINGUISHED_KEYS = ['headline', 'highlights'];

beforeEach(async () => {
  db?.close();
  db = new DatabaseSync(path.join(dir, `p-${Math.random().toString(36).slice(2)}.db`));
  schema(db);
  const cols = Object.keys(ROW);
  for (const c of cols) {
    if (c === 'id' || c === 'name') continue;
    db.exec(`ALTER TABLE users ADD COLUMN ${c} ${typeof ROW[c] === 'number' ? 'INTEGER' : 'TEXT'}`);
  }
  db.prepare(`INSERT INTO users (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(c => ROW[c]));
});

beforeEach(async () => {
  const mod = await import('./profileSerializer.js');
  ({ publicProfile, profileSummary, distinctionFor } = mod);
  BASELINE_KEYS = [...mod.PUBLIC_BASELINE_FIELDS];
  SENSITIVE_KEYS = [...mod.PUBLIC_ONLY_FIELDS];
  CONTACT_KEYS = mod.PRIVILEGED_FIELDS.filter(k => k !== 'friendActivityVisible');
});

afterAll(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });

dir = mkdtempSync(path.join(tmpdir(), 'wev-leak-'));

const keysOf = (o) => Object.keys(o).sort();

describe('what a public profile may contain', () => {
  it('gives a stranger exactly the baseline, plus the public-only fields', async () => {
    const p = await publicProfile(db, db.prepare('SELECT * FROM users').get(), { viewerId: 'other' });
    expect(keysOf(p)).toEqual([...BASELINE_KEYS, ...SENSITIVE_KEYS, ...DISTINGUISHED_KEYS].sort());
  });

  it('withholds the public-only fields when the profile is private', async () => {
    db.prepare(`UPDATE users SET profile_visibility = 'private'`).run();
    const p = await publicProfile(db, db.prepare('SELECT * FROM users').get(), { viewerId: 'other' });
    expect(keysOf(p)).toEqual([...BASELINE_KEYS].sort());
    for (const k of SENSITIVE_KEYS) expect(p).not.toHaveProperty(k);
  });

  /**
   * The gap this closes: a headline is a second bio, and privacy has to cover it.
   *
   * A private student profile withholds `bio` — free text the account holder
   * wrote under their own name. `headline` and `highlights` are the same kind of
   * text and were on the baseline, so a student who set a private profile still
   * published one line to every holder of `directory.read`.
   */
  it('withholds a student\'s headline and highlights when the profile is private', async () => {
    db.prepare(`UPDATE users SET profile_visibility = 'private', role = 'student'`).run();
    const p = await publicProfile(db, db.prepare('SELECT * FROM users').get(), { viewerId: 'other' });
    for (const k of DISTINGUISHED_KEYS) expect(p).not.toHaveProperty(k);
  });

  /* On an official account they are the page, and an institution is not a child:
     an owner's one-line introduction must not vanish behind a privacy toggle. */
  it.each(['super_admin', 'partner'])(
    'keeps a %s account\'s headline and highlights at every privacy setting', async (role) => {
      db.prepare(`UPDATE users SET profile_visibility = 'private', role = ?, bio = 'Who we are.'`)
        .run(role);
      const p = await publicProfile(db, db.prepare('SELECT * FROM users').get(), { viewerId: 'other' });
      for (const k of DISTINGUISHED_KEYS) expect(p).toHaveProperty(k);
      /* The exemption this test exists to pin: a partner's own description of
         itself is visible at a private setting, because an institution is not a
         child and the paragraph IS the page. */
      expect(p.bio, 'an institution\'s own description is the page').toBe('Who we are.');
      expect(p.distinction).toBeTruthy();

      /* The exemption is for the institutional fields ONLY. School and grade
         stay behind the privacy setting whoever holds the account — nothing
         here widens what is disclosed about a person. */
      for (const k of ['school', 'grade', 'graduationYear']) expect(p).not.toHaveProperty(k);
    });

  /* And the other direction: a STUDENT's bio keeps its gate exactly as it was. */
  it('still hides an ordinary account\'s bio at a private setting', async () => {
    db.prepare(`UPDATE users SET profile_visibility = 'private', role = 'student', bio = 'Mine.'`)
      .run();
    const p = await publicProfile(db, db.prepare('SELECT * FROM users').get(), { viewerId: 'other' });
    expect(p).not.toHaveProperty('bio');
    expect(p.distinction).toBeNull();
  });

  /* 'friends' behaves as 'private' to a stranger and as 'public' to an accepted
     friend. One decision, made here, so no consumer invents its own reading. */
  it('treats friends-only as private to a stranger and public to a friend', async () => {
    db.prepare(`UPDATE users SET profile_visibility = 'friends'`).run();
    const row = db.prepare('SELECT * FROM users').get();
    expect(keysOf(await publicProfile(db, row, { viewerId: 'other' })))
      .toEqual([...BASELINE_KEYS].sort());
    expect(keysOf(await publicProfile(db, row, { viewerId: 'other', isFriend: true })))
      .toEqual([...BASELINE_KEYS, ...SENSITIVE_KEYS, ...DISTINGUISHED_KEYS].sort());
  });

  /**
   * Contact detail is a strictly narrower gate than "sensitive fields". Setting
   * a profile public shows a school to other members; it never publishes an
   * email address, which is not something anybody choosing that setting agreed
   * to.
   */
  it('adds contact detail only for staff holding user.contact.read', async () => {
    const row = db.prepare('SELECT * FROM users').get();
    const stranger = await publicProfile(db, row, { viewerId: 'other' });
    for (const k of CONTACT_KEYS) expect(stranger).not.toHaveProperty(k);

    const staff = await publicProfile(db, row, { viewerId: 'admin', canSeeContact: true });
    expect(keysOf(staff)).toEqual([...BASELINE_KEYS, ...SENSITIVE_KEYS, ...CONTACT_KEYS, ...DISTINGUISHED_KEYS].sort());
  });

  /**
   * The subject gets two things nobody else does: their own privacy switch, and
   * their external log total. The second is the v1.3.1 change — external hours
   * are self-reported and unverifiable, so an unverified figure beside a
   * credited one is not something to publish to a reader.
   */
  it('gives the subject their own switches and their external total', async () => {
    const p = await publicProfile(db, db.prepare('SELECT * FROM users').get(), { viewerId: 'u1' });
    expect(keysOf(p)).toEqual([
      ...BASELINE_KEYS, ...SENSITIVE_KEYS, ...CONTACT_KEYS, ...DISTINGUISHED_KEYS,
      'friendActivityVisible', 'externalService',
    ].sort());
    expect(p.isSelf).toBe(true);
  });

  it('withholds the external total from every other reader, staff included', async () => {
    const row = db.prepare('SELECT * FROM users').get();
    expect(await publicProfile(db, row, { viewerId: 'other' })).not.toHaveProperty('externalService');
    expect(await publicProfile(db, row, { viewerId: 'a', canSeeContact: true })).not.toHaveProperty('externalService');
    expect(await publicProfile(db, row, { viewerId: 'f', isFriend: true })).not.toHaveProperty('externalService');
  });
});

describe('what may never appear, at any visibility', () => {
  const AUDIENCES = [
    ['a stranger', { viewerId: 'other' }],
    ['a friend', { viewerId: 'other', isFriend: true }],
    ['staff', { viewerId: 'admin', canSeeContact: true }],
    ['the subject', { viewerId: 'u1' }],
  ];

  it.each(AUDIENCES)('never leaks a secret value to %s', async (_label, opts) => {
    const serialized = JSON.stringify(await publicProfile(db, db.prepare('SELECT * FROM users').get(), opts));
    for (const value of FORBIDDEN_VALUES) {
      expect(serialized, `${value} reached the payload`).not.toContain(value);
    }
  });

  it.each(AUDIENCES)('never names a forbidden column to %s', async (_label, opts) => {
    const keys = keysOf(await publicProfile(db, db.prepare('SELECT * FROM users').get(), opts));
    for (const k of ['passwordHash', 'password_hash', 'tfaSecret', 'tfa_secret',
      'dateOfBirth', 'date_of_birth', 'phone', 'address', 'suspensionReason',
      'tokenVersion', 'accountStatus', 'completed']) {
      expect(keys, `${k} is on the payload`).not.toContain(k);
    }
  });

  /**
   * The itemised service history is the pre-v1.3 leak this whole file exists
   * around: every past event's title, LOCATION and exact start and end times,
   * for a minor, to any authenticated caller. Counts replaced it; the itemised
   * form lives behind its own endpoint and its own gate.
   */
  it('never carries the itemised history, only counts', async () => {
    const p = await publicProfile(db, db.prepare('SELECT * FROM users').get(), { viewerId: 'u1' });
    expect(p).not.toHaveProperty('completed');
    expect(keysOf(p.stats)).toEqual(
      ['eventsAttended', 'eventsAwaitingRecord', 'eventsSignedUp', 'hours'],
    );
    /* And no rate. "1 of 2 — 50%" reads as a verdict on a person when the
       evidence behind it is one missed shift. */
    expect(JSON.stringify(p.stats)).not.toContain('Rate');
  });
});

describe('the search summary is a strict subset of the profile', () => {
  it('emits only fields the full profile also emits', async () => {
    const row = db.prepare('SELECT * FROM users').get();
    const summary = profileSummary(row);
    const full = await publicProfile(db, row, { viewerId: 'other' });
    /* `kind` is the one addition, and it describes the ROW's type rather than
       the person — search returns users and organizations in one list. */
    for (const k of Object.keys(summary)) {
      if (k === 'kind') continue;
      expect(full, `search emits ${k}, which the profile does not`).toHaveProperty(k);
    }
  });

  it('leaks no secret value either', () => {
    const serialized = JSON.stringify(profileSummary(db.prepare('SELECT * FROM users').get()));
    for (const value of FORBIDDEN_VALUES) expect(serialized).not.toContain(value);
  });
});

describe('the distinguished presentation is derived from role and nothing else', () => {
  it('names the owner and the partner, and nobody else', () => {
    expect(distinctionFor('super_admin')).toMatchObject({ kind: 'owner' });
    expect(distinctionFor('partner')).toMatchObject({ kind: 'partner' });
    for (const role of ['student', 'organizer', 'admin']) {
      expect(distinctionFor(role), `${role} was given a distinction`).toBeNull();
    }
  });

  /**
   * The rule the product asked for in as many words: no username may decide
   * this. The owner account belongs to a real person who is also a student, and
   * a check on their name would be uninheritable by the next owner, invisible to
   * authz.js, and wrong the day the account changes hands.
   */
  it('ignores the name and the username entirely', async () => {
    db.prepare(`UPDATE users SET username = 'Mahit', name = 'Mahit P.'`).run();
    const asStudent = await publicProfile(db, db.prepare('SELECT * FROM users').get(), { viewerId: 'x' });
    expect(asStudent.distinction).toBeNull();

    db.prepare(`UPDATE users SET role = 'super_admin'`).run();
    const asOwner = await publicProfile(db, db.prepare('SELECT * FROM users').get(), { viewerId: 'x' });
    expect(asOwner.distinction).toMatchObject({ kind: 'owner' });

    /* And the same account keeps its member content — the distinction is
       additive, which is what makes an owner who is also a student work. */
    expect(asOwner.skills).toEqual(['First aid']);
    expect(asOwner.stats).toBeTruthy();
  });

  it('parses highlights defensively rather than throwing', async () => {
    for (const bad of ['not json', '{"a":1}', '[1,2,3]', '']) {
      db.prepare('UPDATE users SET profile_highlights = ?').run(bad);
      const p = await publicProfile(db, db.prepare('SELECT * FROM users').get(), { viewerId: 'x' });
      expect(Array.isArray(p.highlights)).toBe(true);
    }
  });
});
