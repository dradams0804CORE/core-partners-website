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

// Per-IP cap. This form emails David and Dale on every submission with no
// CAPTCHA in front of it, so without a cap a script can bury both inboxes.
// Memory is per serverless instance, so this is a deterrent rather than a
// guarantee — paired with the honeypot and timing checks below, which catch
// the scripted submitters that matter.
const DAILY_LIMIT_PER_IP = 5;
const submissionLog = new Map();

function withinRateLimit(ip) {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const recent = (submissionLog.get(ip) || []).filter((t) => t > dayAgo);
  if (recent.length >= DAILY_LIMIT_PER_IP) {
    submissionLog.set(ip, recent);
    return false;
  }
  recent.push(now);
  submissionLog.set(ip, recent);
  return true;
}

// A person takes at least a few seconds to fill this in; scripted posts don't.
const MIN_FORM_SECONDS = 3;

function looksLikeBot(honeypot, formStartedAt) {
  if (honeypot && String(honeypot).trim() !== '') return true;
  if (!formStartedAt) return false; // older cached page, no stamp — let it through
  return (Date.now() - Number(formStartedAt)) / 1000 < MIN_FORM_SECONDS;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fullName, practiceName, specialty, email, phone, challenge, hearAbout, referralName,
          hpWebsite, formStartedAt } = req.body || {};

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip'] || 'unknown';

  // Answer a bot with the same success shape a person gets, so a scripted
  // submitter has no signal to adapt to. Nothing is sent.
  if (looksLikeBot(hpWebsite, formStartedAt)) {
    console.warn('[consultation] submission flagged as bot — dropped:', { ip });
    return res.status(200).json({ ok: true });
  }

  if (!withinRateLimit(ip)) {
    console.warn('[consultation] rate limit hit — dropped:', { ip });
    return res.status(429).json({ error: 'Too many requests. Please email us directly.' });
  }

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
