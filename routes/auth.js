const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { googleEnabled, passport } = require('../lib/google');
const router = express.Router();

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/signup', { title: res.locals.t('signUp') });
});

router.post('/signup', async (req, res, next) => {
  try {
    const t = res.locals.t;
    const { role, name, phone, password, profession, skills, company_name, license_no, tin } = req.body;
    if (!['freelancer', 'company'].includes(role) || !name || !phone || !password) {
      req.session.flash = { type: 'err', msg: t('fillAll') };
      return res.redirect('/signup');
    }
    const exists = await db.query('SELECT id FROM users WHERE phone=$1', [phone.trim()]);
    if (exists.rows.length) {
      req.session.flash = { type: 'err', msg: t('phoneTaken') };
      return res.redirect('/signup');
    }
    const hash = await bcrypt.hash(password, 10);
    const u = await db.query(
      'INSERT INTO users(role,name,phone,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
      [role, name.trim(), phone.trim(), hash]
    );
    const userId = u.rows[0].id;
    if (role === 'freelancer') {
      await db.query('INSERT INTO freelancers(user_id,profession,skills) VALUES($1,$2,$3)',
        [userId, profession || null, (skills || '').trim() || null]);
    } else {
      if (!company_name) {
        req.session.flash = { type: 'err', msg: t('fillAll') };
        return res.redirect('/signup');
      }
      await db.query(
        'INSERT INTO companies(user_id,company_name,phone,license_no,tin) VALUES($1,$2,$3,$4,$5)',
        [userId, company_name.trim(), phone.trim(), (license_no || '').trim() || null, (tin || '').trim() || null]
      );
    }
    req.session.userId = userId;
    res.redirect('/'); // both roles land on home after registration
  } catch (e) { next(e); }
});

router.get('/signin', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/signin', { title: res.locals.t('signIn') });
});

router.post('/signin', async (req, res, next) => {
  try {
    const t = res.locals.t;
    const { phone, password } = req.body;
    const r = await db.query('SELECT * FROM users WHERE phone=$1', [(phone || '').trim()]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
      req.session.flash = { type: 'err', msg: t('invalidLogin') };
      return res.redirect('/signin');
    }
    req.session.userId = user.id;
    if (user.role === 'admin') return res.redirect('/admin');
    if (user.role === 'company') return res.redirect('/c/dashboard');
    return res.redirect('/f/dashboard');
  } catch (e) { next(e); }
});

router.get('/signout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---- Google Sign-In (only when GOOGLE_CLIENT_ID/SECRET are set) ----
if (googleEnabled && passport) {
  router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

  router.get('/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/signin' }),
    async (req, res, next) => {
      try {
        const gid = req.user.id;
        const r = await db.query('SELECT * FROM users WHERE google_id=$1', [gid]);
        if (r.rows.length) {
          const u = r.rows[0];
          // backfill avatar/email when missing
          const em = (req.user.emails && req.user.emails[0] && req.user.emails[0].value) || null;
          const av = (req.user.photos && req.user.photos[0] && req.user.photos[0].value) || null;
          if ((!u.avatar_url && av) || (!u.email && em)) {
            await db.query('UPDATE users SET avatar_url=COALESCE(avatar_url,$1), email=COALESCE(email,$2) WHERE id=$3',
              [av, em, u.id]);
          }
          req.session.userId = u.id;
          if (u.role === 'admin') return res.redirect('/admin');
          if (u.role === 'company') return res.redirect('/c/dashboard');
          return res.redirect('/f/dashboard');
        }
        req.session.pendingGoogle = {
          google_id: gid,
          name: (req.user.displayName || '').trim(),
          email: (req.user.emails && req.user.emails[0] && req.user.emails[0].value) || null,
          avatar_url: (req.user.photos && req.user.photos[0] && req.user.photos[0].value) || null,
        };
        res.redirect('/signup/google');
      } catch (e) { next(e); }
    });

  router.get('/signup/google', (req, res) => {
    if (req.user) return res.redirect('/');
    if (!req.session.pendingGoogle) return res.redirect('/signup');
    res.render('auth/signup-google', { title: res.locals.t('signUp'), g: req.session.pendingGoogle });
  });

  router.post('/signup/google', async (req, res, next) => {
    try {
      const pg = req.session.pendingGoogle;
      if (!pg) return res.redirect('/signup');
      const t = res.locals.t;
      const { role, name, phone, profession, skills, company_name, license_no, tin } = req.body;
      if (!['freelancer', 'company'].includes(role) || !name || !phone) {
        req.session.flash = { type: 'err', msg: t('fillAll') };
        return res.redirect('/signup/google');
      }
      const exists = await db.query('SELECT id FROM users WHERE phone=$1', [phone.trim()]);
      if (exists.rows.length) {
        req.session.flash = { type: 'err', msg: t('phoneTaken') };
        return res.redirect('/signup/google');
      }
      // Random unusable password — this account signs in via Google only
      const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
      const u = await db.query(
        'INSERT INTO users(role,name,phone,password_hash,google_id,email,avatar_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [role, name.trim(), phone.trim(), hash, pg.google_id, pg.email, pg.avatar_url]
      );
      const userId = u.rows[0].id;
      if (role === 'freelancer') {
        await db.query('INSERT INTO freelancers(user_id,profession,skills) VALUES($1,$2,$3)',
          [userId, profession || null, (skills || '').trim() || null]);
      } else {
        if (!company_name) {
          req.session.flash = { type: 'err', msg: t('fillAll') };
          return res.redirect('/signup/google');
        }
        await db.query(
          'INSERT INTO companies(user_id,company_name,phone,license_no,tin) VALUES($1,$2,$3,$4,$5)',
          [userId, company_name.trim(), phone.trim(), (license_no || '').trim() || null, (tin || '').trim() || null]
        );
      }
      delete req.session.pendingGoogle;
      req.session.userId = userId;
      res.redirect('/');
    } catch (e) { next(e); }
  });
}

module.exports = router;
