// Server-side pricing: the ONLY authority on price, discount and currency.
// Never trust amounts or discounts coming from the browser.
'use strict';
const { db, getSettings } = require('../db');

const MIN_AMOUNT_CENTS = 50; // $0.50 floor

function getCoupon(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  return db.prepare(
    `SELECT code, percent_off FROM coupons
     WHERE code = ? COLLATE NOCASE AND is_active = 1
       AND (expires_at IS NULL OR expires_at = '' OR expires_at > datetime('now'))`
  ).get(c);
}

function getPricing(couponCode) {
  const s = getSettings();
  const base = Math.round(parseFloat(s.COURSE_PRICE || '0') * 100);
  const currency = (s.CURRENCY_ISO || 'usd').toLowerCase().trim() || 'usd';
  const display = s.CURRENCY || '$';
  let percentOff = 0;
  let code = null;
  const c = getCoupon(couponCode);
  if (c && Number.isInteger(c.percent_off) && c.percent_off > 0 && c.percent_off <= 100) {
    percentOff = c.percent_off;
    code = c.code;
  }
  const discount = Math.round((base * percentOff) / 100);
  const amount = Math.max(base - discount, MIN_AMOUNT_CENTS);
  return { base, discount, amount, currency, display, percentOff, couponCode: code };
}

module.exports = { getPricing, getCoupon, MIN_AMOUNT_CENTS };
