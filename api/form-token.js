import { createFormToken, turnstileSiteKey } from './_antibot.js';

// Called when the consultation form comes into view. Hands the browser a
// short-lived signed token that the submit endpoint requires, plus the
// Turnstile site key if a CAPTCHA is configured.
export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    token: createFormToken(),
    turnstileSiteKey: turnstileSiteKey()
  });
}
