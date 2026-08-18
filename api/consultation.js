import nodemailer from 'nodemailer';
import {
  verifyFormToken, verifyTurnstile, spamScore, isBurstDuplicate,
  DROP_SCORE, FLAG_SCORE
} from './_antibot.js';

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

// Per-IP cap. This form emails David and Dale on every submission, so without
// a cap a script can bury both inboxes. Memory is per serverless instance, so
// this is a deterrent rather than a guarantee — the signed token, honeypot and
// content scoring below are what actually stop the scripted submitters.
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fullName, practiceName, specialty, email, phone, challenge, hearAbout, referralName,
          hpWebsite, formToken, turnstileToken } = req.body || {};

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip'] || 'unknown';

  // Two tiers, because a missed lead costs far more than an extra spam email.
  //
  //   discard()    — signals a real person essentially cannot trip: they filled
  //                  an invisible field, forged a signature, or replayed a
  //                  token. Silent, nothing sent.
  //   quarantine() — judgement calls that CAN misfire on a genuine visitor:
  //                  a failed CAPTCHA, a page left open too long, an unusual
  //                  name or a dotted Gmail address. These are still delivered,
  //                  clearly labelled, so nothing real is ever lost.
  //
  // Both answer with the same success shape a person gets, so a scripted
  // submitter gets no signal to adapt to.
  const accept = () => res.status(200).json({ ok: true });
  const discard = (reason) => {
    console.warn('[consultation] discarded (certain bot):', { reason, ip, email });
    return accept();
  };

  // Set when something looked wrong but not conclusively automated.
  let filteredReason = null;
  const quarantine = (reason) => { filteredReason = filteredReason ?? reason; };

  if (hpWebsite && String(hpWebsite).trim() !== '') return discard('honeypot');

  // A forged or reused token means someone built the request by hand. A missing
  // or stale one just means a cached page, a failed token fetch, or a visitor
  // who left the tab open — all things real people do.
  const FORGED = new Set(['malformed-token', 'bad-signature', 'bad-timestamp', 'replayed-token']);
  const tokenProblem = verifyFormToken(formToken);
  if (tokenProblem) {
    if (FORGED.has(tokenProblem)) return discard(tokenProblem);
    quarantine(tokenProblem);
  }

  // Real people fail CAPTCHAs — privacy browsers, VPNs, screen readers.
  const captchaProblem = await verifyTurnstile(turnstileToken, ip);
  if (captchaProblem) quarantine(captchaProblem);

  if (!fullName || !practiceName || !specialty || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const score = spamScore({ fullName, practiceName, challenge, referralName, email });
  console.log('[consultation] scored:', { score, email, filteredReason });
  if (score >= DROP_SCORE) quarantine(`content-score-${score}`);

  // The bots arrive in threes; the same sender only needs to land once. Losing
  // an exact duplicate costs nothing — the first one was already delivered.
  if (isBurstDuplicate(email)) return discard('duplicate-burst');

  if (!withinRateLimit(ip)) {
    console.warn('[consultation] rate limit hit — dropped:', { ip });
    return res.status(429).json({ error: 'Too many requests. Please email us directly.' });
  }

  // Anything that tripped a judgement call, plus middling scores, reaches the
  // inbox labelled rather than being thrown away.
  const suspicious = filteredReason !== null || score >= FLAG_SCORE;
  const suspicionNote = filteredReason
    ? `<p style="background:#f8d7da;border-left:4px solid #a3352b;padding:10px;">
         <strong>&#9888; Caught by a spam check (${escapeHtml(filteredReason)})</strong> — delivered anyway
         so a real enquiry is never lost. Score ${score}. Verify before replying.</p>`
    : score >= FLAG_SCORE
    ? `<p style="background:#fff3cd;border-left:4px solid #d79b4b;padding:10px;">
         <strong>&#9888; Possible spam</strong> — this submission scored ${score} on our
         automated checks. Verify before replying.</p>`
    : '';

  const html = `
    <h2>New Discovery Consultation Request</h2>
    ${suspicionNote}
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
      subject: `${filteredReason ? '[Filtered] ' : suspicious ? '[Possible Spam] ' : ''}New Website Request: ${fullName} (${practiceName})`,
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
