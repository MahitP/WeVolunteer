import express from 'express';
import rateLimit from 'express-rate-limit';
import { DEMO_MODE } from '../config.js';
import { LEGAL_DOCUMENTS, documentBySlug, publishedHash } from '../legalDocuments.js';
import { policyContent, PolicyContentError } from '../legalContent.js';

/**
 * Publishes the legal documents the product asks people to rely on.
 *
 * ── Why these routes are unauthenticated ──
 *
 * The signup form asks a fourteen-year-old to agree to the Terms. They have no
 * account at that moment — having one is what they are deciding about — so a
 * session-gated Terms page is a link that cannot be followed by the only person
 * who needs to follow it. That is not a UX wrinkle: "read the Terms" pointing at
 * something unreadable is a misrepresentation about the availability of the
 * terms, which is the same defect as pointing at a 404.
 *
 * The documents are published policy. There is nothing to protect.
 *
 * ── Why the content is not simply a static file mount ──
 *
 * `dist/` is already served statically and dropping the Markdown in there would
 * be less code. It would also serve whatever bytes are on disk, and the one
 * property that matters here is that a user never reads policy text that differs
 * from the text their acceptance record's hash points at. `legalContent.js`
 * enforces that on every read and throws instead of serving on a mismatch; a
 * static mount cannot.
 *
 * ── Markdown, rendered by the client ──
 *
 * These endpoints return the Markdown source and the client renders it. The
 * alternative — rendering to HTML here — means the server emits markup that a
 * privileged page injects, and the moment that is the shape, someone eventually
 * reaches for `dangerouslySetInnerHTML`. Shipping the source keeps the rendering
 * decision (and the escaping) on the side that owns the DOM.
 */

const router = express.Router();

/**
 * Generous, because being throttled out of reading the Terms is a bad outcome
 * and the payload is a few kilobytes of static text from an in-process cache.
 * Present at all because the endpoint is unauthenticated and therefore is a
 * free-to-call surface, which is the only reason it needs a ceiling.
 */
const legalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: DEMO_MODE ? 600 : 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
      code: 'rate_limited',
    });
  },
});

router.use('/api/legal', legalLimiter);

/** The public shape of a registry entry. Never leaks `file`. */
function publicMeta(doc) {
  return {
    slug: doc.slug,
    title: doc.title,
    version: doc.version,
    consentType: doc.consentType,
    scope: doc.scope,
    summary: doc.summary,
    effectiveAt: doc.effectiveAt,
    /**
     * What was actually published, not the pinned constant.
     *
     * `LegalDocument.jsx` renders the first 16 characters of this as a "Content
     * fingerprint" beside the text. Before launch the pinned constant is allowed
     * to lag the file (see LEGAL_HASHES_ENFORCED), so reporting it here would
     * print a fingerprint that does not describe the words underneath it — a
     * worse failure than no fingerprint, because it looks like verification.
     */
    contentHash: publishedHash(doc),
    bundledWith: doc.bundledWith,
  };
}

/**
 * The catalogue.
 *
 * Derived from the registry rather than a hand-maintained list, so registering a
 * document publishes it — the same reason `requiredConsentKeys()` is derived and
 * the signed-out route test reads `PUBLIC_ROUTES`.
 */
router.get('/api/legal/documents', (req, res) => {
  res.json({ documents: LEGAL_DOCUMENTS.map(publicMeta) });
});

/**
 * One document, with its text.
 *
 * A `PolicyContentError` is a 500 and not a 404: the document IS registered, so
 * the deployment is broken rather than the request. Answering 404 would tell a
 * user "no such policy" when the truth is "this server cannot show you the
 * policy it is holding you to", and those want opposite responses.
 */
router.get('/api/legal/documents/:slug', (req, res) => {
  const doc = documentBySlug(req.params.slug);
  if (!doc) return res.status(404).json({ error: 'No such legal document.' });

  let markdown;
  try {
    markdown = policyContent(doc.slug);
  } catch (err) {
    if (err instanceof PolicyContentError) {
      console.error(`[legal] ${err.message}`);
      return res.status(500).json({
        error: 'This document is temporarily unavailable. Please contact support.',
        code: 'policy_unavailable',
      });
    }
    throw err;
  }

  res.json({ ...publicMeta(doc), markdown });
});

export default router;
