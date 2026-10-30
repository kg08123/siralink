// DB connection: real Postgres (DATABASE_URL) in production,
// in-memory Postgres (pg-mem) when USE_PGMEM=1 for local dev/test.
const { Pool } = require('pg');

let pool;
if (process.env.USE_PGMEM === '1') {
  const { newDb } = require('pg-mem');
  const db = newDb();
  const pg = db.adapters.createPg();
  pool = new pg.Pool();
} else {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
