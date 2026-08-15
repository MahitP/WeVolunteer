import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { authenticateToken, formatUserResponse } from '../utils.js';

const router = express.Router();

/**
 * Everything under `public/` is served to the internet, unauthenticated, by the
 * static middleware in app.js. `UPLOADS_ROOT` is the only part of it this
 * application ever writes at runtime, and therefore the only part it is ever
 * allowed to delete from — see `deleteUploadedFile` below.
 *
 * ── Anchored to this repository, NOT to process.cwd() ──
 *
 * These three constants were `path.join(process.cwd(), 'public')`, and so was
 * app.js's static mount. `process.cwd()` is a different directory in each of the
 * three situations that matter:
 *
 *   - `npm run dev` and `npm start` launch the API as an npm workspace script,
 *     so its cwd is `server/`. Uploads were written to `server/public/uploads/`.
 *   - `vitest` runs from the repository root, so the whole security suite wrote
 *     and read `public/uploads/` and agreed with itself perfectly.
 *   - Vite's dev server serves its publicDir — `<root>/public` — so the browser
 *     asked :5173 for a file that had been written a directory away.
 *
 * The result was an avatar that uploaded, re-encoded, wrote, stored its URL and
 * reached session state on the same frame, and then 404'd — while every test
 * passed. Vite answers a miss with the SPA shell (200, `text/html`), so the
 * `<img>` was handed HTML and silently rendered nothing.
 *
 * Resolving from `import.meta.url` makes the directory a property of the
 * checkout instead of a property of however the process was started, so the
 * writer, the static mount, Vite's publicDir and the test suite are all naming
 * the same place. `UPLOADS_ROOT` is exported for app.js so that the directory
 * written to and the directory served cannot drift apart again.
 */
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
export const UPLOADS_ROOT = path.join(PUBLIC_DIR, 'uploads');
const UPLOADS_DIR = path.join(UPLOADS_ROOT, 'avatars');

/**
 * Exported so organization images land in the same directory, are written by
 * the same pipeline, and are deleted by the same `deleteUploadedFile`. A second
 * uploads directory would be a second containment check to get right — and the
 * comment on `deleteUploadedFile` records what happened the last time one was
 * written by hand.
 */
export { UPLOADS_DIR as AVATAR_UPLOADS_DIR };
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/** 5 MB. Named once so the limit and the message it produces cannot drift. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Deletes a file this application previously wrote under `public/uploads/`,
 * addressed by the relative URL stored in `users.profile_picture_url`.
 *
 * ── Why this is a function, and the only way any of this is deleted ──
 *
 * Three call sites need it — replacing a picture, deleting a picture, and
 * deleting an account — and the third lives in another module, which is why
 * this is exported rather than kept local. Three hand-written unlinks would be
 * three chances to write the containment check slightly differently, and the
 * version this replaces got it wrong:
 *
 *     if (url.startsWith('/uploads/')) fs.unlinkSync(path.join(cwd, 'public', url))
 *
 * `/uploads/../../../etc/passwd` satisfies `startsWith('/uploads/')`, and
 * `path.join` collapses the `..` segments happily — so the guard permitted
 * deleting any file the server process could write. Nothing reachable wrote
 * that column except the upload handler below, which generates the name, so it
 * was never exploitable; it was an arbitrary-delete primitive waiting for a
 * second writer (an import, an admin tool, a migration) to make it one.
 *
 * The check is therefore on the RESOLVED path, not on the string that produced
 * it: resolve first, then require the result to sit inside `UPLOADS_ROOT`.
 * That is the only formulation that cannot be talked around by clever spelling.
 *
 * ── Never throws ──
 *
 * Account deletion calls this, and a photograph that is already gone (or a file
 * mode nobody expected) must not be able to fail somebody's account deletion —
 * the row is the record that matters and the policy promise is about the row.
 * ENOENT is the ordinary case and is silent; anything else is logged, because
 * a photograph that could not be removed is an operational problem someone has
 * to see.
 *
 * @returns {boolean} true only if a file was actually unlinked.
 */
export function deleteUploadedFile(relativeUrl) {
  if (typeof relativeUrl !== 'string' || relativeUrl === '') return false;

  // Resolved relative to public/ exactly as the static server would resolve it,
  // so what is checked here is what the URL actually addresses.
  const resolved = path.resolve(PUBLIC_DIR, `.${path.sep}${relativeUrl}`);

  // Containment: inside uploads/, and not uploads/ itself. The trailing
  // separator matters — without it, a sibling directory named `uploads-old`
  // would pass a bare startsWith.
  if (!resolved.startsWith(UPLOADS_ROOT + path.sep)) {
    console.warn('Refusing to delete a stored file path outside the uploads directory:', relativeUrl);
    return false;
  }

  try {
    fs.unlinkSync(resolved);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    console.error('Failed to delete uploaded file:', resolved, err);
    return false;
  }
}

/**
 * The fileFilter refusal, as a type rather than a bare Error.
 *
 * multer wraps whatever the filter passes to `cb` and hands it to the next
 * middleware; `receiveAvatar` needs to tell "the caller sent a PDF" (400) apart
 * from "multer itself failed" and from a genuine server fault, and matching on
 * an error MESSAGE to make that decision is the kind of thing that breaks
 * silently on a dependency upgrade.
 */
class UnsupportedUpload extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedUpload';
  }
}

const upload = multer({
  storage: multer.memoryStorage(), // held in memory so sharp can validate before anything is written
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    /**
     * `file.mimetype` is the CLIENT's claim — a string it wrote into the
     * multipart headers — and nothing here can make it true. This filter is a
     * cheap first pass that rejects the honest mistakes (a PDF, a .docx) before
     * 5 MB is buffered; it is NOT the content check.
     *
     * The content check is `sharp(...).metadata()` in the handler, which either
     * decodes the actual bytes or does not. A file that lies about its type
     * gets past this filter and is refused there — with a 400, because a lie
     * about a mimetype is still the caller's mistake and not a server fault.
     */
    if (typeof file.mimetype === 'string' && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new UnsupportedUpload('Only image files can be used as a profile picture.'));
    }
  }
});

/**
 * Runs multer, and ANSWERS its refusals here instead of forwarding them.
 *
 * ── The defect this exists to fix ──
 *
 * `upload.single('avatar')` was mounted directly. Its two ordinary refusals —
 * a file over the size limit, and a file the filter rejected — are delivered as
 * errors to the next middleware, so both fell all the way through to app.js's
 * final error handler. A student who picked a 6 MB photo from their phone was
 * told "Internal server error" (which suggests nothing they could do
 * differently), the refusal was logged with console.error as an unhandled
 * fault, and it was filed in the error dashboard as a defect in this
 * application.
 *
 * app.js already reasons this out for `entity.too.large`, in the comment above
 * that branch: a body the parser refused "is the CALLER's mistake, not ours",
 * and filing it as a server defect "buries the real 500s among the noise". This
 * is the identical case one layer up, answered the same way and with the same
 * `payload_too_large` code, so a client sees one shape for "too big" whichever
 * limit it hit.
 */
export function receiveAvatar(req, res, next) {
  upload.single('avatar')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `That image is too large. The limit is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`,
        code: 'payload_too_large'
      });
    }

    if (err instanceof UnsupportedUpload) {
      return res.status(400).json({
        error: 'That file is not an image. Choose a JPEG, PNG, WebP or GIF.',
        code: 'unsupported_media_type'
      });
    }

    // Any other MulterError is still something about the REQUEST — too many
    // parts, an unexpected field name, a malformed multipart body.
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: 'That upload could not be read.', code: 'invalid_upload' });
    }

    // Not multer's, not ours: a genuine fault, and the error handler's business.
    return next(err);
  });
}

router.post('/api/users/me/profile-picture', authenticateToken, receiveAvatar, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image provided' });
  }

  /**
   * Decode before anything is written, and answer a bad image as a 400.
   *
   * Deliberately a separate `metadata()` pass rather than letting the resize
   * pipeline below throw: both failures would arrive as the same kind of
   * exception, and telling "these bytes are not an image" (the caller's
   * mistake) apart from "the disk is full" (ours) by inspecting an error
   * message is exactly the fragile thing this is avoiding. Two passes over at
   * most 5 MB held in memory is a cheap way to keep the two answers honest.
   *
   * This is also where the mimetype claim is actually settled — see fileFilter.
   */
  let decoded;
  try {
    decoded = await sharp(req.file.buffer).metadata();
  } catch {
    decoded = null;
  }
  if (!decoded?.format) {
    return res.status(400).json({
      error: 'That file could not be read as an image. Choose a JPEG, PNG, WebP or GIF.',
      code: 'unsupported_media_type'
    });
  }

  try {
    // Read before the write, so the replaced file can be unlinked afterwards.
    const previousUrl = db.prepare('SELECT profile_picture_url FROM users WHERE id = ?')
      .get(req.user.id)?.profile_picture_url;

    const filename = `${req.user.id}-${Date.now()}.webp`;
    const filepath = path.join(UPLOADS_DIR, filename);

    // Process image: resize, crop to square, convert to webp (strips metadata)
    await sharp(req.file.buffer)
      .resize(400, 400, {
        fit: sharp.fit.cover,
        position: sharp.strategy.entropy
      })
      .webp({ quality: 80 })
      .toFile(filepath);

    const relativeUrl = `/uploads/avatars/${filename}`;

    const now = new Date().toISOString();

    // Update user in DB
    db.prepare('UPDATE users SET profile_picture_url = ?, profile_picture_uploaded_at = ? WHERE id = ?')
      .run(relativeUrl, now, req.user.id);

    /**
     * Remove the photograph this one replaced.
     *
     * Every re-upload used to leave the previous file on disk, publicly
     * readable at a URL that had already been handed out and that nothing in
     * the application would ever mention again. That is not housekeeping: a
     * student who replaces a photo they regret has a reasonable expectation
     * that the old one stops being served, and it did not.
     *
     * After the UPDATE, on purpose — the row must stop pointing at the file
     * before the file goes, so a failure between the two leaves an orphan
     * rather than a profile pointing at nothing. The equality check guards the
     * one case where the two are the same path: `Date.now()` has millisecond
     * resolution, so two uploads inside the same millisecond generate the same
     * name, and deleting `previousUrl` there would delete the picture just
     * written.
     */
    if (previousUrl && previousUrl !== relativeUrl) {
      deleteUploadedFile(previousUrl);
    }

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    res.json({ success: true, user: formatUserResponse(fresh) });
  } catch (err) {
    console.error('Profile picture upload error:', err);
    res.status(500).json({ error: 'Failed to process image' });
  }
});

router.delete('/api/users/me/profile-picture', authenticateToken, (req, res) => {
  try {
    const userRow = db.prepare('SELECT profile_picture_url FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    db.prepare('UPDATE users SET profile_picture_url = NULL, profile_picture_uploaded_at = NULL WHERE id = ?')
      .run(req.user.id);

    // Clearing the column is what the caller asked for and must happen whether
    // or not the file can be removed; `deleteUploadedFile` refuses anything
    // outside uploads/ and never throws, so a stored path that escapes the
    // directory costs the caller nothing and destroys nothing.
    deleteUploadedFile(userRow.profile_picture_url);

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ success: true, user: formatUserResponse(fresh) });
  } catch (err) {
    console.error('Profile picture delete error:', err);
    res.status(500).json({ error: 'Failed to delete profile picture' });
  }
});

export default router;
