import nodemailer from 'nodemailer';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const APP_NAME = process.env.APP_NAME || 'SBVolunteers';
const EMAIL_FROM = process.env.EMAIL_FROM || `"${APP_NAME}" <noreply@sbvolunteers.org>`;

const APP_URL = process.env.APP_URL || (IS_PRODUCTION ? 'https://sbvolunteers.org' : 'http://localhost:5173');

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
