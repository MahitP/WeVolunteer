import { db } from '../db.js';
import { sendMail, buildHtmlTemplate } from '../email.js';
import { getInAppContent } from '../services/notificationContent.js';

const APP_NAME = process.env.APP_NAME || 'WeVolunteer';
const APP_URL = process.env.APP_URL || (process.env.NODE_ENV === 'production' ? null : 'http://localhost:5173');

export async function processNotificationJobs() {
  const pendingJobs = db.prepare(`
    SELECT * FROM notification_jobs 
    WHERE status = 'pending' AND next_attempt_at <= ?
    LIMIT 10
  `).all(new Date().toISOString());

  for (const job of pendingJobs) {
    db.prepare("UPDATE notification_jobs SET status = 'processing' WHERE id = ?").run(job.id);
    
    try {
      if (job.channel === 'email') {
        await handleEmailJob(job);
      } else {
        throw new Error(`Unknown channel: ${job.channel}`);
      }
      
      // On success, we just delete the job to save space
      db.prepare("DELETE FROM notification_jobs WHERE id = ?").run(job.id);
    } catch (err) {
      const newAttempts = job.attempts + 1;
      const backoffMs = Math.pow(2, newAttempts) * 60000; 
      const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
      const status = newAttempts >= 5 ? 'failed' : 'pending';
      
      db.prepare(`
        UPDATE notification_jobs 
        SET status = ?, attempts = ?, next_attempt_at = ?, error_log = ? 
        WHERE id = ?
      `).run(status, newAttempts, nextAttemptAt, String(err.message), job.id);
    }
  }
}

async function handleEmailJob(job) {
  const { event, payload, userId } = JSON.parse(job.payload);
  
  const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');
  
  const content = getInAppContent(event, payload);
  const subject = content.title;
  let text = content.body;
  
  let ctaText = null;
  let ctaUrl = null;
  
  if (content.link) {
    if (content.link.startsWith('event:')) {
      const eventId = content.link.split(':')[1];
      ctaText = 'View Event Details';
      ctaUrl = `${APP_URL}/?event=${eventId}`;
    } else {
      ctaText = 'View Details';
      ctaUrl = `${APP_URL}${content.link}`;
    }
  }
  
  let htmlContent = `
    <p style="font-size: 16px; margin-bottom: 24px;">Hi ${user.name},</p>
    <p style="font-size: 16px; line-height: 1.5;">${text.replace(/\\n/g, '<br/>')}</p>
  `;

  if (payload && payload.eventId) {
    try {
      const dbEvent = db.prepare(`
        SELECT e.title, e.location, e.start_datetime, u.name as org_name 
        FROM events e 
        LEFT JOIN users u ON e.organizer_id = u.id 
        WHERE e.id = ?
      `).get(payload.eventId);

      if (dbEvent) {
        const dateStr = new Date(dbEvent.start_datetime).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        const timeStr = new Date(dbEvent.start_datetime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        htmlContent += `
          <div style="margin-top: 24px; padding: 16px; background-color: #f7f7f5; border-radius: 8px; border-left: 4px solid #0f6b45;">
            <h3 style="margin: 0 0 8px 0; font-size: 18px; color: #14231c;">${dbEvent.title}</h3>
            <p style="margin: 0 0 4px 0; font-size: 14px; color: #66736d;"><strong>Date:</strong> ${dateStr} at ${timeStr}</p>
            <p style="margin: 0 0 4px 0; font-size: 14px; color: #66736d;"><strong>Location:</strong> ${dbEvent.location || 'TBA'}</p>
            <p style="margin: 0; font-size: 14px; color: #66736d;"><strong>Organizer:</strong> ${dbEvent.org_name || 'Unknown'}</p>
          </div>
        `;
      }
    } catch (e) {
      console.error('Failed to append event details to email', e);
    }
  }
  
  const html = buildHtmlTemplate(subject, htmlContent, ctaText, ctaUrl);
  
  if (content.link) {
    text += `\\n\\nLink: ${ctaUrl}`;
  }

  await sendMail({
    to: user.email,
    subject: `${subject} - ${APP_NAME}`,
    text,
    html
  });
}

let workerInterval = null;
export function startNotificationWorker() {
  if (workerInterval) return;
  workerInterval = setInterval(processNotificationJobs, 10000);
  console.log('[Worker] Notification outbox processor started.');
}
