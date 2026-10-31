const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db');
const { t, nt, CATEGORIES, CITIES, catName, cityName } = require('./i18n');
const { icon } = require('./lib/icons');
const { notify } = require('./lib/notify');
const { googleEnabled, passport } = require('./lib/google');

const app = express();
const PORT = process.env.PORT || 3000;

// Production boot data (Render + Neon): ensure schema, optionally seed demo data once.
if (process.env.DATABASE_URL && !process.env.USE_PGMEM) {
  const fs = require('fs');
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  db.query(schema)
    .then(() => console.log('schema ensured'))
    .then(async () => {
      // One-time demo seed (only when users table is empty)
      if (process.env.SEED_DEMO === '1') {
        const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM users');
        if (rows[0].n === 0) {
          console.log('seeding demo data...');
          await require('./db/seed').main({ keepAlive: true });
        } else {
          console.log('seed skipped: users exist');
        }
      }
      // Admin password rotation (independent of seeding)
      if (process.env.ADMIN_PASSWORD) {
        const bcrypt = require('bcryptjs');
        const h = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
        await db.query("UPDATE users SET password_hash=$1 WHERE role='admin'", [h]);
        console.log('admin password rotated');
      }
    })
    .catch((e) => console.error('boot data failed:', e.message));
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (googleEnabled && passport) app.use(passport.initialize());

app.use(session({
  secret: process.env.SESSION_SECRET || 'siralink-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

// Language: ?lang=am|en overrides, else cookie, else 'en'
app.use((req, res, next) => {
  if (req.query.lang === 'en' || req.query.lang === 'am') {
    res.cookie('lang', req.query.lang, { maxAge: 1000 * 60 * 60 * 24 * 365 });
    req.lang = req.query.lang;
  } else {
    req.lang = req.cookies.lang === 'am' ? 'am' : 'en';
  }
  res.locals.lang = req.lang;
  res.locals.t = (key) => t(req.lang, key);
  res.locals.nt = (stored) => nt(req.lang, stored);
  res.locals.googleEnabled = googleEnabled;
  res.locals.stars = (n) => {
    const f = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return '★'.repeat(f) + '☆'.repeat(5 - f);
  };
  res.locals.fmtETB = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-US') + ' ETB');
  res.locals.icon = icon;
  res.locals.CATEGORIES = CATEGORIES;
  res.locals.CITIES = CITIES;
  res.locals.catName = catName;
  res.locals.cityName = cityName;
  res.locals.qs = (over) => {
    const q = Object.assign({}, req.query, over);
    Object.keys(q).forEach((k) => { if (q[k] === '' || q[k] == null) delete q[k]; });
    delete q.lang;
    return new URLSearchParams(q).toString();
  };
  next();
});

// Attach logged-in user (and company row) to request + views
app.use(async (req, res, next) => {
  req.user = null;
  req.company = null;
  if (req.session.userId) {
    try {
      const r = await db.query('SELECT id, role, name, phone FROM users WHERE id=$1', [req.session.userId]);
      if (r.rows.length) {
        req.user = r.rows[0];
        if (req.user.role === 'company') {
          const c = await db.query('SELECT * FROM companies WHERE user_id=$1', [req.user.id]);
          req.company = c.rows[0] || null;
        }
      } else {
        delete req.session.userId;
      }
    } catch (e) { return next(e); }
  }
  res.locals.user = req.user;
  res.locals.company = req.company;
  // Unread chat messages + unread platform notifications, combined, for the header badge
  res.locals.unreadCount = 0;
  if (req.user) {
    try {
      const u = await db.query(
        `SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id
         LEFT JOIN conversation_reads r ON r.conversation_id=c.id AND r.user_id=$1
         WHERE (c.company_user_id=$1 OR c.freelancer_user_id=$1)
           AND m.sender_user_id<>$1 AND m.created_at > COALESCE(r.last_read_at, '1970-01-01')`,
        [req.user.id]);
      res.locals.unreadCount = u.rows[0].n;
    } catch (e) { /* tables may not exist on first boot */ }
    try {
      const n = await db.query(
        'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND is_read=FALSE',
        [req.user.id]);
      res.locals.unreadCount += n.rows[0].n;
    } catch (e) { /* table may not exist on first boot */ }
  }
  next();
});

// Lazy 24h reminder sweep: pending applications older than 24h nudge the company.
// Throttled to at most once every 10 minutes (in-memory).
let lastReminderRun = 0;
app.use(async (req, res, next) => {
  const now = Date.now();
  if (now - lastReminderRun > 10 * 60 * 1000) {
    lastReminderRun = now;
    try {
      const r = await db.query(
        `SELECT a.id, u.name AS freelancer_name, j.title AS job_title, j.id AS job_id, cu.id AS company_user_id
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         JOIN companies c ON c.id = j.company_id
         JOIN users cu ON cu.id = c.user_id
         JOIN users u ON u.id = a.freelancer_user_id
         WHERE a.status = 'pending' AND a.reminder_sent_at IS NULL
           AND a.created_at < NOW() - INTERVAL '24 hours'
         LIMIT 50`);
      for (const row of r.rows) {
        await notify(db, row.company_user_id, 'reminder', '/c/jobs/' + row.job_id + '/applicants',
          'notifReminderT', 'notifReminderB', [row.freelancer_name, row.job_title]);
        await db.query('UPDATE applications SET reminder_sent_at = NOW() WHERE id = $1', [row.id]);
      }
      if (r.rows.length) console.log('reminder sweep: notified', r.rows.length, 'pending applications');
    } catch (e) { console.error('reminder sweep failed:', e.message); }
  }
  next();
});

// Flash messages (simple, session-based)
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.use('/messages', require('./routes/messages'));
app.use('/support', require('./routes/support'));
app.use('/', require('./routes/index'));
app.use('/', require('./routes/auth'));
app.use('/f', require('./routes/freelancer'));
app.use('/c', require('./routes/company'));
app.use('/admin', require('./routes/admin'));

// 404
app.use((req, res) => res.status(404).render('404'));
// 500
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('500', { error: process.env.NODE_ENV === 'production' ? null : String(err && err.stack || err) });
});

if (require.main === module) {
  (async () => {
    if (process.env.USE_PGMEM === '1') await require('./db/seed').main({ keepAlive: true });
    app.listen(PORT, () => console.log(`SiraLink on http://localhost:${PORT} (lang cookie: en|am)`));
  })().catch((e) => { console.error(e); process.exit(1); });
}
module.exports = app;
