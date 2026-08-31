import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { startTestServer } from './testServer.js';

/**
 * The URL a successful upload hands back has to actually resolve to the bytes.
 *
 * `sharp`, `node:fs` and `node:url` are safe to import statically — none reaches
 * db.js, so none can bind the database connection before startTestServer() sets
 * WEV_DB_PATH (see the header in testServer.js). Everything that DOES reach
 * db.js is imported inside beforeAll.
 *
 * ── The incident ──
 *
 * "I can edit my avatar successfully, but it never appears in the sidebar."
 *
 * Every hop of the pipeline was individually correct. The image decoded, sharp
 * re-encoded it, the file was written, the column was set, `/api/auth/me`
 * returned the URL, and `setCurrentUser` put it in session state on the same
 * frame. The value was lost at the last hop — nothing served the file — and it
 * was lost because THREE places each derived the uploads directory from
 * `process.cwd()`, which is a different directory in each of the three
 * situations that matter:
 *
 *   - `npm run dev` / `npm start` run the API as an npm workspace script, so its
 *     cwd is `server/` and uploads were written to `server/public/uploads/`.
 *   - `vitest` runs from the repository root, so THIS suite wrote and read
 *     `public/uploads/` — the two agreed here, which is exactly why the existing
 *     security tests passed against a product that did not work.
 *   - Vite's dev server serves its publicDir, `<root>/public`, so the browser
 *     asked :5173 for a file that had been written under `server/`.
 *
 * And Vite answers a miss with the SPA shell — 200, `content-type: text/html` —
 * so the `<img>` received HTML, failed to decode, and reported nothing. Measured
 * on Vite 8 while writing this file, which is why the client carries an onError
 * fallback: a broken avatar cannot be relied upon to arrive as a 404.
 *
 * On top of that the API server mounted `/uploads` inside `if (IS_PRODUCTION)`,
 * so in development the one process that knew where the file was refused to
 * serve it, and in tests nothing served it at all.
 *
 * The fix is a single exported constant, anchored to this repository rather than
 * to whatever directory the process happens to have started in, used by both the
 * writer and the static mount. The guards at the bottom of this file are what
 * keep it that way.
 */

let srv;
let db;
let UPLOADS_ROOT;

/**
 * The repository root, derived from THIS FILE's location — deliberately not from
 * `process.cwd()`, because a cwd-derived expectation is the bug and would agree
 * with it.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_UPLOADS_ROOT = path.join(REPO_ROOT, 'public', 'uploads');

const scratchFiles = [];

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ UPLOADS_ROOT } = await import('./routes/profilePictureRoutes.js'));
});

afterAll(async () => {
  for (const f of scratchFiles) {
    try { fs.unlinkSync(f); } catch { /* already gone is the expected case */ }
  }
  await srv.close();
});

const PASSWORD = 'ServedPass123!';

async function realPng() {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 40, g: 120, b: 60 } } })
    .png().toBuffer();
}

async function uploadAvatar(token) {
  const bytes = await realPng();
  const form = new FormData();
  form.append('avatar', new File([bytes], 'me.png', { type: 'image/png' }), 'me.png');
  const res = await fetch(`${srv.base}/api/users/me/profile-picture`, {
    method: 'POST',
    headers: { Cookie: `wev_session=${token}` },
    body: form
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function freshStudent(email) {
  const { cookie, user } = await srv.signupConfirmed({
    email,
    password: PASSWORD,
    name: 'Served Tester',
    username: email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_'),
    role: 'student',
    grade: '11'
  });
  return { token: cookie, user };
}

describe('the URL an upload returns is served', () => {
  let url;
  let token;

  beforeAll(async () => {
    ({ token } = await freshStudent('pic-served@example.org'));
    const res = await uploadAvatar(token);
    expect(res.status).toBe(200);
    url = res.body.user.profile_picture_url;
    scratchFiles.push(path.join(REPO_ROOT, 'public', url));
  });

  /**
   * The headers on a user-uploaded file, asserted rather than assumed.
   *
   * ── Why these were worth pinning ──
   *
   * `/uploads` is the one statically-served directory whose contents a user
   * chose. Four independent things keep a stored file from ever being
   * interpreted as markup: the bytes must decode as an image, the format must be
   * on an allowlist, the output is re-encoded to WebP, and the filename — and so
   * the extension and the served Content-Type — is generated server-side.
   *
   * `nosniff` is the fifth, and it was the only one of the five that nothing
   * asserted and nothing set explicitly. It arrives as a helmet default: the
   * options object in `app.js` configures `contentSecurityPolicy` and
   * `crossOriginResourcePolicy` and never mentions `noSniff`, so the protection
   * is one dependency-default change away from disappearing with no test going
   * red. A grep for `nosniff` across `server/` and `src/` found nothing at all.
   *
   * ── What is deliberately NOT asserted ──
   *
   * `Content-Disposition: attachment` is the textbook hardening for served user
   * content and it is wrong here: it tells the browser to download the file
   * rather than render it, which breaks every `<img>` on the site. The stronger
   * measures — a separate cookieless origin, or a restrictive CSP on the image
   * response — are infrastructure and product decisions rather than something a
   * test should assert into existence.
   *
   * `Cross-Origin-Resource-Policy` IS asserted, at the value `app.js` sets
   * deliberately (`cross-origin`, loosened from helmet's `same-origin` default).
   * It is pinned not because it is the right value but because it is a
   * deliberate weakening with no comment and no test, and a reader deserves to
   * find it stated somewhere.
   */
  it('serves an uploaded file with nosniff, so the extension is the last word', async () => {
    const res = await fetch(`${srv.base}${url}`);

    expect(
      res.headers.get('x-content-type-options'),
      'nosniff is absent, so a browser may content-sniff a user-supplied file and '
      + 'disagree with the Content-Type this server chose'
    ).toBe('nosniff');
  });

  it('serves it as webp, the type the server chose rather than one a caller named', async () => {
    const res = await fetch(`${srv.base}${url}`);
    /* The filename is `{userId}-{timestamp}.webp`, generated server-side, so the
       extension express.static maps to a type is never attacker-influenced. */
    expect(res.headers.get('content-type')).toMatch(/^image\/webp/);
    expect(url).toMatch(/\.webp$/);
  });

  it('records the Cross-Origin-Resource-Policy this deployment actually sends', async () => {
    const res = await fetch(`${srv.base}${url}`);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('answers the stored URL with the image, not with a 404 and not with the SPA shell', async () => {
    const res = await fetch(`${srv.base}${url}`);

    expect(res.status).toBe(200);
    // The specific failure this is written against: a miss that answers 200
    // text/html is indistinguishable from success to everything except an image
    // decoder, so assert the type as well as the status.
    expect(res.headers.get('content-type')).toMatch(/^image\//);
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0);
  });

  /**
   * `/api/auth/me` is what the client re-reads the session from, so the column
   * has to survive that hop too — it is the only route that can put the picture
   * back on screen after a reload.
   */
  it('is carried by /api/auth/me', async () => {
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
    expect(me.body.profile_picture_url).toBe(url);
  });

  it('is a URL the browser can resolve from the page it was delivered to', () => {
    // Root-relative. An absolute URL naming a host would be wrong in every
    // deployment but the one it was written for, and a bare filename would
    // resolve against whatever route the user happens to be on.
    expect(url.startsWith('/')).toBe(true);
    expect(url).toMatch(/^\/uploads\/avatars\//);
  });
});

describe('what /uploads must not do', () => {
  it('answers 404 for a file that is not there, rather than 200 with HTML', async () => {
    const res = await fetch(`${srv.base}/uploads/avatars/never-uploaded.webp`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') || '').not.toMatch(/text\/html/);
  });

  it('does not list the directory', async () => {
    const res = await fetch(`${srv.base}/uploads/avatars/`);
    expect(res.status).toBe(404);
  });

  /**
   * `..` in a path is normalised by fetch before it leaves the client, so the
   * only traversal that reaches the server is a percent-encoded one. Nothing
   * outside uploads/ may come back — least of all the repository's own files.
   */
  it('refuses an encoded traversal out of the uploads directory', async () => {
    for (const attempt of [
      '/uploads/%2e%2e%2f%2e%2e%2fpackage.json',
      '/uploads/avatars/%2e%2e%2f%2e%2e%2f%2e%2e%2fserver%2fdb.js',
      '/uploads/..%2f..%2fpackage.json'
    ]) {
      const res = await fetch(`${srv.base}${attempt}`);
      expect(res.status, `${attempt} must not be served`).not.toBe(200);
    }
  });

  it('does not serve dotfiles', async () => {
    const dotfile = path.join(EXPECTED_UPLOADS_ROOT, '.probe-secret');
    fs.mkdirSync(EXPECTED_UPLOADS_ROOT, { recursive: true });
    fs.writeFileSync(dotfile, 'must not be readable over http');
    scratchFiles.push(dotfile);

    const res = await fetch(`${srv.base}/uploads/.probe-secret`);
    expect(res.status).not.toBe(200);
  });
});

/**
 * ── The guards ──
 *
 * The behavioural tests above cannot catch the defect on their own: under vitest
 * `process.cwd()` IS the repository root, so a cwd-derived uploads directory
 * agrees with the correct one here and disagrees only where nobody is looking.
 * These two assertions are what actually pin it down.
 */
describe('the uploads directory does not depend on the working directory', () => {
  it('is anchored to the repository, not to process.cwd()', () => {
    expect(UPLOADS_ROOT).toBe(EXPECTED_UPLOADS_ROOT);
  });

  it('is derived from the module\'s own location in the source', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'server', 'routes', 'profilePictureRoutes.js'), 'utf8'
    );
    // Comments stripped first: the header of that module explains the defect by
    // quoting the expression it replaced, and a guard that its own explanation
    // trips is a guard somebody deletes.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(
      code.includes('process.cwd()'),
      'profilePictureRoutes.js must not resolve the uploads directory from '
      + 'process.cwd(). The API runs as an npm workspace script, so its cwd is '
      + 'server/, while vitest and Vite both use the repository root — which is '
      + 'how uploads came to be written where nothing served them.'
    ).toBe(false);
  });

  it('is the same directory app.js serves, from the same constant', () => {
    const appSource = fs.readFileSync(path.join(REPO_ROOT, 'server', 'app.js'), 'utf8');
    expect(
      /UPLOADS_ROOT/.test(appSource),
      'app.js must serve the exported UPLOADS_ROOT rather than re-deriving the '
      + 'path, so the directory written to and the directory served cannot drift.'
    ).toBe(true);
  });

  it('serves uploads in development too, not only in production', () => {
    // This suite is not production and the static mount answered above, which is
    // the assertion. Stated explicitly because the mount USED to sit inside
    // `if (IS_PRODUCTION)`: development was the only environment where the
    // feature was ever used by hand, and the only one where it did not work.
    const appSource = fs.readFileSync(path.join(REPO_ROOT, 'server', 'app.js'), 'utf8');
    const productionBlock = appSource.slice(appSource.indexOf('if (IS_PRODUCTION) {'));
    expect(productionBlock.includes("app.use('/uploads'")).toBe(false);
  });
});

describe('the row and the file stay in step', () => {
  it('writes the file inside UPLOADS_ROOT and nowhere else', async () => {
    const { token } = await freshStudent('pic-inside-root@example.org');
    const res = await uploadAvatar(token);
    const url = res.body.user.profile_picture_url;

    const onDisk = path.resolve(REPO_ROOT, 'public', `.${path.sep}${url}`);
    scratchFiles.push(onDisk);

    expect(onDisk.startsWith(UPLOADS_ROOT + path.sep)).toBe(true);
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  it('stops serving the picture once it is deleted', async () => {
    const { token } = await freshStudent('pic-unserved@example.org');
    const url = (await uploadAvatar(token)).body.user.profile_picture_url;
    scratchFiles.push(path.join(REPO_ROOT, 'public', url));

    expect((await fetch(`${srv.base}${url}`)).status).toBe(200);

    const del = await srv.call('DELETE', '/api/users/me/profile-picture', undefined, token);
    expect(del.status).toBe(200);

    // Both halves: the pointer and the bytes. A file left behind stays readable,
    // unauthenticated, at a URL that has already been handed out.
    expect((await fetch(`${srv.base}${url}`)).status).toBe(404);
    const row = await db.prepare('SELECT profile_picture_url FROM users WHERE email = ?')
      .get('pic-unserved@example.org');
    expect(row.profile_picture_url).toBeNull();
  });
});
