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

export async function sendVerificationEmail(toEmail, token) {
  const verifyLink = `${APP_URL}/?verify=${encodeURIComponent(token)}`;
  
  const mailOptions = {
    from: EMAIL_FROM,
    to: toEmail,
    subject: `Please verify your email - ${APP_NAME}`,
    text: `Welcome to ${APP_NAME}!\n\nPlease verify your email address by clicking the link below:\n${verifyLink}\n\nIf you did not sign up, please ignore this email.`,
    html: `
      <h2>Welcome to ${APP_NAME}!</h2>
      <p>Please verify your email address by clicking the link below:</p>
      <p><a href="${verifyLink}">${verifyLink}</a></p>
      <p>If you did not sign up, please ignore this email.</p>
    `
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
  
  const mailOptions = {
    from: EMAIL_FROM,
    to: toEmail,
    subject: `Password Reset - ${APP_NAME}`,
    text: `We received a request to reset your password.\n\nClick the link below to choose a new password:\n${resetLink}\n\nIf you did not request this, please ignore this email.`,
    html: `
      <h2>Password Reset</h2>
      <p>We received a request to reset your password.</p>
      <p>Click the link below to choose a new password:</p>
      <p><a href="${resetLink}">${resetLink}</a></p>
      <p>If you did not request this, please ignore this email.</p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (err) {
    console.error('Error sending password reset email:', err);
    return false;
  }
}

export async function sendNotificationEmail(toEmail, subject, text, html) {
  const mailOptions = {
    from: EMAIL_FROM,
    to: toEmail,
    subject: `${subject} - ${APP_NAME}`,
    text: `${text}\n\nLog in at ${APP_URL || ''} to see more details.`,
    html: `
      <h2>${subject}</h2>
      <p>${html || text.replace(/\n/g, '<br/>')}</p>
      <p><a href="${APP_URL || ''}">Log in to your account</a></p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (err) {
    console.error('Error sending notification email:', err);
    return false;
  }
}
