import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { startTestServer } from './testServer.js';

/**
 * The photograph on disk.
 *
 * `sharp` and `node:fs` are safe to import statically here — neither reaches
 * db.js, so neither can bind the database connection before startTestServer()
 * sets WEV_DB_PATH (see the header in testServer.js). Everything that DOES
 * reach db.js — the routes module whose helper is exercised below, and `db`
 * itself — is imported inside beforeAll.
 *
 * ── The four defects covered here ──
 *
 * 1. A rejected upload answered 500. multer's LIMIT_FILE_SIZE and the
 *    fileFilter refusal were never caught, so a 6 MB photo or a PDF reached the
 *    global error handler: the caller was told the server had failed (nothing
 *    in that sentence suggests "send a smaller picture"), it was logged as an
 *    unhandled error, and it was filed in the error dashboard as a defect in
 *    this application. app.js already learned this lesson for
 *    `entity.too.large`; these are the same mistake one layer up.
 * 2. Replacing a picture never deleted the previous file. Every re-upload left
 *    the old photograph on disk and publicly readable at a URL that had already
 *    been handed out, forever.
 * 3. Account deletion nulled `avatar`, `bio` and `school` but not
 *    `profile_picture_url`, and unlinked nothing — so a deleted student's
 *    photograph stayed served at its old URL. The data deletion policy promises
 *    in plain words that the profile picture is permanently deleted.
 * 4. The delete handler resolved `public/ + profile_picture_url` and
 *    unlinkSync'd it, guarded only by `startsWith('/uploads/')` — which
 *    `/uploads/../../anything` satisfies. Not reachable today, because one
 *    statement writes that column and it writes a generated name; an unguarded
 *    arbitrary-delete primitive one bug away from reachable is still worth
 *    closing.
 */

let srv;
let db;
let deleteUploadedFile;

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads', 'avatars');

/** Everything this file writes outside the routes under test, cleaned up after. */
const scratchFiles = [];

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ deleteUploadedFile } = await import('./routes/profilePictureRoutes.js'));
});

afterAll(async () => {
  for (const f of scratchFiles) {
    try { fs.unlinkSync(f); } catch { /* already gone is the expected case */ }
  }
  await srv.close();
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Satisfies the signup policy (upper, lower, digit, symbol) and re-used for step-up. */
const PASSWORD = 'PicturePass123!';

/** A real, decodable image — small, so the suite does not spend time on pixels. */
async function realPng() {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 12, g: 90, b: 200 } } })
    .png().toBuffer();
}

async function postAvatar(token, bytes, filename, type) {
  const form = new FormData();
  form.append('avatar', new File([bytes], filename, { type }), filename);
  const res = await fetch(`${srv.base}/api/users/me/profile-picture`, {
    method: 'POST',
    headers: { Cookie: `wev_session=${token}` },
    body: form
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body };
}

/** The absolute path a stored `/uploads/...` URL points at. */
const onDisk = (relativeUrl) => path.join(PUBLIC_DIR, relativeUrl);

async function freshStudent(email) {
  const { cookie, user } = await srv.signupConfirmed({
    email,
    password: PASSWORD,
    name: 'Picture Tester',
    // Usernames accept letters, numbers and underscores only.
    username: email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_'),
    role: 'student',
    grade: '11'
  });
  return { token: cookie, user };
}

describe('an upload this application refuses is the caller\'s mistake, not a server fault', () => {
  let token;
  beforeAll(async () => { ({ token } = await freshStudent('pic-refusals@example.org')); });

  it('answers 413 for a file over the 5 MB limit, not 500', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM error_events').get().c;

    const oversize = Buffer.alloc(6 * 1024 * 1024, 0x41);
    const res = await postAvatar(token, oversize, 'huge.png', 'image/png');

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('payload_too_large');
    // The message has to tell the caller what to do differently.
    expect(res.body.error).toMatch(/5\s?MB/i);

    // And it must not land in the triage dashboard: a dashboard full of user
    // mistakes buries the real defects, which is exactly why app.js returns
    // before recordError on its own 413 branch.
    const after = db.prepare('SELECT COUNT(*) AS c FROM error_events').get().c;
    expect(after).toBe(before);
  });

  it('answers 400 for a file that is not an image, not 500', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM error_events').get().c;

    const res = await postAvatar(token, Buffer.from('%PDF-1.7\n'), 'resume.pdf', 'application/pdf');

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(res.body.error).toMatch(/image/i);

    const after = db.prepare('SELECT COUNT(*) AS c FROM error_events').get().c;
    expect(after).toBe(before);
  });

  it('answers 400 when the declared mimetype is a lie the bytes do not support', async () => {
    // `file.mimetype` is whatever the client typed into the multipart headers.
    // The bytes are the only thing that can be trusted, and a refusal to decode
    // them is still the caller's mistake.
    const res = await postAvatar(token, Buffer.from('this is not a PNG'), 'liar.png', 'image/png');

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it('leaves no file behind for any refused upload', async () => {
    const row = db.prepare('SELECT profile_picture_url FROM users WHERE email = ?')
      .get('pic-refusals@example.org');
    expect(row.profile_picture_url).toBeFalsy();
  });
});

describe('replacing a profile picture', () => {
  it('deletes the file it replaced', async () => {
    const { token } = await freshStudent('pic-replace@example.org');
    const png = await realPng();

    const first = await postAvatar(token, png, 'one.png', 'image/png');
    expect(first.status).toBe(200);
    const firstUrl = first.body.user.profile_picture_url;
    expect(firstUrl).toMatch(/^\/uploads\/avatars\//);
    scratchFiles.push(onDisk(firstUrl));
    expect(fs.existsSync(onDisk(firstUrl))).toBe(true);

    // The generated name carries Date.now(), so two uploads inside one
    // millisecond would produce the same path and the same URL.
    await sleep(15);

    const second = await postAvatar(token, png, 'two.png', 'image/png');
    expect(second.status).toBe(200);
    const secondUrl = second.body.user.profile_picture_url;
    scratchFiles.push(onDisk(secondUrl));
    expect(secondUrl).not.toBe(firstUrl);

    expect(fs.existsSync(onDisk(secondUrl))).toBe(true);
    expect(fs.existsSync(onDisk(firstUrl))).toBe(false);
  });
});

describe('deleting a profile picture', () => {
  it('removes the file and clears the column', async () => {
    const { token } = await freshStudent('pic-delete@example.org');
    const uploaded = await postAvatar(token, await realPng(), 'a.png', 'image/png');
    const url = uploaded.body.user.profile_picture_url;
    scratchFiles.push(onDisk(url));

    const res = await srv.call('DELETE', '/api/users/me/profile-picture', undefined, token);
    expect(res.status).toBe(200);
    expect(fs.existsSync(onDisk(url))).toBe(false);

    const row = db.prepare('SELECT profile_picture_url FROM users WHERE email = ?')
      .get('pic-delete@example.org');
    expect(row.profile_picture_url).toBeNull();
  });

  it('will not follow a stored path out of the uploads directory', async () => {
    const { token, user } = await freshStudent('pic-traversal@example.org');

    // A sentinel standing in for anything the server process can write —
    // public/theme.js, a build artefact, a database file. It lives inside
    // public/ but OUTSIDE uploads/, which is precisely what
    // `startsWith('/uploads/')` failed to distinguish.
    const sentinel = path.join(PUBLIC_DIR, 'traversal-sentinel.txt');
    fs.writeFileSync(sentinel, 'must survive');
    scratchFiles.push(sentinel);

    db.prepare('UPDATE users SET profile_picture_url = ? WHERE id = ?')
      .run('/uploads/../traversal-sentinel.txt', user.id);

    const res = await srv.call('DELETE', '/api/users/me/profile-picture', undefined, token);

    // The request still succeeds — the column is cleared either way; what must
    // not happen is the unlink.
    expect(res.status).toBe(200);
    expect(fs.existsSync(sentinel)).toBe(true);
    const row = db.prepare('SELECT profile_picture_url FROM users WHERE id = ?').get(user.id);
    expect(row.profile_picture_url).toBeNull();
  });
});

describe('deleteUploadedFile', () => {
  it('refuses any path that resolves outside the uploads directory', () => {
    const sentinel = path.join(PUBLIC_DIR, 'helper-sentinel.txt');
    fs.writeFileSync(sentinel, 'must survive');
    scratchFiles.push(sentinel);

    expect(deleteUploadedFile('/uploads/../helper-sentinel.txt')).toBe(false);
    expect(deleteUploadedFile('/uploads/avatars/../../helper-sentinel.txt')).toBe(false);
    expect(deleteUploadedFile('../helper-sentinel.txt')).toBe(false);
    expect(deleteUploadedFile('/etc/passwd')).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('treats an already-missing file as nothing to do, rather than throwing', () => {
    // Account deletion calls this. A photograph that is already gone must not
    // be able to fail somebody's account deletion.
    expect(() => deleteUploadedFile('/uploads/avatars/never-existed.webp')).not.toThrow();
    expect(deleteUploadedFile('/uploads/avatars/never-existed.webp')).toBe(false);
  });

  it('ignores an empty or non-string value', () => {
    expect(deleteUploadedFile(null)).toBe(false);
    expect(deleteUploadedFile(undefined)).toBe(false);
    expect(deleteUploadedFile('')).toBe(false);
    expect(deleteUploadedFile(42)).toBe(false);
  });

  it('deletes a file that really is under uploads/', () => {
    const victim = path.join(UPLOADS_DIR, 'helper-target.webp');
    fs.writeFileSync(victim, 'x');
    scratchFiles.push(victim);
    expect(deleteUploadedFile('/uploads/avatars/helper-target.webp')).toBe(true);
    expect(fs.existsSync(victim)).toBe(false);
  });
});

describe('account deletion and the photograph', () => {
  it('clears profile_picture_url and removes the file from disk', async () => {
    const { token, user } = await freshStudent('pic-account-delete@example.org');
    const uploaded = await postAvatar(token, await realPng(), 'me.png', 'image/png');
    expect(uploaded.status).toBe(200);
    const url = uploaded.body.user.profile_picture_url;
    scratchFiles.push(onDisk(url));
    expect(fs.existsSync(onDisk(url))).toBe(true);

    const headers = await srv.verified(token, 'account.delete', { password: PASSWORD });
    const res = await srv.call('DELETE', '/api/auth/account', undefined, token, headers);
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT profile_picture_url, account_status FROM users WHERE id = ?')
      .get(user.id);
    expect(row.account_status).toBe('deleted');
    // The policy says the profile picture is permanently deleted. Both halves
    // of that: the pointer, and the file the pointer named — a file left on
    // disk stays served at a URL that was already handed out.
    expect(row.profile_picture_url).toBeNull();
    expect(fs.existsSync(onDisk(url))).toBe(false);
  });
});

/**
 * Denying a pending organizer is the product's one genuine hard delete.
 *
 * ── Why the photograph was being left behind ──
 *
 * `POST /api/admin/organizers/:id/deny` removes the user row outright, because a
 * denied registration never became a member and there is nothing to retain. But
 * a pending organizer CAN sign in and upload a picture — `authenticateToken`
 * gates on `email_verified`, not on `users.verified` — so the row being deleted
 * may own a file.
 *
 * That file is served unauthenticated out of `public/uploads/`. Deleting the row
 * without unlinking it leaves a photograph of a real person retrievable at a URL
 * that has already been handed out, with nothing left in the database pointing
 * at it — so no later cleanup can even find it.
 *
 * This is the same shape as the two findings the step-up audit recorded (the
 * export download; provider disconnect): a gated effect — destroying somebody's
 * photograph — reached by a second route that did not implement it. Account
 * deletion had it right; this path had never been asked the question.
 */
describe('denying a pending organizer and the photograph', () => {
  it('removes the uploaded file from disk along with the row', async () => {
    const { token, user } = await freshStudent('pic-deny-organizer@example.org');

    // Become a pending organizer: the state deny operates on. Written directly
    // because no route produces "organizer, not yet verified, already signed in
    // with a picture" — and it is the state, not the way in, that is under test.
    db.prepare("UPDATE users SET role = 'organizer', verified = 0 WHERE id = ?").run(user.id);

    const uploaded = await postAvatar(token, await realPng(), 'me.png', 'image/png');
    expect(uploaded.status).toBe(200);
    const url = uploaded.body.user.profile_picture_url;
    scratchFiles.push(onDisk(url));
    expect(fs.existsSync(onDisk(url)), 'fixture upload did not land').toBe(true);

    const ownerToken = await srv.loginAsOwner('derek.sorensen@example.com');
    const res = await srv.call('POST', `/api/admin/organizers/${user.id}/deny`, {}, ownerToken);
    expect(res.status).toBe(200);

    // Both halves. The row is gone — that part already worked — and the file it
    // pointed at is gone too, which is the part that did not.
    const row = db.prepare('SELECT id FROM users WHERE id = ?').get(user.id);
    expect(row, 'the row survived the denial').toBeUndefined();
    expect(fs.existsSync(onDisk(url)), 'the photograph outlived the account').toBe(false);
  });
});
