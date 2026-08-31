import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { startTestServer } from './testServer.js';

/**
 * What ends up on disk when somebody uploads a photograph.
 *
 * ── The two things this pins ──
 *
 * **A stored avatar is small, and that is enforced on the server.** The owner's
 * requirement is under 5 KB. That cannot be a check on the UPLOAD: a 5 KB source
 * image is a thumbnail, so rejecting anything larger would refuse every photo a
 * phone takes and the feature would be unusable. It is a property of the
 * re-encoded OUTPUT, which is the only file this application is responsible for.
 *
 * **The format is an allowlist.** `metadata()` was checked for a truthy
 * `format` and nothing else, so anything libvips was compiled with was accepted
 * — TIFF, AVIF, HEIF, JP2, and SVG. The 400 message named "JPEG, PNG, WebP or
 * GIF" while the code enforced none of it, which is the worst combination: a
 * reader of the error believes there is a restriction.
 *
 * SVG is the one that matters. No SVG is ever stored — the output is
 * unconditionally WebP, so the classic stored-SVG XSS was never reachable — but
 * accepting it meant handing untrusted MARKUP to librsvg inside the server
 * process on an unauthenticated-adjacent path. That is a parser exposure with no
 * upside, since nobody sets a vector as their avatar.
 *
 * ── Why the dimensions came down ──
 *
 * The pipeline stored 400×400. `.avatar` is **30px**, `.avatar.lg` is 52px, and
 * `ProfileMenu` is the only component that renders `profile_picture_url` at all.
 * So the stored image was roughly seven times the largest size anything displays
 * it at, and about four times what a 2× display needs. Coming down to 192 leaves
 * headroom for a 96px surface at 2× and makes the 5 KB target reachable without
 * visible loss at the sizes actually in use.
 */

let srv;
let token;
let UPLOADS_ROOT;
let AVATAR_MAX_STORED_BYTES;
let AVATAR_EDGE;

/**
 * The route module is imported INSIDE beforeAll, not at the top.
 *
 * It reaches `db.js`, which opens its database at module scope, and
 * `startTestServer()` refuses to run against a connection that is not the
 * throwaway one. Same reason and same shape as
 * `profilePicture.security.test.js`.
 */
beforeAll(async () => {
  srv = await startTestServer();
  token = await srv.login('leo.chen@example.com');
  ({ UPLOADS_ROOT, AVATAR_MAX_STORED_BYTES, AVATAR_EDGE } =
    await import('./routes/profilePictureRoutes.js'));
});
afterAll(async () => { await srv.close(); });

/** A photographic-ish PNG: noise, so it does not compress to nothing. */
async function noisyPng(width, height) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) % 256;
  return sharp(px, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/* Raw fetch rather than srv.call, matching profilePicture.security.test.js:
   the helper serialises JSON and multipart has to go through untouched. */
async function upload(buffer, filename = 'avatar.png', contentType = 'image/png') {
  const form = new FormData();
  form.append('avatar', new File([buffer], filename, { type: contentType }), filename);
  const res = await fetch(`${srv.base}/api/users/me/profile-picture`, {
    method: 'POST',
    headers: { Cookie: `wev_session=${token}` },
    body: form,
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body };
}

/** The route answers `{ success, user }`; the stored URL is on the user. */
const storedUrl = (res) => res.body?.user?.profile_picture_url;

/** Absolute path for a stored `/uploads/...` URL. */
const onDiskPath = (url) => path.join(UPLOADS_ROOT, url.replace('/uploads/', ''));

describe('the stored avatar is under the size the owner asked for', () => {
  it('exposes the limit and the edge as named constants', () => {
    expect(AVATAR_MAX_STORED_BYTES).toBe(5 * 1024);
    expect(AVATAR_EDGE).toBeLessThanOrEqual(256);
  });

  it('stores a large photograph under 5 KB', async () => {
    /* 1200×1200 of incompressible noise — far worse than a real portrait, which
       has flat regions a codec exploits. If the ladder holds here it holds. */
    const res = await upload(await noisyPng(1200, 1200));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const url = storedUrl(res);
    expect(url, JSON.stringify(res.body)).toBeTruthy();

    const { size } = fs.statSync(onDiskPath(url));
    expect(
      size,
      `stored avatar is ${size} bytes, over the ${AVATAR_MAX_STORED_BYTES}-byte limit`
    ).toBeLessThanOrEqual(AVATAR_MAX_STORED_BYTES);
  });

  it('stores it as a square WebP at the reduced edge', async () => {
    const res = await upload(await noisyPng(900, 600));
    expect(res.status).toBe(200);

    const meta = await sharp(onDiskPath(storedUrl(res))).metadata();

    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(AVATAR_EDGE);
    expect(meta.height).toBe(AVATAR_EDGE);
  });

  it('keeps a tiny upload tiny rather than inflating it', async () => {
    /* The ladder must not re-encode upward. A 64×64 source has no business
       becoming larger than the ceiling on its way through. */
    const res = await upload(await noisyPng(64, 64));
    expect(res.status).toBe(200);

    expect(fs.statSync(onDiskPath(storedUrl(res))).size).toBeLessThanOrEqual(AVATAR_MAX_STORED_BYTES);
  });
});

describe('the accepted formats are an allowlist', () => {
  it('refuses SVG, so librsvg never parses untrusted markup', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">'
      + '<rect width="400" height="400" fill="red"/></svg>'
    );
    const res = await upload(svg, 'avatar.svg', 'image/svg+xml');

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('unsupported_media_type');
  });

  it('refuses TIFF, which libvips reads but nobody needs as an avatar', async () => {
    const tiff = await sharp(await noisyPng(64, 64)).tiff().toBuffer();
    const res = await upload(tiff, 'avatar.tiff', 'image/tiff');
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it('names in the error exactly the formats it accepts', async () => {
    const res = await upload(Buffer.from('not an image at all'), 'x.png');
    expect(res.status).toBe(400);
    /* The old message promised a restriction the code did not apply. If the
       allowlist and the sentence drift apart again, this fails. */
    for (const named of ['JPEG', 'PNG', 'WebP', 'GIF']) {
      expect(res.body.error).toContain(named);
    }
  });

  it('still accepts each format it names', async () => {
    const png = await noisyPng(300, 300);
    for (const [make, label] of [
      [(b) => sharp(b).jpeg().toBuffer(), 'jpeg'],
      [(b) => sharp(b).png().toBuffer(), 'png'],
      [(b) => sharp(b).webp().toBuffer(), 'webp'],
      [(b) => sharp(b).gif().toBuffer(), 'gif'],
    ]) {
      const res = await upload(await make(png), `avatar.${label}`);
      expect(res.status, `${label} was refused: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });
});
