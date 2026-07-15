import nodemailer from 'nodemailer';

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.warn('[consultation] SMTP not configured — skipping send. Set SMTP_HOST, SMTP_USER, SMTP_PASS.');
    return null;
  }
  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass }
  });
}

function mailFrom() {
  return `"CORE Partners Website" <${process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'noreply@corepartnersconsulting.com'}>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fullName, practiceName, specialty, email, phone, challenge, hearAbout, referralName } = req.body || {};

  if (!fullName || !practiceName || !specialty || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const html = `
    <h2>New Discovery Consultation Request</h2>
    <p><strong>Name:</strong> ${escapeHtml(fullName)}</p>
    <p><strong>Practice:</strong> ${escapeHtml(practiceName)}</p>
    <p><strong>Specialty:</strong> ${escapeHtml(specialty)}</p>
    <p><strong>Email:</strong> ${escapeHtml(email)}</p>
    <p><strong>Phone:</strong> ${escapeHtml(phone || 'Not provided')}</p>
    <p><strong>#1 Challenge:</strong> ${escapeHtml(challenge || 'Not provided')}</p>
    <p><strong>How They Heard About Us:</strong> ${escapeHtml(hearAbout || 'Not provided')}</p>
    ${hearAbout === 'Referral' ? `<p><strong>Referred By:</strong> ${escapeHtml(referralName || 'Not provided')}</p>` : ''}
  `;

  const transporter = getTransporter();
  if (!transporter) {
    return res.status(500).json({ error: 'Email is not configured on the server' });
  }

  try {
    await transporter.sendMail({
      from: mailFrom(),
      to: ['david@corepartnersconsulting.com', 'dale@corepartnersconsulting.com'],
      replyTo: email,
      subject: `New Website Request: ${fullName} (${practiceName})`,
      html
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Consultation submit error:', err);
    return res.status(500).json({ error: 'Failed to send email' });
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
