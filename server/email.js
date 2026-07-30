import nodemailer from 'nodemailer';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const APP_NAME = process.env.APP_NAME || 'WeVolunteer';
const EMAIL_FROM = process.env.EMAIL_FROM || `"${APP_NAME}" <noreply@wevolunteer.org>`;

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
  // The console mock is a development convenience. In production it would print
  // password-reset and verification tokens to the server log and deliver
  // nothing — a silent failure that also leaks credentials. Refuse to boot.
  console.error('FATAL: SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS are required in production).');
  process.exit(1);
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

export const buildHtmlTemplate = (title, contentHTML, ctaText = null, ctaUrl = null) => {
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
                <a href="${ctaUrl}" target="_blank" style="display: inline-block; padding: 12px 24px; font-family: 'Public Sans', sans-serif; font-size: 16px; font-weight: 600; color: #ffffff; background-color: ${brandColor}; text-decoration: none; border-radius: 6px;">${ctaText}</a>
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
  <title>${title}</title>
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
    from: EMAIL_FROM,
    to: toEmail,
    subject: `Please verify your email - ${APP_NAME}`,
    text: `Welcome to ${APP_NAME}!\n\nPlease verify your email address by clicking the link below:\n${verifyLink}\n\nIf you did not sign up, please ignore this email.`,
    html: buildHtmlTemplate('Verify your email', contentHTML, 'Verify Email Address', verifyLink)
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (err) {
    console.error('Error sending verification email:', err);
    return false;
  }
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
    from: EMAIL_FROM,
    to: toEmail,
    subject: `Password Reset - ${APP_NAME}`,
    text: `We received a request to reset your password.\n\nClick the link below to choose a new password:\n${resetLink}\n\nIf you did not request this, please ignore this email.`,
    html: buildHtmlTemplate('Password Reset', contentHTML, 'Reset Password', resetLink)
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (err) {
    console.error('Error sending password reset email:', err);
    return false;
  }
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
    from: EMAIL_FROM,
    to: toEmail,
    subject: `Confirm your new email address - ${APP_NAME}`,
    text: `You asked to use this address for your ${APP_NAME} account.\n\nConfirm it by opening the link below:\n${confirmLink}\n\nThis link expires in 24 hours. If you did not ask for this, ignore this email — nothing will change.`,
    html: buildHtmlTemplate('Confirm your new email address', contentHTML, 'Confirm this address', confirmLink)
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (err) {
    console.error('Error sending email-change confirmation:', err);
    return false;
  }
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
    from: EMAIL_FROM,
    to: toEmail,
    subject: `Security notice: email change requested - ${APP_NAME}`,
    text: `A request was made to move your ${APP_NAME} account to ${masked}.\n\nThe change only takes effect once that address is confirmed.\n\nIf this was not you, sign in and change your password straight away — someone else may have access to your account.`,
    html: buildHtmlTemplate('Email change requested', contentHTML)
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (err) {
    console.error('Error sending email-change notice:', err);
    return false;
  }
}

export async function sendNotificationEmail(toEmail, subject, text, htmlContent) {
  const contentHTML = `
    <h1>${subject}</h1>
    <p>${htmlContent || text.replace(/\n/g, '<br/>')}</p>
  `;

  const loginUrl = APP_URL || 'https://wevolunteer.org';

  const mailOptions = {
    from: EMAIL_FROM,
    to: toEmail,
    subject: `${subject} - ${APP_NAME}`,
    text: `${text}\n\nLog in at ${loginUrl} to see more details.`,
    html: buildHtmlTemplate(subject, contentHTML, 'Log in to your account', loginUrl)
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (err) {
    console.error('Error sending notification email:', err);
    return false;
  }
}

export async function sendMail({ to, subject, text, html }) {
  try {
    await transporter.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      text,
      html
    });
    return true;
  } catch (err) {
    console.error('Error sending mail:', err);
    throw err; // throw to let the worker handle retry
  }
}
