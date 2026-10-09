// Audit log helper.
'use strict';
const { db } = require('../db');

function audit(actorId, action, targetType = '', targetId = '', details = '') {
  try {
    db.prepare(
      'INSERT INTO audit_log (actor_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId ?? null, String(action), String(targetType), String(targetId), String(details).slice(0, 2000));
  } catch (e) {
    console.error('[audit]', e.message);
  }
}

module.exports = { audit };
