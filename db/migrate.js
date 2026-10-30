// Applies db/schema.sql. Usage: node db/migrate.js  (set USE_PGMEM=1 for local)
const fs = require('fs');
const path = require('path');
const db = require('./index');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);
  console.log('schema applied');
  if (typeof db.pool.end === 'function') await db.pool.end();
}

migrate().catch((e) => { console.error(e); process.exit(1); });
