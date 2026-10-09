// Run pending DB migrations (also runs automatically on server start).
// Usage: node scripts/migrate.js
'use strict';
require('../db');
console.log('[migrate] all pending migrations applied.');
