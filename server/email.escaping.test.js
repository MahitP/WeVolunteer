/**
 * Outbound email must not carry user-controlled markup.
 *
 * Every notification email interpolated raw database values into an HTML template:
 *
 *   notificationWorker.js:220   Hi ${user.name},
 *   notificationWorker.js:221   ${text}                 (derived from event titles)
 *   notificationWorker.js:238   ${dbEvent.title}
 *   notificationWorker.js:240   ${dbEvent.location}
 *   notificationWorker.js:241   ${dbEvent.org_name}
 *   email.js:387                <h1>${subject}</h1>
 *   email.js (buildHtmlTemplate) <title>${title}</title>
 *
 * Event titles and locations are free text typed by an organizer, and `name` is
 * set by the account holder. None of it was escaped.
 *
 * ── The threat, stated accurately ──
 *
 * Mail clients do not execute `<script>`, so this is not stored XSS in the browser
 * sense. What it is: an authenticated organizer can inject arbitrary anchors and
 * images into mail that WeVolunteer sends, from WeVolunteer's own domain, passing
 * the district's SPF/DKIM, to every student signed up for a shift and to the
 * parents who read over their shoulder. An event titled
 *
 *     Beach Cleanup <a href="https://evil.example/login">Confirm your account here</a>
 *
 * produces a phishing link the recipient has every reason to trust. On a platform
 * for minors that is the payload that matters, and it needs no XSS at all.
 *
 * Escaping at render is the correct fix and matches what the app already does for
 * the web surface — message bodies are deliberately stored raw and escaped by React
 * on output. This brings the email surface to the same standard.
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, buildHtmlTemplate } from './email.js';

/** A payload that is harmless in plain text and dangerous in HTML. */
const HOSTILE = 'Beach Cleanup <a href="https://evil.example">Confirm here</a>';
const HOSTILE_IMG = '<img src="https://tracker.example/pixel.gif">';

describe('escapeHtml', () => {
  it('neutralises the characters that start markup', () => {
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes the ampersand first, so escapes are not double-encoded', () => {
    // Getting this order wrong yields &amp;lt; and the reader sees "&lt;".
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Beach Cleanup at Riverside Park')).toBe('Beach Cleanup at Riverside Park');
  });

  it('handles null and undefined without throwing', () => {
    // Event location is nullable, and org_name comes from a LEFT JOIN.
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('coerces non-strings rather than failing', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('buildHtmlTemplate escapes its title', () => {
  it('does not emit a raw anchor from the title into the document', () => {
    const html = buildHtmlTemplate(HOSTILE, '<p>body</p>');

    // The title lands in <title> and is not content the caller controls as markup.
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).toContain('&lt;a href=');
  });

  it('still renders the caller-supplied content HTML as markup', () => {
    // contentHTML is built by the application from a fixed template, so it is
    // trusted by contract — escaping it would render the entire email as source.
    const html = buildHtmlTemplate('Subject', '<p class="x">Hello</p>');
    expect(html).toContain('<p class="x">Hello</p>');
  });

  it('escapes a hostile CTA url rather than breaking out of the attribute', () => {
    const html = buildHtmlTemplate('S', '<p>b</p>', 'Click', 'https://x.example/"><script>bad()</script>');
    expect(html).not.toContain('<script>bad()</script>');
  });
});

describe('notification emails escape database values', () => {
  /**
   * Exercised through the worker's real path rather than a unit call, because the
   * defect was in how the worker assembled `htmlContent` — a test of escapeHtml
   * alone would pass while the worker still interpolated raw.
   */
  async function renderNotificationEmail({ userName, eventTitle, eventLocation, orgName }) {
    const { mkdtempSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const path = await import('path');
    const { vi } = await import('vitest');

    const dir = mkdtempSync(path.join(tmpdir(), 'wev-email-esc-'));
    process.env.WEV_DB_PATH = path.join(dir, 'email.db');
    process.env.JWT_SECRET = 'x'.repeat(48);
    process.env.APP_URL = 'http://localhost:5173';
    delete process.env.NODE_ENV;

    vi.resetModules();
    const dbMod = await import('./db.js');
    dbMod.initDatabase();
    await dbMod.completeDatabaseInit();
    const db = dbMod.db;

    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
      VALUES ('u1','u1','u1@example.org','x',?,'11','student',?)
    `).run(userName, now);
    await db.prepare(`
      INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
      VALUES ('org1','org1','org1@example.org','x',?,'Adult','organizer',?)
    `).run(orgName, now);
    /**
     * The shift time lives on `slots`, not `events`.
     *
     * The first version of this helper inserted `start_datetime` into `events` and
     * failed with "table events has no column named start_datetime" — which is the
     * same mistake the production query made, and how that bug was found: the
     * worker selected `e.start_datetime`, threw on every send, and its catch block
     * silently dropped the whole event-details card from every notification email.
     */
    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, created_at)
      VALUES ('e1', ?, 'd', 'School', ?, ?, 'org1', 'open', ?)
    `).run(eventTitle, eventLocation, now, now);
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES ('s1', 'e1', 'Morning', 'd', ?, ?, 5)
    `).run(now, now);

    // Capture what would have gone out, instead of sending it.
    const sent = [];
    vi.doMock('./email.js', async (orig) => {
      const actual = await orig();
      return { ...actual, sendMail: async (m) => { sent.push(m); return true; } };
    });

    vi.resetModules();
    const worker = await import('./workers/notificationWorker.js');
    await db.prepare(`
      INSERT INTO notification_jobs (id, channel, payload, status, attempts, next_attempt_at, created_at)
      VALUES ('j1','email',?,'pending',0,?,?)
    `).run(
      JSON.stringify({ event: 'APPLICATION_ACCEPTED', payload: { eventId: 'e1' }, userId: 'u1' }),
      new Date(Date.now() - 1000).toISOString(),
      now
    );

    await worker.processNotificationJobs();
    rmSync(dir, { recursive: true, force: true });
    vi.doUnmock('./email.js');
    return sent[0];
  }

  it('escapes a hostile event title', async () => {
    const mail = await renderNotificationEmail({
      userName: 'Ava',
      eventTitle: HOSTILE,
      eventLocation: 'Riverside Park',
      orgName: 'Sarah'
    });

    expect(mail, 'no mail was produced').toBeTruthy();
    // The phishing anchor must not survive into the HTML part.
    expect(mail.html).not.toContain('<a href="https://evil.example">');
    expect(mail.html).toContain('&lt;a href=');
  });

  it('escapes a hostile location and organizer name', async () => {
    const mail = await renderNotificationEmail({
      userName: 'Ava',
      eventTitle: 'Beach Cleanup',
      eventLocation: HOSTILE_IMG,
      orgName: HOSTILE
    });

    expect(mail.html).not.toContain('<img src="https://tracker.example/pixel.gif">');
    expect(mail.html).not.toContain('<a href="https://evil.example">');
  });

  it('escapes the recipient name', async () => {
    const mail = await renderNotificationEmail({
      userName: HOSTILE_IMG,
      eventTitle: 'Beach Cleanup',
      eventLocation: 'Park',
      orgName: 'Sarah'
    });

    expect(mail.html).not.toContain('<img src="https://tracker.example/pixel.gif">');
  });

  it('keeps the plain-text part readable', async () => {
    const mail = await renderNotificationEmail({
      userName: 'Ava',
      eventTitle: 'Beach Cleanup',
      eventLocation: 'Park',
      orgName: 'Sarah'
    });

    /**
     * The text part must NOT be HTML-escaped — `&amp;` in a plain-text email is
     * just wrong — and it must not contain literal backslash-n either.
     *
     * That second one was a real defect: the worker did
     * `text += \`\\n\\nLink: ${ctaUrl}\``, which in a template literal emits a
     * backslash followed by "n" rather than a newline, so every notification
     * email's text part read `...\n\nLink: http://...`. The HTML side had the
     * mirror-image bug — `text.replace(/\\n/g, '<br/>')` matched a literal
     * backslash-n, so genuine newlines were never converted.
     */
    expect(mail.text).not.toContain('\\n');
    expect(mail.text).not.toContain('&amp;');
  });
});
