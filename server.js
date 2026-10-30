const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db');
const { t, CATEGORIES, CITIES, catName, cityName } = require('./i18n');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
  res.locals.stars = (n) => {
    const f = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return '★'.repeat(f) + '☆'.repeat(5 - f);
  };
  res.locals.fmtETB = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-US') + ' ETB');
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
  next();
});

// Flash messages (simple, session-based)
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

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
