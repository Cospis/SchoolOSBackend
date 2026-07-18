const { query } = require('../config/database');
const { encrypt } = require('./crypto');

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  // nodemailer is not installed/available, we will log to console instead
}

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

/**
 * Sends an email or prints it to the console if SMTP is not configured.
 */
async function sendEmail({ to, subject, title, body, actionLink, actionText }) {
  const mailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background-color: #f3f4f6;
          color: #1f2937;
          margin: 0;
          padding: 20px;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background-color: #ffffff;
          border-radius: 12px;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
          overflow: hidden;
        }
        .header {
          background: linear-gradient(135deg, #4f46e5, #06b6d4);
          color: #ffffff;
          padding: 30px 20px;
          text-align: center;
        }
        .header h1 {
          margin: 0;
          font-size: 24px;
          font-weight: 700;
          letter-spacing: -0.025em;
        }
        .content {
          padding: 30px 20px;
          line-height: 1.6;
        }
        .content h2 {
          color: #111827;
          font-size: 18px;
          margin-top: 0;
        }
        .btn-container {
          text-align: center;
          margin: 30px 0;
        }
        .btn {
          background-color: #4f46e5;
          color: #ffffff !important;
          padding: 12px 28px;
          text-decoration: none;
          font-weight: 600;
          border-radius: 8px;
          display: inline-block;
          box-shadow: 0 4px 6px rgba(79, 70, 229, 0.15);
        }
        .footer {
          background-color: #f9fafb;
          padding: 20px;
          text-align: center;
          font-size: 12px;
          color: #6b7280;
          border-top: 1px solid #e5e7eb;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>SchoolOS AI Notification</h1>
        </div>
        <div class="content">
          <h2>${title}</h2>
          <p>${body.replace(/\n/g, '<br>')}</p>
          ${actionLink ? `
            <div class="btn-container">
              <a href="${actionLink}" class="btn" target="_blank">${actionText || 'Proceed'}</a>
            </div>
          ` : ''}
        </div>
        <div class="footer">
          <p>This is an automated message from Greenwood International Academy / SchoolOS AI.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailText = `${title}\n\n${body}\n\n${actionLink ? `${actionText || 'Link'}: ${actionLink}` : ''}`;

  let smtpConfigured = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;

  if (nodemailer && smtpConfigured) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: `"SchoolOS AI" <${process.env.SMTP_USER}>`,
        to,
        subject,
        text: mailText,
        html: mailHtml,
      });

      console.log(`Email successfully sent to ${to} via SMTP: ${subject}`);
      return { success: true, method: 'smtp', nodemailerAvailable: true };
    } catch (err) {
      console.error('SMTP Email sending failed, falling back to console log:', err);
    }
  }

  // Console fallback
  console.log('\n' + '='.repeat(80));
  console.log(`[LOCAL DEV EMAIL EMULATOR]`);
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(`Title:   ${title}`);
  console.log(`Body:\n${body}`);
  if (actionLink) {
    console.log(`Action:  ${actionText || 'Link'} -> ${actionLink}`);
  }
  console.log('='.repeat(80) + '\n');
  return { success: true, method: 'emulator', nodemailerAvailable: !!nodemailer };
}

/**
 * Send an invite or welcome email to a new user.
 */
async function sendNewUserInvite(user, plainTextPassword = 'password123') {
  // Query school name if possible
  let schoolName = 'Greenwood International Academy';
  try {
    const school = await query.get('SELECT name FROM schools WHERE id = ?', [user.school_id || 1]);
    if (school && school.name) {
      schoolName = school.name;
    }
  } catch (err) {
    // Ignore database errors
  }

  const roleLabels = {
    admin: 'Proprietor / Administrator',
    principal: 'Principal',
    bursar: 'Bursar',
    teacher: 'Teacher',
    parent: 'Parent',
    student: 'Student',
  };

  const roleName = roleLabels[user.role] || user.role;

  if (user.invitation_status === 'pending') {
    // Staff setting up their password
    const inviteLink = `${FRONTEND_URL}/?accept-invite=true&token=${encodeURIComponent(encrypt(user.email))}`;
    return await sendEmail({
      to: user.email,
      subject: `Welcome to ${schoolName} - Account Invitation`,
      title: `Hello ${user.name},`,
      body: `You have been registered as a ${roleName} at ${schoolName}.\n\nPlease click the button below to accept the invitation, set up your password, and activate your account.`,
      actionLink: inviteLink,
      actionText: 'Accept Invitation & Set Password',
    });
  } else {
    // Student, Parent or Proprietor receiving login details
    return await sendEmail({
      to: user.email,
      subject: `Welcome to ${schoolName} - Account Created`,
      title: `Hello ${user.name},`,
      body: `Your account has been created successfully at ${schoolName} as a ${roleName}.\n\nYour login details are:\nEmail: ${user.email}\nPassword: ${plainTextPassword}\n\nPlease click the button below to log in.`,
      actionLink: `${FRONTEND_URL}/`,
      actionText: 'Log In Now',
    });
  }
}

async function sendPasswordResetEmail(user) {
  let schoolName = 'Greenwood International Academy';
  try {
    const school = await query.get('SELECT name FROM schools WHERE id = ?', [user.school_id || 1]);
    if (school && school.name) {
      schoolName = school.name;
    }
  } catch (err) {
    // Ignore database errors
  }

  const resetLink = `${FRONTEND_URL}/?reset-password=true&token=${encodeURIComponent(encrypt(user.email))}`;
  return await sendEmail({
    to: user.email,
    subject: `Password Reset Request - ${schoolName}`,
    title: `Hello ${user.name},`,
    body: `We received a request to reset your password for your account at ${schoolName}.\n\nPlease click the button below to choose a new password. If you did not request this, you can safely ignore this email.`,
    actionLink: resetLink,
    actionText: 'Reset Password',
  });
}

module.exports = {
  sendEmail,
  sendNewUserInvite,
  sendPasswordResetEmail,
};
