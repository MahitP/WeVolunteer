/**
 * The Owner Center's API — `/owner`'s four reads.
 *
 * ── Four endpoints rather than one aggregate ──
 *
 * An aggregate is the obvious shape and it is the wrong one here. The page has
 * a local half that answers in a millisecond (this process, this database) and
 * a remote half that answers in whatever Better Stack and Amplitude take, and
 * one endpoint means the fast half waits for the slow half on every render. It
 * also means one slow vendor is one slow page rather than one slow card, which
 * is precisely the failure mode §12 of the brief names.
 *
 * Split by SERVICE rather than by card, so each one maps to exactly one
 * provider module and one cache key. `infrastructure` carries two providers
 * because Upstash and Pinecone are both local-transport reads under a second
 * and splitting them would cost a round trip to save nothing.
 *
 * ── Authorization ──
 *
 * `owner.console` is SUPER_ONLY, so `can()` refuses it before it consults
 * per-user grants: no capability grant can reach these routes, and no
 * administrator, organizer, partner or student can either. The route table in
 * `src/routes/index.jsx` names the same capability, which keeps somebody who
 * typed the URL out of a shell they cannot use — but this is the boundary. See
 * `server/routes.owner.test.js`, which asserts the refusal per role rather than
 * trusting that.
 *
 * ── What may leave this file ──
 *
 * No credential, ever — not in a payload, not in a URL, not in an error. The
 * provider modules reduce every failure to a state word at their own boundary
 * (`server/integrations/providerResult.js`), and nothing here re-widens that.
 * `server/routes.owner.test.js` asserts the payload contains no configured
 * secret, using the real environment variable values, so the guard fails if a
 * future field starts echoing one.
 */
import express from 'express';

import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { db } from '../db.js';
import { getMailHealth } from '../email.js';
import { deliveryHealth } from '../resendWebhook.js';
import { getQueueHealth } from '../workers/notificationWorker.js';
import { backupStatus } from '../backupStatus.js';
import { hoursLedgerStatus } from '../hoursLedger.js';
import { databaseHealth, errorTrend } from '../serviceHealth.js';
import { weatherCacheStats } from './weatherRoutes.js';
import { geocodeCacheStats } from './geocodeRoutes.js';

import { cached } from '../integrations/providerCache.js';
import {
  BETTERSTACK_DASHBOARD_URL, BETTERSTACK_TELEMETRY_URL,
  betterStackConfigured, fetchIncidents, fetchMonitors, telemetryPipeline,
} from '../integrations/betterstack.js';
import {
  amplitudeConfigured, amplitudeDashboardUrl, fetchEventUsage, fetchUsers,
} from '../integrations/amplitude.js';
import { UPSTASH_CONSOLE_URL, fetchRedis } from '../integrations/upstash.js';
import { PINECONE_CONSOLE_URL, fetchVectorSearch } from '../integrations/pinecone.js';

const router = express.Router();

/**
 * How long each answer is remembered.
 *
 * Different per provider because the underlying costs differ by two orders of
 * magnitude. Monitors and incidents are the ones an owner watches during an
 * incident, so they are the shortest; Amplitude is priced per query against an
 * hourly budget and its figures are daily aggregates that cannot meaningfully
 * change in five minutes.
 */
const TTL = Object.freeze({
  monitoring: 60_000,
  analytics: 5 * 60_000,
  infrastructure: 60_000,
});

/**
 * Whether the caller asked to bypass the cache.
 *
 * The refresh button sends it. It skips a cache HIT, never the deduplication or
 * the stale fallback — so holding the button down produces one request per
 * provider in flight rather than one per press. `apiLimiter` in app.js is the
 * ceiling above that.
 */
const wantsFresh = (req) => req.query.fresh === '1';

/* ── Application health ───────────────────────────────────────────────────
 *
 * Everything here is local: this process, this database, this deployment's own
 * counters. No third party is contacted, so this endpoint answers even when
 * every vendor is down — which is the state in which it matters most.
 * ──────────────────────────────────────────────────────────────────────── */

router.get('/api/owner/health', authenticateToken, requireCap('owner.console'), async (req, res) => {
  try {
    res.json({
      generatedAt: new Date().toISOString(),
      /* The process answered, which is what "the API is up" means from inside
         it. Reported as a fact about THIS process — uptime and release — rather
         than as a green tick that would be true by construction. */
      application: {
        state: 'ok',
        release: process.env.APP_RELEASE || null,
        environment: process.env.NODE_ENV || 'development',
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
      },
      /* Asked, not assumed, and read-only — see `serviceHealth.js`. */
      database: await databaseHealth(db),
      mail: {
        /* `smtpConfigured` is deliberately kept beside `mail.health`: one
           answers "is it set up", the other "is it working", and a healthy
           second says nothing about the first. Same pair
           `/api/admin/system/status` shows, and the same reasoning recorded
           there — during an SMTP outage `smtpConfigured` stayed true while
           every verification link silently failed to arrive. */
        smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
        health: getMailHealth(),
        /* What the PROVIDER said became of recent mail. A message Resend
           accepted and then hard-bounced looks like a success in `health`. */
        delivery: await deliveryHealth(),
      },
      notificationQueue: await getQueueHealth(),
      backup: backupStatus(),
      hoursLedger: await hoursLedgerStatus(db),
      errors: await errorTrend(db),
    });
  } catch (err) {
    console.error('Owner health error:', err);
    res.status(500).json({ error: 'Could not read application health.' });
  }
});

/* ── Better Stack ─────────────────────────────────────────────────────── */

router.get('/api/owner/monitoring', authenticateToken, requireCap('owner.console'), async (req, res) => {
  try {
    const fresh = wantsFresh(req);
    const [monitors, incidents] = await Promise.all([
      cached('betterstack:monitors', TTL.monitoring, () => fetchMonitors(), { fresh }),
      cached('betterstack:incidents', TTL.monitoring, () => fetchIncidents(), { fresh }),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      configured: betterStackConfigured(),
      monitors,
      incidents,
      /* Local, uncached, and free — see `telemetryPipeline`. It is the half of
         this card that works on a deployment with no Uptime token, which is the
         pilot's current state. */
      telemetry: telemetryPipeline(),
      links: {
        dashboard: BETTERSTACK_DASHBOARD_URL,
        telemetry: BETTERSTACK_TELEMETRY_URL,
      },
    });
  } catch (err) {
    console.error('Owner monitoring error:', err);
    res.status(500).json({ error: 'Could not read monitoring status.' });
  }
});

/* ── Amplitude ────────────────────────────────────────────────────────── */

router.get('/api/owner/analytics', authenticateToken, requireCap('owner.console'), async (req, res) => {
  try {
    const fresh = wantsFresh(req);
    const [users, events] = await Promise.all([
      cached('amplitude:users', TTL.analytics, () => fetchUsers(), { fresh }),
      cached('amplitude:events', TTL.analytics, () => fetchEventUsage(), { fresh }),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      configured: amplitudeConfigured(),
      users,
      events,
      links: { dashboard: amplitudeDashboardUrl() },
    });
  } catch (err) {
    console.error('Owner analytics error:', err);
    res.status(500).json({ error: 'Could not read analytics.' });
  }
});

/* ── Upstash and Pinecone ─────────────────────────────────────────────── */

router.get('/api/owner/infrastructure', authenticateToken, requireCap('owner.console'), async (req, res) => {
  try {
    const fresh = wantsFresh(req);
    const [redis, vector] = await Promise.all([
      cached('upstash:redis', TTL.infrastructure, () => fetchRedis({
        weather: weatherCacheStats(),
        geocode: geocodeCacheStats(),
      }), { fresh }),
      cached('pinecone:index', TTL.infrastructure, () => fetchVectorSearch(), { fresh }),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      redis,
      vector,
      links: {
        upstash: UPSTASH_CONSOLE_URL,
        pinecone: PINECONE_CONSOLE_URL,
      },
    });
  } catch (err) {
    console.error('Owner infrastructure error:', err);
    res.status(500).json({ error: 'Could not read infrastructure status.' });
  }
});

export default router;
