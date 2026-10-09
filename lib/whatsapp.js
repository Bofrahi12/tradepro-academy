// WhatsApp link builder with proper E.164 handling.
// Never assumes a country code: uses the full international number when given,
// otherwise applies SUPPORT_WHATSAPP_COUNTRY_CODE to local numbers starting with 0.
'use strict';

function waNumber(settings) {
  let n = String(settings.SUPPORT_WHATSAPP || '').replace(/[()\s-]/g, '');
  if (!n) return '';
  if (n.startsWith('+')) return n.slice(1).replace(/\D/g, '');
  if (n.startsWith('00')) return n.slice(2).replace(/\D/g, '');
  const cc = String(settings.SUPPORT_WHATSAPP_COUNTRY_CODE || '').replace(/\D/g, '');
  if (n.startsWith('0') && cc) return cc + n.slice(1).replace(/\D/g, '');
  return n.replace(/\D/g, '');
}

function waLink(settings, text = '') {
  const n = waNumber(settings);
  if (!n) return '';
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

module.exports = { waNumber, waLink };
