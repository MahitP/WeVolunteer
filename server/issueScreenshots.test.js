import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { startTestServer } from './testServer.js';

/**
 * Screenshots on a problem report (FX-75), and who may see them.
 *
 * The owner asked for a "serious report an issue page" that can "include
 * screenshots". A screenshot of somebody's screen is likely to hold their own
 * personal data and other people's, so:
 *
 *   • only the person who filed the report may attach to it, and only while it
 *     is fresh — fifteen minutes, three images;
 *   • every image is decoded and re-encoded, which drops its metadata (a phone
 *     photo's EXIF carries where it was taken) and refuses anything that is not
 *     really an image;
 *   • images are kept in the database, never under /uploads, which nginx serves
 *     to anybody;
 *   • only staff who may read reports (`report.resolve`) can open one.
 */

const STUDENT = 'leo.chen@example.com';
const OTHER = 'priya.patel@example.com';
const ADMIN = 'admin@example.gov';

async function png(width = 40, height = 30) {
  return sharp({ create: { width, height, channels: 3, background: '#0f5a3a' } }).png().toBuffer();
}

describe('screenshots on a problem report', () => {
  let srv;
  let db;
  let student;
  let other;
  let admin;

  const file = async (session) => {
    const res = await srv.call('POST', '/api/issues', {
      category: 'bug', description: 'The calendar does not load past October on my phone.',
    }, session);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.reference;
  };

  const attach = async (reference, session, bytes, name = 'shot.png', type = 'image/png') => {
    const form = new FormData();
    form.append('screenshot', new Blob([bytes], { type }), name);
    const res = await fetch(`${srv.base}/api/issues/${reference}/screenshots`, {
      method: 'POST', body: form, headers: { Cookie: `wev_session=${session}` },
    });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  };

  const view = (issueId, n, session) => fetch(`${srv.base}/api/issues/${issueId}/screenshots/${n}`, {
    headers: session ? { Cookie: `wev_session=${session}` } : {},
  });

  const listed = async (reference) => {
    const res = await srv.call('GET', '/api/issues', undefined, admin);
    expect(res.status).toBe(200);
    return res.body.issues.find(i => i.reference === reference);
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    student = await srv.login(STUDENT);
    other = await srv.login(OTHER);
    admin = await srv.login(ADMIN);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('lets the reporter attach one, and shows staff that it is there', async () => {
    const reference = await file(student);
    const res = await attach(reference, student, await png());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await listed(reference)).screenshots).toBe(1);
  });

  it('re-encodes it, which drops where a photo was taken', async () => {
    const reference = await file(student);
    const withExif = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#ffffff' } })
      .jpeg().withMetadata({ exif: { IFD0: { Copyright: 'secret-location' } } }).toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();

    expect((await attach(reference, student, withExif, 'photo.jpg', 'image/jpeg')).status).toBe(201);
    const issue = await listed(reference);
    const res = await view(issue.id, 1, admin);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    const stored = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
  });

  it('refuses anybody but the reporter, and says no more than "not found"', async () => {
    const reference = await file(student);
    expect((await attach(reference, other, await png())).status).toBe(404);
    expect((await attach('IR-NOPE-NOPE', student, await png())).status).toBe(404);
  });

  it('takes three at most', async () => {
    const reference = await file(student);
    for (let i = 0; i < 3; i++) expect((await attach(reference, student, await png())).status).toBe(201);
    expect((await attach(reference, student, await png())).status).toBe(409);
  });

  it('takes them only while the report is fresh', async () => {
    const reference = await file(student);
    await db.prepare('UPDATE issue_reports SET created_at = ? WHERE reference = ?')
      .run(new Date(Date.now() - 16 * 60 * 1000).toISOString(), reference);
    expect((await attach(reference, student, await png())).status).toBe(409);
  });

  it('refuses something that is not an image, whatever it claims to be', async () => {
    const reference = await file(student);
    const res = await attach(reference, student, Buffer.from('<script>alert(1)</script>'), 'shot.png', 'image/png');
    expect(res.status).toBe(400);
  });

  it('shows a screenshot to staff who read reports, and to nobody else', async () => {
    const reference = await file(student);
    await attach(reference, student, await png());
    const issue = await listed(reference);

    expect((await view(issue.id, 1)).status).toBe(401);
    expect((await view(issue.id, 1, student)).status).toBe(403);
    expect((await view(issue.id, 1, other)).status).toBe(403);
    expect((await view(issue.id, 1, admin)).status).toBe(200);
    expect((await view(issue.id, 9, admin)).status).toBe(404);
  });
});
