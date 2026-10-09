// Shared input validation helpers (server-side).
'use strict';

const validEmail = (e) => {
  const s = String(e || '').trim();
  return s.length > 0 && s.length <= 160 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
};

const cleanText = (s, max = 500) =>
  String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

function isSafeUrl(u, { allowRelative = true } = {}) {
  const s = String(u || '').trim();
  if (!s) return false;
  if (/^\s*(javascript|data|vbscript|file):/i.test(s)) return false;
  if (allowRelative && s.startsWith('/')) return !s.startsWith('//');
  try {
    const p = new URL(s);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}

const PROVIDERS = ['youtube', 'vimeo', 'cloudflare', 'mp4'];
const isProvider = (p) => PROVIDERS.includes(String(p || ''));

function validateVideoUrl(provider, url) {
  const s = String(url || '').trim();
  if (!s) return { ok: true, url: '' }; // empty allowed → clear placeholder
  if (!isSafeUrl(s, { allowRelative: false })) return { ok: false, error: 'unsafe_url' };
  if (provider === 'youtube' && !/(youtube\.com|youtu\.be)/i.test(s)) return { ok: false, error: 'invalid_youtube_url' };
  if (provider === 'vimeo' && !/vimeo\.com/i.test(s)) return { ok: false, error: 'invalid_vimeo_url' };
  if (provider === 'mp4' && !/\.mp4(\?|#|$)/i.test(s)) return { ok: false, error: 'invalid_mp4_url' };
  return { ok: true, url: s };
}

const FILE_TYPES = ['pdf', 'checklist', 'excel', 'csv', 'other'];
const isFileType = (t) => FILE_TYPES.includes(String(t || ''));

const isPercent = (n) => Number.isInteger(n) && n >= 0 && n <= 100;
const isPrice = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100000;
const isCurrencyIso = (c) => /^[a-z]{3}$/i.test(String(c || '').trim());
const isId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0; };
const isRole = (r) => r === 'admin' || r === 'student';

module.exports = {
  validEmail, cleanText, isSafeUrl, PROVIDERS, isProvider,
  validateVideoUrl, FILE_TYPES, isFileType,
  isPercent, isPrice, isCurrencyIso, isId, isRole,
};
