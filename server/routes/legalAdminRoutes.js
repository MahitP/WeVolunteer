import express from 'express';
import rateLimit from 'express-rate-limit';
import { DEMO_MODE } from '../config.js';
import { db } from '../db.js';
import { authenticateToken, inTransaction } from '../utils.js';
import { requireCap, requireAAL2 } from '../authz.js';
import { ChallengeNotSpent, refuseReauth, spendChallenge } from '../reauthResponses.js';
import { recordAudit } from '../auditLog.js';
import { documentBySlug } from '../legalDocuments.js';
import { PolicyContentError } from '../legalContent.js';
import {
  resolveDocument, effectiveDocuments, publishRevision, validatePublication,
  revisionHistory, LegalValidationError, MAX_BODY_LENGTH,
} from '../legalStore.js';

/**
 * The Legal Center editor's API — owner only, and server-enforced.
 *
 * ── Why this is a separate module from legalRoutes.js ──
 *
 * `legalRoutes.js` is deliberately unauthenticated and mounts a router-level
 * limiter across the whole `/api/legal` prefix, because its job is to make the
 * Terms readable by somebody who does not have an account yet. Hanging a
 * mutation off that prefix would put the write path inside a limiter tuned for
 * anonymous reads and inside a file whose header argues, at length, that
 * everything in it is public. Those are two different jobs with two different
 * hazards, so they are two files — the same reasoning that split
 * `legalContent.js` out of `legalDocuments.js`.
 *
 * ── Both verbs are gated, not just the write ──
 *
 * `requireCap('legal.edit')` sits on the GETs as well. The published text is
 * already public, so gating the read is not about secrecy: it is that the
 * editor's read returns the raw source with its revision history and author
 * attribution, and "who has been editing our Terms, and when" is not something
 * an ordinary account should be able to enumerate. It also keeps the requirement
 * literally true — a non-owner cannot retrieve editable content — instead of
 * true only for the endpoint somebody remembered.
 *
 * ── Where the effect actually lands ──
 *
 * v1.2b's own audit found two gated effects reachable by an ungated route, and
 * the lesson recorded from it was to ask where the effect lands and whether a
 * second endpoint reaches it. Here the effect is "what `/api/legal/documents/:slug`
 * serves to the world", and exactly one statement in the codebase moves it: the
 * INSERT in `publishRevision`. Nothing else writes `legal_document_revisions`,
 * and the public route derives its answer from that table rather than holding
 * its own copy — so there is no second door and no cache to leave stale.
 */

const router = express.Router();

/**
 * Tighter than the public reader's 120/min, and for the opposite reason.
 *
 * The public limiter is generous because being throttled out of reading the
 * Terms is a bad outcome. Nobody legitimately publishes legal documents in
 * bursts, so a low ceiling here costs an owner nothing and puts a bound on how
 * fast a stolen owner session can churn the corpus.
 */
const legalAdminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: DEMO_MODE ? 200 : 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
      code: 'rate_limited',
    });
  },
});

router.use('/api/admin/legal', legalAdminLimiter);

/** Metadata the editor needs to describe a document without loading its text. */
function editorMeta(doc) {
  return {
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary,
    scope: doc.scope,
    consentType: doc.consentType,
    version: doc.version,
    effectiveAt: doc.effectiveAt,
    contentHash: doc.contentHash,
    updatedAt: doc.updatedAt ?? null,
    /* 'file' or 'revision' — the editor says "as originally published" versus
       "edited here", so an owner can tell at a glance which documents have been
       touched since launch without opening each one. */
    source: doc.source,
    /**
     * Whether publishing this document re-gates its audience.
     *
     * True only for the Organizer Agreement today. `hasAcceptedOrganizerAgreement`
     * matches on `(slug, version)`, so a new version withholds fifteen
     * capabilities from every organizer until each accepts again. Sent as a flag
     * rather than hardcoded in the client, because the condition belongs to the
     * consent model and the client should not be the second place that knows it.
     */
    reconsentOnPublish: doc.scope === 'organizer-onboarding',
  };
}

/**
 * Every document, with no bodies.
 *
 * The editor opens on a list and loads one document at a time. Shipping ten
 * bodies to render ten titles would be about 80 KB nobody reads.
 */
router.get(
  '/api/admin/legal/documents',
  authenticateToken,
  requireCap('legal.edit'),
  (req, res) => {
    try {
      res.json({
        documents: effectiveDocuments(db).map(editorMeta),
        limits: { maxBodyLength: MAX_BODY_LENGTH },
      });
    } catch (err) {
      console.error('Failed to list legal documents for editing:', err);
      res.status(500).json({ error: 'Could not load the legal documents.' });
    }
  }
);

/**
 * One document: its editable source, and every version it has had.
 *
 * `body` is what the editor loads into the textarea, and it is the published
 * half only — never the file's internal `## Specification` block. An editor that
 * opened with the drafting brief above the document would invite somebody to
 * publish it.
 */
router.get(
  '/api/admin/legal/documents/:slug',
  authenticateToken,
  requireCap('legal.edit'),
  (req, res) => {
    if (!documentBySlug(req.params.slug)) {
      return res.status(404).json({ error: 'No such legal document.' });
    }

    try {
      const doc = resolveDocument(db, req.params.slug, { withBody: true });
      res.json({
        ...editorMeta(doc),
        body: doc.body,
        history: revisionHistory(db, doc.slug),
      });
    } catch (err) {
      /* The file is unreadable or has lost its `## Draft` marker. A 500, not a
         404, for the reason legalRoutes.js gives: the document is registered, so
         the deployment is broken rather than the request. */
      if (err instanceof PolicyContentError) {
        console.error(`[legal] ${err.message}`);
        return res.status(500).json({
          error: 'The published text of this document could not be read from disk, '
            + 'so there is nothing to edit yet. This is a deployment problem — '
            + 'docs/legal/policies must be deployed alongside the server.',
          code: 'policy_unavailable',
        });
      }
      console.error('Failed to load legal document for editing:', err);
      res.status(500).json({ error: 'Could not load this document.' });
    }
  }
);

/**
 * Publish a new version.
 *
 * ── The ordering here is the security property ──
 *
 * Every refusal is answered ABOVE `inTransaction`, and `spendChallenge` is the
 * first statement inside it. Both halves matter and they fail in opposite
 * directions:
 *
 *   - A refusal below the spend costs the owner a verification for a request
 *     that delivered nothing, and they have to do the whole round trip again to
 *     retry. `admin.promote` puts its "already an administrator" check above the
 *     transaction for exactly this reason.
 *   - A spend that is not inside the same transaction as the INSERT leaves the
 *     grant replayable if the insert fails — and every functional test still
 *     passes, which is why guard 5 in authz.completeness.test.js exists.
 *
 * The validation that can refuse (version, dates, links, duplicate text) lives
 * in `publishRevision`, which is called INSIDE the transaction — so it is run
 * once here, above, purely to answer the refusals before anything is spent, and
 * then again for real. `validateBody` is pure and reads no state, so running it
 * twice is a few milliseconds and cannot disagree with itself.
 *
 * ── Why the version comparison must be inside the transaction ──
 *
 * It reads the highest existing version and writes one above it. Outside a
 * transaction two concurrent publishes both read 1.0 and both try to write
 * 1.1.0; the loser hits `UNIQUE(slug, version)` and becomes a 500 with its
 * step-up grant already gone. Inside one, the loser is refused cleanly.
 */
router.post(
  '/api/admin/legal/documents/:slug/revisions',
  authenticateToken,
  requireCap('legal.edit'),
  requireAAL2('legal.publish'),
  (req, res) => {
    const { slug } = req.params;
    if (!documentBySlug(slug)) {
      return res.status(404).json({ error: 'No such legal document.' });
    }

    const version = typeof req.body?.version === 'string' ? req.body.version.trim() : '';
    const { body, effectiveAt } = req.body ?? {};

    let published;
    try {
      /**
       * Refusals answered first, above the transaction and above the spend.
       *
       * This is the same function `publishRevision` calls, so the two cannot
       * disagree about what is valid. Running it here means a malformed version,
       * a bad date, an unsafe link or unchanged text is a plain 400 with the
       * owner's step-up grant still intact — they fix the field and press save
       * again without proving who they are a second time.
       */
      validatePublication(db, { slug, version, body, effectiveAt });

      published = inTransaction(() => {
        /* Bound to the values about to be WRITTEN, never the ones the client
           claimed: `version` is the string that lands in the row. A grant taken
           out for the Cookie Notice at 1.0.1 cannot publish the Terms. */
        spendChallenge(db, req, 'legal.publish', { slug, version });

        const result = publishRevision(db, {
          slug, body, version, effectiveAt, userId: req.user.id,
        });

        recordAudit(db, {
          adminId: req.user.id,
          action: 'LEGAL_DOCUMENT_PUBLISHED',
          targetUserId: null,
          details: `Published ${documentBySlug(slug).title} version ${result.version} `
            + `(effective ${result.effectiveAt}, content ${result.contentHash.slice(0, 16)})`,
        });

        return result;
      });
    } catch (err) {
      if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
      if (err instanceof LegalValidationError) {
        return res.status(400).json({ error: err.message, field: err.field });
      }
      console.error('Failed to publish legal document revision:', err);
      return res.status(500).json({
        error: 'This could not be saved. Your changes have not been lost — '
          + 'copy them somewhere safe before leaving this page.',
      });
    }

    /* The full resolved document, so the client can replace its state from the
       server's answer instead of assuming its own optimistic version of it. */
    const doc = resolveDocument(db, slug, { withBody: true });
    res.json({
      ...editorMeta(doc),
      body: doc.body,
      history: revisionHistory(db, slug),
      published: { version: published.version, at: published.createdAt },
    });
  }
);

export default router;
