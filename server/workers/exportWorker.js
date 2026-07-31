import { db } from '../db.js';
import { ZipArchive } from 'archiver';
import fs from 'fs';
import path from 'path';
import { notificationService } from '../services/notificationService.js';

let isRunning = false;
let timeoutId = null;

/**
 * How long an export may sit in `processing` before it is presumed orphaned.
 *
 * Generating a zip of one user's records takes well under a second, so anything
 * still claimed after this belongs to a process that no longer exists.
 */
const STALE_EXPORT_MS = Number(process.env.EXPORT_STALE_MS) || 10 * 60 * 1000;

/**
 * Where completed export archives live.
 *
 * ── Why not os.tmpdir() ──
 *
 * It used to be `os.tmpdir()`, and `deploy/wevolunteer.service` sets
 * `PrivateTmp=true` — a private /tmp on a tmpfs that systemd destroys and
 * recreates every time the unit restarts. The job row keeps
 * `status = 'completed'` and a `file_location` for a seven-day expiry window, so
 * after any restart the database promised an export that no longer existed and the
 * student got "Export file is missing from server". Even without PrivateTmp, /tmp
 * is cleared on reboot on most distributions; a seven-day promise cannot be made
 * from it.
 *
 * The default sits beside the database, which is already the one directory the
 * service unit grants write access to (`ReadWritePaths=/var/lib/wevolunteer`), so
 * this needs no systemd change to work. `WEV_EXPORT_DIR` overrides it for a
 * deployment that wants exports on separate storage.
 *
 * These archives contain a student's full personal record — profile, messages,
 * attendance, certificates — so the directory is created 0o700: owner only.
 */
export function resolveExportDir() {
  if (process.env.WEV_EXPORT_DIR) {
    return path.resolve(process.env.WEV_EXPORT_DIR);
  }
  // Mirrors db.js's own resolution so the two cannot disagree about location.
  const dbPath = process.env.WEV_DB_PATH
    ? path.resolve(process.env.WEV_DB_PATH)
    : path.join(import.meta.dirname, '..', 'wevolunteer.db');
  return path.join(path.dirname(dbPath), 'exports');
}

function ensureExportDir() {
  const dir = resolveExportDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function startExportWorker() {
  if (isRunning) return;
  isRunning = true;
  // A restart recovers the export its own predecessor abandoned, rather than
  // leaving that student blocked until someone edits the database.
  reclaimStaleExports();
  poll();
}

export function stopExportWorker() {
  isRunning = false;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

/**
 * Returns exports stranded in `processing` to `pending`.
 *
 * `POST /api/privacy/export` refuses a new request while one is `pending` or
 * `processing`. Nothing reclaimed a `processing` row, so an export interrupted by
 * a restart left that user permanently 409-ed — no expiry, no way to clear it from
 * the UI, and no error anyone would see. On a feature whose whole purpose is
 * letting a family obtain a copy of their child's record, that is a silent denial.
 */
export function reclaimStaleExports() {
  const cutoff = new Date(Date.now() - STALE_EXPORT_MS).toISOString();
  try {
    const result = db.prepare(`
      UPDATE data_export_jobs SET status = 'pending'
      WHERE status = 'processing' AND created_at <= ?
    `).run(cutoff);

    if (result.changes > 0) {
      console.warn(
        `[ExportWorker] Reclaimed ${result.changes} export job(s) stranded in `
        + '"processing" — a previous run was interrupted.'
      );
    }
    return result.changes;
  } catch (err) {
    console.error('[ExportWorker] Export reclaim failed:', err);
    return 0;
  }
}

/**
 * Runs one polling pass. Exported so tests can drive it deterministically instead
 * of waiting on the five-second timer.
 */
export async function processPendingExports() {
  const job = db.prepare(`
    SELECT id, user_id FROM data_export_jobs
    WHERE status = 'pending'
    ORDER BY created_at ASC LIMIT 1
  `).get();

  if (job) await processJob(job);
}

async function poll() {
  if (!isRunning) return;

  try {
    reclaimStaleExports();
    await processPendingExports();
    cleanupExpiredExports();
  } catch (error) {
    console.error('[ExportWorker] Error polling:', error);
  } finally {
    if (isRunning) {
      // Poll every 5 seconds
      timeoutId = setTimeout(poll, 5000);
      // Does not by itself keep the process alive; shutdown clears it explicitly.
      timeoutId.unref?.();
    }
  }
}

/**
 * Deletes expired archives and clears their recorded path.
 *
 * Renamed from `cleanupExpiredJobs` and exported so the durability test can assert
 * it without waiting for a poll. Behaviour is unchanged.
 */
export function cleanupExpiredExports() {
  const expiredJobs = db.prepare(`
    SELECT id, file_location FROM data_export_jobs
    WHERE status = 'completed' AND expires_at < ?
  `).all(new Date().toISOString());

  const updateStmt = db.prepare(`UPDATE data_export_jobs SET status = 'expired', file_location = NULL WHERE id = ?`);

  for (const job of expiredJobs) {
    if (job.file_location && fs.existsSync(job.file_location)) {
      try {
        fs.unlinkSync(job.file_location);
      } catch (err) {
        console.error(`[ExportWorker] Failed to delete expired file ${job.file_location}:`, err);
      }
    }
    updateStmt.run(job.id);
  }
}

async function processJob(job) {
  const { id, user_id } = job;
  
  // Optimistic lock
  const updated = db.prepare(`
    UPDATE data_export_jobs SET status = 'processing' 
    WHERE id = ? AND status = 'pending'
  `).run(id);

  if (updated.changes === 0) return; // Picked up by another worker

  console.log(`[ExportWorker] Processing job ${id} for user ${user_id}`);

  // Durable storage rather than os.tmpdir() — see resolveExportDir() for why the
  // old location could not keep the seven-day promise the job row makes.
  const tmpFilePath = path.join(ensureExportDir(), `wevolunteer-export-${id}.zip`);

  try {
    await generateZip(user_id, tmpFilePath);
    
    // Calculate expiration (7 days from now)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const completedAt = new Date().toISOString();

    db.prepare(`
      UPDATE data_export_jobs 
      SET status = 'completed', file_location = ?, completed_at = ?, expires_at = ?
      WHERE id = ?
    `).run(tmpFilePath, completedAt, expiresAt, id);

    // Notify user
    notificationService.dispatch('SYSTEM_ALERT', {
      title: 'Data Export Ready',
      body: 'Your data export is ready to download. It will expire in 7 days.',
      link: '/settings?section=privacy'
    }, user_id);

    console.log(`[ExportWorker] Completed job ${id}`);
  } catch (error) {
    console.error(`[ExportWorker] Failed job ${id}:`, error);
    db.prepare(`UPDATE data_export_jobs SET status = 'failed' WHERE id = ?`).run(id);
    
    if (fs.existsSync(tmpFilePath)) {
      fs.unlinkSync(tmpFilePath);
    }
    
    notificationService.dispatch('SYSTEM_ALERT', {
      title: 'Data Export Failed',
      body: 'There was a problem generating your data export. Please try again.',
      link: '/settings?section=privacy'
    }, user_id);
  }
}

function generateZip(userId, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on('close', () => resolve());
    archive.on('error', (err) => reject(err));

    archive.pipe(output);

    // --- Profile ---
    const user = db.prepare(`
      SELECT username, email, name, grade, role, school, bio, skills, leaderboard_opt_in, profile_visibility, created_at, account_status
      FROM users WHERE id = ?
    `).get(userId);

    archive.append(JSON.stringify(user, null, 2), { name: 'profile.json' });

    // --- Account / Settings ---
    const notifPrefs = db.prepare(`SELECT category, channel, enabled FROM notification_preferences WHERE user_id = ?`).all(userId);
    const oauthAccounts = db.prepare(`SELECT provider, provider_user_id, provider_email, created_at, last_used_at FROM oauth_accounts WHERE user_id = ?`).all(userId);
    const accountData = {
      created_at: user.created_at,
      role: user.role,
      account_status: user.account_status,
      privacy: {
        leaderboard_opt_in: user.leaderboard_opt_in,
        profile_visibility: user.profile_visibility
      },
      notification_preferences: notifPrefs,
      connected_accounts: oauthAccounts
    };
    archive.append(JSON.stringify(accountData, null, 2), { name: 'account.json' });

    // --- Volunteer History ---
    const history = db.prepare(`
      SELECT e.title AS event, e.category, e.location, a.hours_awarded AS hours, s.end_datetime AS completed
      FROM attendance a
      JOIN slots s ON a.slot_id = s.id
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? AND a.present = 1
      ORDER BY s.end_datetime DESC
    `).all(userId);
    archive.append(JSON.stringify(history, null, 2), { name: 'volunteer_history.json' });

    // --- Certificates ---
    const certificates = db.prepare(`
      SELECT code, volunteer_name_snapshot, event_name_snapshot, organization_snapshot, hours_snapshot, completed_at_snapshot, created_at
      FROM certificates WHERE user_id = ?
    `).all(userId);
    archive.append(JSON.stringify(certificates, null, 2), { name: 'certificates.json' });

    // --- Applications ---
    const applications = db.prepare(`
      SELECT e.title as event, s.name as slot, s.start_datetime as start, app.status, app.applied_at
      FROM applications app
      JOIN events e ON app.event_id = e.id
      JOIN slots s ON app.slot_id = s.id
      WHERE app.user_id = ?
    `).all(userId);
    archive.append(JSON.stringify(applications, null, 2), { name: 'applications.json' });

    // --- Events (Participated) ---
    const events = db.prepare(`
      SELECT e.title, e.description, e.location, e.category, s.name as slot, a.status as participation_status
      FROM applications a
      JOIN events e ON a.event_id = e.id
      JOIN slots s ON a.slot_id = s.id
      WHERE a.user_id = ?
    `).all(userId);
    archive.append(JSON.stringify(events, null, 2), { name: 'events.json' });

    // --- Messages ---
    const conversations = db.prepare(`
      SELECT c.id as conversation_id, e.title as event_title, c.created_at
      FROM conversation_participants p
      JOIN conversations c ON p.conversation_id = c.id
      JOIN events e ON c.event_id = e.id
      WHERE p.user_id = ?
    `).all(userId);

    const messagesData = conversations.map(conv => {
      const messages = db.prepare(`
        SELECT m.body, m.created_at, u.name as sender_name
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at ASC
      `).all(conv.conversation_id);
      
      return {
        event: conv.event_title,
        started_at: conv.created_at,
        messages
      };
    });
    archive.append(JSON.stringify(messagesData, null, 2), { name: 'messages.json' });

    // --- Notifications ---
    const notifications = db.prepare(`
      SELECT kind, title, body, read, created_at
      FROM notifications WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId);
    archive.append(JSON.stringify(notifications, null, 2), { name: 'notifications.json' });

    archive.finalize();
  });
}
