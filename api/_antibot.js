import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Signed form tokens
//
// The old timing check trusted a `formStartedAt` value the browser sent us,
// which a script can simply set to whatever it likes. This replaces it: the
// server issues a signed, timestamped token when the page loads, and only
// accepts a submission carrying a token it actually signed. A bot that POSTs
// straight to the endpoint has nothing valid to send.
// ---------------------------------------------------------------------------

const MIN_FILL_SECONDS = 6;              // faster than any human filling 8 fields
const MAX_TOKEN_AGE_SECONDS = 6 * 3600;  // page left open all afternoon is fine

function secret() {
  return process.env.FORM_TOKEN_SECRET || '';
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createFormToken() {
  if (!secret()) return null;
  const payload = `${Date.now()}.${crypto.randomBytes(9).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

// Tokens are single-use. The bots arrive in bursts of three, so a replayed
// token is itself a signal worth catching.
const usedTokens = new Map();

function rememberToken(token) {
  const now = Date.now();
  for (const [t, seen] of usedTokens) {
    if (now - seen > MAX_TOKEN_AGE_SECONDS * 1000) usedTokens.delete(t);
  }
  if (usedTokens.has(token)) return false;
  usedTokens.set(token, now);
  return true;
}

// Returns null when the token is good, or a short reason string when it isn't.
export function verifyFormToken(token) {
  if (!secret()) return null; // not configured — do not block real visitors
  if (!token || typeof token !== 'string') return 'missing-token';

  const parts = token.split('.');
  if (parts.length !== 3) return 'malformed-token';

  const [issuedAt, nonce, mac] = parts;
  const expected = sign(`${issuedAt}.${nonce}`);
  if (mac.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return 'bad-signature';
  }

  const ageSeconds = (Date.now() - Number(issuedAt)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return 'bad-timestamp';
  if (ageSeconds < MIN_FILL_SECONDS) return 'too-fast';
  if (ageSeconds > MAX_TOKEN_AGE_SECONDS) return 'expired-token';
  if (!rememberToken(token)) return 'replayed-token';

  return null;
}

// ---------------------------------------------------------------------------
// Cloudflare Turnstile (optional — active only once the keys are set)
// ---------------------------------------------------------------------------

export function turnstileSiteKey() {
  return process.env.TURNSTILE_SITE_KEY || null;
}

export async function verifyTurnstile(token, ip) {
  if (!process.env.TURNSTILE_SECRET_KEY) return null; // not configured
  if (!token) return 'missing-captcha';
  try {
    const body = new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET_KEY,
      response: token
    });
    if (ip && ip !== 'unknown') body.set('remoteip', ip);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const result = await res.json();
    return result.success ? null : 'captcha-failed';
  } catch (err) {
    // Cloudflare being unreachable must never cost us a real lead.
    console.error('[antibot] Turnstile verification error:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Content scoring
//
// The spam we get is machine-generated filler — "Lxrqxnnvt",
// "pHFeNeRDtZgfNeVcCbQAye" — which reads nothing like a practice name a person
// typed. Scoring is deliberately conservative: a high score drops the message,
// a middling one still gets delivered but flagged, because a missed lead costs
// far more than an extra spam email.
// ---------------------------------------------------------------------------

const VOWELS = /[aeiouyAEIOUY]/g;

function tokenSignals(word) {
  const letters = word.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 6) return 0;

  let score = 0;

  // Only for longer words: plenty of ordinary short ones ("Sports", "Growth",
  // "rhythm") are vowel-poor and must not be penalised.
  const vowelCount = (letters.match(VOWELS) || []).length;
  if (letters.length >= 8 && vowelCount / letters.length < 0.2) score += 2;  // "Lxrqxnnvt"

  const longestConsonantRun = (letters.match(/[^aeiouyAEIOUY]+/g) || [])
    .reduce((max, run) => Math.max(max, run.length), 0);
  if (longestConsonantRun >= 5) score += 1;

  // Case flipping mid-word: "pHFeNeRDtZgfNeVcCbQAye". Real writing, including
  // all-caps and CamelCase brand names, does not alternate this often.
  const caseFlips = letters.split('').filter((ch, i) =>
    i > 0 && /[a-zA-Z]/.test(letters[i - 1])
    && (ch === ch.toUpperCase()) !== (letters[i - 1] === letters[i - 1].toUpperCase())
  ).length;
  if (caseFlips >= 4) score += 2;

  return score;
}

function textScore(value) {
  if (!value) return 0;
  const str = String(value).trim();
  if (!str) return 0;

  let score = str.split(/\s+/).reduce((sum, w) => sum + tokenSignals(w), 0);

  // A single unbroken 15+ character "sentence" is not how people answer
  // "what's your #1 challenge".
  if (str.length > 15 && !/\s/.test(str)) score += 1;

  return score;
}

function emailScore(email) {
  const str = String(email || '');
  const [local, domain = ''] = str.split('@');
  if (!local) return 0;

  let score = 0;

  // Gmail ignores dots, so one mailbox can spray unlimited unique-looking
  // addresses. "ko.d.om.u.qi.t.979@gmail.com" is that trick.
  const dots = (local.match(/\./g) || []).length;
  if (/^(gmail|googlemail)\.com$/i.test(domain) && dots >= 3) score += 3;

  score += tokenSignals(local.replace(/[._-]/g, ''));

  return score;
}

// Gmail treats dots and +tags as noise; collapsing them means one bot mailbox
// looks like one sender no matter how it dresses up the address.
export function normalizeEmail(email) {
  const str = String(email || '').trim().toLowerCase();
  const [local, domain] = str.split('@');
  if (!local || !domain) return str;
  if (/^(gmail|googlemail)\.com$/.test(domain)) {
    return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`;
  }
  return `${local.split('+')[0]}@${domain}`;
}

export function spamScore(fields) {
  return textScore(fields.fullName)
    + textScore(fields.practiceName)
    + textScore(fields.challenge)
    + textScore(fields.referralName)
    + emailScore(fields.email);
}

export const DROP_SCORE = 5;  // near-certain junk: dropped silently
export const FLAG_SCORE = 3;  // suspicious: delivered, but labelled

// ---------------------------------------------------------------------------
// Burst suppression
//
// Every bot so far has sent three copies. Same sender inside a short window
// only ever needs to reach the inbox once.
// ---------------------------------------------------------------------------

const BURST_WINDOW_MS = 30 * 60 * 1000;
const recentSenders = new Map();

export function isBurstDuplicate(email) {
  const key = normalizeEmail(email);
  if (!key) return false;

  const now = Date.now();
  for (const [k, seen] of recentSenders) {
    if (now - seen > BURST_WINDOW_MS) recentSenders.delete(k);
  }
  if (recentSenders.has(key)) return true;

  recentSenders.set(key, now);
  return false;
}
