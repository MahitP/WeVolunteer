import nodemailer from 'nodemailer';
import { sendEmail, registerSmtpTransport, describeProviders } from './emailService.js';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const APP_NAME = process.env.APP_NAME || 'WeVolunteer';

/**
 * There is no `EMAIL_FROM` any more, and that is the point.
 *
 * Every message used to leave from one address — the login code, the suspension
 * notice, the privacy-policy update and the shift reminder alike — whose default
 * was `noreply@wevolunteer.org`: a domain one character away from the one this
 * platform actually sends as, and therefore one nothing had ever authorised.
 *
 * The sender is now a function of what the message is. `emailIdentity.js` owns
 * that mapping and enforces the rule that every authentication message leaves
 * from `noreply@wevolunteers.org`. `MAIL_DOMAIN` is the knob a deployment turns.
 *
 * A deployment that still sets `EMAIL_FROM` is told, once, that it no longer
 * does anything — silently ignoring it would mean an operator believing they had
 * changed the sender when they had not.
 */
if (process.env.EMAIL_FROM) {
  console.warn(
    '[Email] EMAIL_FROM is set but no longer used. The sender is chosen per message '
    + 'by server/emailIdentity.js; set MAIL_DOMAIN to change the domain it sends from.'
  );
}

/**
 * Base URL for the links in verification and password-reset emails.
 *
 * In production this must be set explicitly. It used to fall back to
 * `https://wevolunteer.org`, which is the most dangerous kind of default: a
 * deployment that forgot it kept booting and kept sending mail, but every
 * reset link carried a live single-use token to a domain the operator does not
 * control. Nothing failed, nothing logged, and the only symptom was users
 * reporting that reset links "don't work".
 *
 * Development keeps the convenient localhost default — there is no token to
 * misdirect when the mail transport is the console mock.
 */
const APP_URL = process.env.APP_URL || (IS_PRODUCTION ? null : 'http://localhost:5173');

let transporter;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT == 465, // true for 465, false for other ports
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  console.log(`[Email] Configured to send via ${SMTP_HOST}`);
} else if (IS_PRODUCTION) {
  /**
   * The console mock is a development convenience. In production it would print
   * password-reset and verification tokens to the server log and deliver
   * nothing — a silent failure that also leaks credentials.
   *
   * SMTP is no longer the only way out, though. Since Resend became the primary
   * provider, a deployment that configures Resend and no SMTP is a legitimate
   * choice — it simply has no emergency fallback. So the refusal is now "no
   * provider at all", not "no SMTP", and the no-fallback case gets a warning
   * loud enough to be a decision rather than an accident.
   *
   * `transporter` is deliberately left undefined here: the SMTP provider then
   * reports itself unconfigured and is skipped, which is very different from
   * quietly substituting the mock and logging every token to stdout.
   */
  if (!process.env.RESEND_API_KEY) {
    console.error(
      'FATAL: no email provider is configured. Set RESEND_API_KEY (preferred), or '
      + 'SMTP_HOST, SMTP_USER and SMTP_PASS, or both. Production refuses to boot '
      + 'without a way to send verification and password-reset mail.'
    );
    process.exit(1);
  }
  console.warn(
    '[Email] SMTP is not configured, so there is no fallback provider. If Resend '
    + 'is unavailable, mail will go to the durable outbox and wait there.'
  );
} else {
  // Fallback to console logger for development
  transporter = {
    sendMail: async (mailOptions) => {
      console.log('\n=================== EMAIL SENT ===================');
      console.log(`To:      ${mailOptions.to}`);
      console.log(`Subject: ${mailOptions.subject}`);
      console.log(`--------------------------------------------------`);
      console.log(mailOptions.text);
      console.log('==================================================\n');
      return { messageId: 'mock-id-' + Date.now() };
    }
  };
  console.log('[Email] Running in mock mode. Emails will be logged to console.');
}

/* The transport chosen above, kept so `setMailTransportForTests` can put it
   back. Captured once, at module load, before any test can have replaced it. */
const realTransporter = transporter;

// Checked after the SMTP transport so the order of startup failures stays
// stable: JWT_SECRET (config.js) -> SMTP -> APP_URL. An operator fixes them in
// that order, and the runbook documents it that way.
if (IS_PRODUCTION && !APP_URL) {
  console.error(
    'FATAL: APP_URL must be set in production. It is the base URL for password-reset '
    + 'and email-verification links; without it those links point at a domain the '
    + 'deployment does not control and leak single-use tokens. '
    + 'Example: APP_URL=https://volunteers.example.org'
  );
  process.exit(1);
}

/**
 * And it has to be a URL, not merely a non-empty string.
 *
 * ── Why presence was not enough ──
 *
 * This value is concatenated into every password-reset and email-verification
 * link. A trailing typo, a missing scheme, or a copied shell variable that never
 * expanded all pass a truthiness check and then mail a live single-use token to
 * an address nobody controls — which is the exact harm the guard above is
 * written to prevent, arriving through the door it left open.
 *
 * `OAUTH_REDIRECT_URI` five files away gets a full parse, a loopback refusal and
 * a scheme check. The link that carries a password-reset token deserves at least
 * as much.
 *
 * http is refused in production rather than warned about: these links carry
 * credentials, and a plaintext one is interceptable on any network the recipient
 * happens to open their mail on.
 */
if (IS_PRODUCTION && APP_URL) {
  let parsed = null;
  try { parsed = new URL(APP_URL); } catch { parsed = null; }

  if (!parsed) {
    console.error(
      `FATAL: APP_URL is not a valid absolute URL (${APP_URL}). It is the base of every `
      + 'password-reset and verification link. Example: APP_URL=https://volunteers.example.org'
    );
    process.exit(1);
  }
  if (parsed.protocol !== 'https:') {
    console.error(
      `FATAL: APP_URL must use https in production (got ${parsed.protocol}//). These links `
      + 'carry single-use credentials and must not travel in plaintext.'
    );
    process.exit(1);
  }
}

/**
 * Health record for TRANSACTIONAL mail (verification, reset, email change).
 *
 * ── Why this exists ──
 *
 * These four messages caught their own errors, logged a line, and returned `false`.
 * Every caller ignores that return value on purpose, because the API answers
 * `{success:true}` regardless so `forgot-password` cannot leak whether an address
 * exists. Only NOTIFICATION mail goes through the `notification_jobs` outbox and
 * gets retries and a status column; these had neither.
 *
 * So during an SMTP incident: students never receive a verification link,
 * `/api/admin/system/status` still reports `smtpConfigured: true` — that check only
 * looks at whether the env vars are set — and nothing records that mail is failing.
 * With REQUIRE_EMAIL_VERIFICATION defaulting to ON, silent verification failure
 * means silent lockout.
 *
 * Deliberately in-process and not persisted: it answers "is mail working right
 * now", which is what an operator asks during an incident. Durable per-message
 * tracking is the outbox's job, and duplicating it here would be a second source of
 * truth to keep in step.
 *
 * The recipient's local part is never stored — see recordFailure.
 */
const mailHealth = {
  failures: 0,
  successes: 0,
  lastSuccessAt: null,
  lastError: null,
  attemptsOnLastFailure: 0,
  /* Held by the outbox rather than delivered. Not a failure — the message is
     still going — but an operator watching this number climb is watching an
     incident, and it used to be indistinguishable from healthy. */
  queued: 0,
  /* Undeliverable for good: a bad address, or a provider's outright refusal.
     Retrying these is what turns a typo into five wasted attempts. */
  permanentFailures: 0,
  /* We could not RENDER the message. Counted apart from everything else because
     the fix is in this repository, not at a provider. */
  templateFailures: 0,
  /* Which provider carried the last successful message. Diagnostic only — no
     caller branches on it, and none should. */
  lastProvider: null
};

/**
 * The SMTP transport belongs to this module — it is built here, guarded at boot
 * here, and swapped by `setMailTransportForTests` here. The service is handed
 * getters rather than the transport itself so that a test swap is visible to it;
 * a captured reference would keep sending through the real relay.
 */
registerSmtpTransport(
  () => transporter,
  () => Boolean(transporter)
);

/* `MAIL_MAX_ATTEMPTS` and `MAIL_RETRY_DELAY_MS` still exist and still mean what
   they meant — they now govern how hard ONE provider is tried before the
   fallback takes over, and they live in emailService.js beside the loop that
   reads them. */

/** Current transactional-mail health, for the admin status endpoint. */
export function getMailHealth() {
  return {
    ...mailHealth,
    smtpConfigured: Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS),
    /* Whether each provider is configured — never anything about the key
       itself. `describeProviders` exists precisely so this line cannot grow
       into one that reports a secret. */
    providers: describeProviders(),
  };
}

/** Test seam: resets the counters between cases. */
/**
 * Replaces the mail transport, for tests only.
 *
 * The alternative is `vi.doMock` on this module, and it does not work for the
 * callers that matter: routes import email.js DYNAMICALLY inside the handler, so
 * by the time a test registers a mock the module is already resolved and cached
 * and the mock is silently ignored — a delivery-failure test that passes without
 * ever simulating a failure. A seam that plainly does what it says is better than
 * a mock that quietly does nothing.
 *
 * Refuses to run in production. This is the one function here that could turn
 * real delivery off, so it is not left to a convention about who calls it.
 *
 * @param {object|null} t  a `{ sendMail }` object, or null to restore the real one
 */
export function setMailTransportForTests(t) {
  if (IS_PRODUCTION) throw new Error('setMailTransportForTests is not available in production');
  transporter = t ?? realTransporter;
}

export function resetMailHealthForTests() {
  mailHealth.failures = 0;
  mailHealth.successes = 0;
  mailHealth.lastSuccessAt = null;
  mailHealth.lastError = null;
  mailHealth.attemptsOnLastFailure = 0;
  mailHealth.queued = 0;
  mailHealth.permanentFailures = 0;
  mailHealth.templateFailures = 0;
  mailHealth.lastProvider = null;
}

/**
 * Sends a transactional message, retrying a transient failure.
 *
 * A single attempt was enough to lose a student's verification link to a momentary
 * relay hiccup — and because the flag that gates their account defaults on, losing
 * that one message locks them out until they find the resend button. Three attempts
 * with a short linear backoff covers the common transient cases (ETIMEDOUT,
 * ECONNRESET, a relay's brief 4xx) without letting a signup request hang on a relay
 * that is genuinely down.
 *
 * `flow` is recorded rather than a generic "mail failed", because the flows have
 * different consequences: a failed reset is an annoyance, a failed verification is a
 * lockout, and a failed email-change notice is a missed security warning.
 */
/**
 * Flows for which a LATE delivery is worse than none.
 *
 * A login code is valid for ten minutes and is invalidated the moment the person
 * asks for another one. Queueing it means the code arrives after the user has
 * already given up and requested a second — so they receive two messages, one of
 * which is dead, and the one that looks newest may be the one that no longer
 * works. Better to fail the request honestly and let them press the button.
 */
const NEVER_QUEUE = new Set(['2fa-code']);

async function sendTransactional(flow, mailOptions, { event = null, idempotencyKey } = {}) {
  let result;
  try {
    result = await sendEmail(
      {
        to: mailOptions.to,
        subject: mailOptions.subject,
        text: mailOptions.text,
        html: mailOptions.html,
      },
      { flow, event, idempotencyKey, queueOnFailure: !NEVER_QUEUE.has(flow) }
    );
  } catch (err) {
    /**
     * `EmailApplicationError` — we could not build the message. That is a bug in
     * a template, not a delivery problem, and it must not be filed as one: a
     * provider failure sends whoever is on call to a provider dashboard, and
     * this one would show everything healthy.
     */
    if (err?.name === 'EmailApplicationError') {
      mailHealth.templateFailures++;
      mailHealth.lastError = { flow, at: new Date().toISOString(), category: 'application' };
      console.error(`[Email] ${flow} could not be rendered: ${err.message}`);
      throw err;
    }
    throw err;
  }

  if (result.delivered) {
    mailHealth.successes++;
    mailHealth.lastSuccessAt = new Date().toISOString();
    mailHealth.lastProvider = result.provider;
    return true;
  }

  /* The classified category says what KIND of failure it was; the provider's own
     message says which one, which is what an operator actually greps for
     ("ECONNREFUSED", "429"). Both are kept. The provider messages are built in
     emailProviders.js from codes and statuses only, so no recipient address
     travels in here. */
  const detail = result.error?.message ? `${result.category}: ${result.error.message}` : String(result.category);

  if (result.queued) {
    /* Not delivered, but not lost either — the outbox holds it and the worker
       will keep trying. The caller is told `true` because the message WILL go;
       "check your email" remains an honest thing to say. */
    mailHealth.queued++;
    recordFailure(flow, mailOptions.to, { message: `queued (${detail})` }, 1);
    console.warn(`[Email] ${flow} could not be delivered now (${result.category}); queued.`);
    return true;
  }

  if (result.permanent) {
    mailHealth.permanentFailures++;
    recordFailure(flow, mailOptions.to, { message: `permanent (${detail})` }, 1);
    return false;
  }

  recordFailure(flow, mailOptions.to, { message: detail }, 1);
  return false;
}

/**
 * Records a permanent failure.
 *
 * Only the recipient's DOMAIN is kept. The domain is what diagnoses a relay or
 * SPF problem; the local part identifies a specific child, and this record is
 * exposed on an admin endpoint and written to the journal. Support can still find
 * the account from the flow and timestamp.
 */
function recordFailure(flow, to, err, attempts) {
  const domain = String(to || '').split('@')[1] || null;
  mailHealth.failures++;
  mailHealth.attemptsOnLastFailure = attempts;
  mailHealth.lastError = {
    flow,
    message: err ? String(err.message) : 'unknown',
    recipientDomain: domain,
    at: new Date().toISOString()
  };
  console.error(
    `[Email] ${flow} FAILED permanently after ${attempts} attempts `
    + `(recipient domain: ${domain || 'unknown'}): ${err ? err.message : 'unknown'}`
  );
}

/**
 * Escapes text for interpolation into an HTML email.
 *
 * ── Why outbound mail needs this ──
 *
 * Notification emails interpolated raw database values — event titles, locations,
 * organizer names, the recipient's own name — straight into the template. Titles
 * and locations are free text typed by an organizer.
 *
 * Mail clients do not run `<script>`, so this is not XSS in the browser sense. The
 * realistic payload is a link: an event titled
 *
 *     Beach Cleanup <a href="https://evil.example/login">Confirm your account</a>
 *
 * produces a phishing anchor inside genuine WeVolunteer mail, sent from the
 * district's domain, passing its SPF and DKIM, to every student on the shift. That
 * needs no script execution to work, and on a platform for minors it is the
 * consequence that matters.
 *
 * Escaping at render rather than at rest matches what the app already does on the
 * web surface, where message bodies are stored raw and escaped by React on output.
 *
 * The ampersand is replaced FIRST. Any other order re-encodes the escapes this
 * function has just written, and the recipient sees `&lt;` as literal text.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the shared email chrome.
 *
 * `title` and `ctaUrl` are escaped here because they land in `<title>` and in an
 * `href` attribute respectively — positions where unescaped input breaks out of
 * its context. `contentHTML` is deliberately NOT escaped: it is markup the
 * application composes from its own templates, and escaping it would render every
 * email as its own source. Callers are responsible for escaping the user-supplied
 * values they interpolate into it, which is what `escapeHtml` above is for.
 */
export const buildHtmlTemplate = (title, contentHTML, ctaText = null, ctaUrl = null) => {
  const safeTitle = escapeHtml(title);
  const safeCtaUrl = escapeHtml(ctaUrl);
  const safeCtaText = escapeHtml(ctaText);
  const brandColor = '#0f6b45';
  const paperColor = '#f7f7f5';
  const inkColor = '#14231c';
  const inkMuted = '#66736d';
  
  const ctaButtonHTML = ctaText && ctaUrl ? `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin-top: 24px;">
      <tr>
        <td align="left">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <a href="${safeCtaUrl}" target="_blank" style="display: inline-block; padding: 12px 24px; font-family: 'Public Sans', sans-serif; font-size: 16px; font-weight: 600; color: #ffffff; background-color: ${brandColor}; text-decoration: none; border-radius: 6px;">${safeCtaText}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  ` : '';

  return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>${safeTitle}</title>
  <style>
    html, body {
      margin: 0 auto !important;
      padding: 0 !important;
      height: 100% !important;
      width: 100% !important;
      background: ${paperColor};
      font-family: 'Public Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
      color: ${inkColor};
    }
    * {
      -ms-text-size-adjust: 100%;
      -webkit-text-size-adjust: 100%;
    }
    table, td {
      mso-table-lspace: 0pt !important;
      mso-table-rspace: 0pt !important;
    }
    img {
      -ms-interpolation-mode:bicubic;
    }
    a {
      text-decoration: none;
      color: ${brandColor};
    }
    a:hover {
      text-decoration: underline;
    }
    .wrapper {
      width: 100%;
      table-layout: fixed;
      background-color: ${paperColor};
      padding-bottom: 40px;
    }
    .main {
      background: #ffffff;
      margin: 0 auto;
      width: 100%;
      max-width: 600px;
      border-radius: 8px;
      border: 1px solid #e4e7e5;
      overflow: hidden;
      margin-top: 40px;
    }
    .header {
      padding: 32px 32px 0 32px;
      text-align: left;
    }
    .brand-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      background: ${brandColor};
      color: #ffffff;
      border-radius: 8px;
      font-family: 'Bricolage Grotesque', sans-serif;
      font-weight: 700;
      font-size: 20px;
      letter-spacing: -0.5px;
      text-decoration: none !important;
    }
    .content {
      padding: 24px 32px 32px 32px;
      font-size: 16px;
      line-height: 1.5;
    }
    .content h1 {
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 24px;
      font-weight: 600;
      margin-top: 0;
      margin-bottom: 16px;
      color: ${inkColor};
    }
    .content p {
      margin-top: 0;
      margin-bottom: 16px;
    }
    .footer {
      text-align: center;
      padding: 24px;
      font-size: 14px;
      color: ${inkMuted};
    }
    @media (prefers-color-scheme: dark) {
      html, body {
        background: #111 !important;
        color: #eee !important;
      }
      .wrapper {
        background-color: #111 !important;
      }
      .main {
        background: #1e1e1e !important;
        border-color: #333 !important;
      }
      .content h1, .content p {
        color: #eee !important;
      }
      .footer {
        color: #888 !important;
      }
    }
  </style>
</head>
<body width="100%" style="margin: 0; padding: 0 !important; mso-line-height-rule: exactly; background-color: ${paperColor};">
  <center style="width: 100%; background-color: ${paperColor};">
    <div class="wrapper">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" width="100%" style="max-width: 600px;">
        <tr>
          <td>
            <table class="main" role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
              <tr>
                <td class="header">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                    <tr>
                      <td style="background-color: ${brandColor}; border-radius: 8px; width: 48px; height: 48px; text-align: center; vertical-align: middle;">
                        <span style="color: #ffffff; font-family: 'Arial', sans-serif; font-size: 20px; font-weight: bold; letter-spacing: -0.5px; line-height: 48px;">WV</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td class="content">
                  ${contentHTML}
                  ${ctaButtonHTML}
                </td>
              </tr>
            </table>
            
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
              <tr>
                <td class="footer">
                  <p style="margin: 0;">&copy; ${new Date().getFullYear()} ${APP_NAME}</p>
                  <p style="margin: 8px 0 0 0;">This email was sent by ${APP_NAME}.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  </center>
</body>
</html>
  `;
};

export async function sendVerificationEmail(toEmail, token) {
  const verifyLink = `${APP_URL}/?verify=${encodeURIComponent(token)}`;
  
  const contentHTML = `
    <h1>Verify your email</h1>
    <p>Welcome to <strong>${APP_NAME}</strong>!</p>
    <p>Please verify your email address by clicking the button below to complete your registration.</p>
    <p style="color: #66736d; font-size: 14px;">If you did not sign up for an account, please safely ignore this email.</p>
  `;

  const mailOptions = {
    to: toEmail,
    subject: `Please verify your email - ${APP_NAME}`,
    text: `Welcome to ${APP_NAME}!\n\nPlease verify your email address by clicking the link below:\n${verifyLink}\n\nIf you did not sign up, please ignore this email.`,
    html: buildHtmlTemplate('Verify your email', contentHTML, 'Verify Email Address', verifyLink)
  };

  return sendTransactional('verification', mailOptions);
}

/**
 * The administrator invitation link (IV-4).
 *
 * Composed here rather than in the route because `APP_URL` lives here, alongside
 * every other link this application sends — and because the boot guard that
 * refuses to start in production without it is in this file. A route that built
 * its own link would be the one link with no guard behind it.
 *
 * The copy leads with what the role IS, not with congratulations. Somebody
 * accepting this gains the ability to read safety reports and suspend accounts on
 * a platform used mostly by under-18s, and the message they decide from should say
 * so plainly.
 */
export async function sendAdminInvitationEmail(toEmail, token) {
  const link = `${APP_URL}/accept-invitation?token=${encodeURIComponent(token)}`;

  const contentHTML = `
    <h1>You have been invited to help moderate ${APP_NAME}</h1>
    <p>A platform owner has invited you to become an <strong>administrator</strong>.</p>
    <p>Administrators review safety reports and can suspend accounts. It is a position
       of trust on a platform used mostly by under-18s.</p>
    <p>To accept, sign in with <strong>this</strong> email address and open the link below.
       It works once and expires in seven days.</p>
    <p style="color: #66736d; font-size: 14px;">If you were not expecting this, ignore it —
       nothing happens unless you accept.</p>
  `;

  return sendTransactional('admin-invitation', {
    to: toEmail,
    subject: `You have been invited to help moderate ${APP_NAME}`,
    text: [
      `A ${APP_NAME} platform owner has invited you to become an administrator.`,
      '',
      'Administrators review safety reports and can suspend accounts. It is a position',
      'of trust on a platform used mostly by under-18s.',
      '',
      'To accept, sign in with THIS email address and open:',
      link,
      '',
      'The link works once and expires in seven days. If you were not expecting this,',
      'ignore it — nothing happens unless you accept.',
    ].join('\n'),
    html: buildHtmlTemplate('You have been invited to help moderate', contentHTML, 'Accept the invitation', link),
  });
}

export async function sendPasswordResetEmail(toEmail, token) {
  const resetLink = `${APP_URL}/?reset=${encodeURIComponent(token)}`;
  
  const contentHTML = `
    <h1>Password Reset</h1>
    <p>We received a request to reset the password for your <strong>${APP_NAME}</strong> account.</p>
    <p>Click the button below to choose a new password.</p>
    <p style="color: #66736d; font-size: 14px;">If you did not request a password reset, please safely ignore this email. Your password will not change.</p>
  `;

  const mailOptions = {
    to: toEmail,
    subject: `Password Reset - ${APP_NAME}`,
    text: `We received a request to reset your password.\n\nClick the link below to choose a new password:\n${resetLink}\n\nIf you did not request this, please ignore this email.`,
    html: buildHtmlTemplate('Password Reset', contentHTML, 'Reset Password', resetLink)
  };

  return sendTransactional('password-reset', mailOptions);
}

/**
 * Confirmation link for a pending email-address change, sent to the NEW address.
 *
 * The change does not take effect until this link is opened, so the whole flow
 * rests on this mail reaching a mailbox the person can actually read — which is
 * the same proof of control the welcome link asks for.
 */
export async function sendEmailChangeConfirmation(toEmail, token) {
  const confirmLink = `${APP_URL}/?emailchange=${encodeURIComponent(token)}`;

  const contentHTML = `
    <h1>Confirm your new email address</h1>
    <p>You asked to use this address for your <strong>${APP_NAME}</strong> account.</p>
    <p>Click the button below to confirm it. Until you do, your account keeps its old address.</p>
    <p style="color: #66736d; font-size: 14px;">This link expires in 24 hours. If you did not ask for this, you can safely ignore this email — nothing will change.</p>
  `;

  const mailOptions = {
    to: toEmail,
    subject: `Confirm your new email address - ${APP_NAME}`,
    text: `You asked to use this address for your ${APP_NAME} account.\n\nConfirm it by opening the link below:\n${confirmLink}\n\nThis link expires in 24 hours. If you did not ask for this, ignore this email — nothing will change.`,
    html: buildHtmlTemplate('Confirm your new email address', contentHTML, 'Confirm this address', confirmLink)
  };

  return sendTransactional('email-change-confirm', mailOptions);
}

/**
 * Heads-up to the OLD address that a change was requested. Carries no link.
 *
 * This is the security-critical half of the flow and is not optional. If someone
 * with a stolen session moves the account to an address they control, the only
 * person who can notice is whoever still reads the old mailbox — and the only
 * way they can notice is if we tell them. Deliberately no action link: the safe
 * response is to change the password, which they reach through the app.
 *
 * The new address is partly masked. The owner of the old mailbox needs to know
 * that a change is pending and roughly where to, not to be handed a third
 * party's full address by an automated mail.
 */
export async function sendEmailChangeNotice(toEmail, newEmail) {
  const [local, domain] = String(newEmail).split('@');
  const masked = `${local.slice(0, 2)}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`;

  const contentHTML = `
    <h1>Someone asked to change your email address</h1>
    <p>A request was made to move your <strong>${APP_NAME}</strong> account to <strong>${masked}</strong>.</p>
    <p>The change only takes effect once that address is confirmed. This address is still on the account until then.</p>
    <p><strong>If this was not you</strong>, sign in and change your password straight away — someone else may have access to your account.</p>
  `;

  const mailOptions = {
    to: toEmail,
    subject: `Security notice: email change requested - ${APP_NAME}`,
    text: `A request was made to move your ${APP_NAME} account to ${masked}.\n\nThe change only takes effect once that address is confirmed.\n\nIf this was not you, sign in and change your password straight away — someone else may have access to your account.`,
    html: buildHtmlTemplate('Email change requested', contentHTML)
  };

  return sendTransactional('email-change-notice', mailOptions);
}

export async function sendNotificationEmail(toEmail, subject, text, htmlContent) {
  const contentHTML = `
    <h1>${escapeHtml(subject)}</h1>
    <p>${htmlContent || text.replace(/\n/g, '<br/>')}</p>
  `;

  /* No `|| 'https://wevolunteer.org'` here any more. That fallback was the same
     wrong-domain default the block at the top of this file was written to
     remove, surviving in a second place — and unlike the one that was removed,
     this one shipped a working-looking link to a domain nobody owns. Production
     cannot reach an empty APP_URL: boot refuses without it. */
  const loginUrl = APP_URL;

  const mailOptions = {
    to: toEmail,
    subject: `${subject} - ${APP_NAME}`,
    text: `${text}\n\nLog in at ${loginUrl} to see more details.`,
    html: buildHtmlTemplate(subject, contentHTML, 'Log in to your account', loginUrl)
  };

  return sendTransactional('notification-direct', mailOptions);
}

/**
 * Send a message whose retry somebody else owns.
 *
 * ── What this used to be, and why it mattered ──
 *
 * This function called `transporter.sendMail` directly. It was the ONE send
 * path in the codebase that never touched the retry logic, never touched the
 * health counters, and — once Resend arrived — would have been the one path
 * that never touched the primary provider either. Both of its callers are
 * significant: the notification outbox worker, and the operator error-alert
 * digest. So the rule "the provider is an implementation detail" would have
 * been true of every send in the repository except the two that run on a timer
 * without anybody watching.
 *
 * It now goes through the same service as everything else. What stays different
 * is deliberate: `queueOnFailure` is false and a failure THROWS, because these
 * callers already have durability of their own — the worker has the outbox row
 * it is currently processing, and enqueueing a second copy from underneath it
 * would be the duplicate-send the queue exists to prevent.
 *
 * @param {object} opts
 * @param {string} [opts.flow]   identity category; defaults to notification mail
 * @param {string} [opts.event]  notification event name, so an enforcement or
 *                               legal notice is sent under the right identity
 */
export async function sendMail({ to, subject, text, html, flow = 'notification', event = null }) {
  const result = await sendEmail({ to, subject, text, html }, {
    flow,
    event,
    queueOnFailure: false,
  });

  if (result.delivered) {
    mailHealth.successes++;
    mailHealth.lastSuccessAt = new Date().toISOString();
    mailHealth.lastProvider = result.provider;
    return true;
  }

  if (result.permanent) mailHealth.permanentFailures++;
  recordFailure(flow, to, { message: String(result.category) }, 1);

  /* Throwing is the contract the callers were written against: the worker
     catches this and schedules its own next attempt. The message text carries
     the classified category and nothing about the recipient. */
  const err = new Error(`mail delivery failed (${result.category})`);
  err.category = result.category;
  err.permanent = Boolean(result.permanent);
  throw err;
}

export async function send2FACode(to, code) {
  const contentHTML = `
    <h1>Your verification code</h1>
    <p>Your verification code is: <strong>${escapeHtml(code)}</strong></p>
    <p>This code expires in 10 minutes.</p>
    <p style="color: #66736d; font-size: 14px;">If you did not request this code, you can safely ignore this email.</p>
  `;

  const mailOptions = {
    to,
    subject: `Your ${APP_NAME} verification code`,
    text: `Your verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, you can safely ignore this email.`,
    html: buildHtmlTemplate('Your verification code', contentHTML)
  };

  return sendTransactional('2fa-code', mailOptions);
}
