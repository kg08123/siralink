const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { notify } = require('../lib/notify');
const { googleEnabled, passport } = require('../lib/google');
const router = express.Router();

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/signup', { title: res.locals.t('signUp') });
});

router.post('/signup', async (req, res, next) => {
  try {
    const t = res.locals.t;
    const { role, name, phone, password, email, profession, skills, company_name, license_no, tin } = req.body;
    if (!['freelancer', 'company'].includes(role) || !name || !phone || !password) {
      req.session.flash = { type: 'err', msg: t('fillAll') };
      return res.redirect('/signup');
    }
    const emailTrim = (email || '').trim().toLowerCase();
    if (emailTrim && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
      req.session.flash = { type: 'err', msg: t('invalidEmail') };
      return res.redirect('/signup');
    }
    const exists = await db.query('SELECT id FROM users WHERE phone=$1', [phone.trim()]);
    if (exists.rows.length) {
      req.session.flash = { type: 'err', msg: t('phoneTaken') };
      return res.redirect('/signup');
    }
    if (emailTrim) {
      const emailExists = await db.query('SELECT id FROM users WHERE email=$1', [emailTrim]);
      if (emailExists.rows.length) {
        req.session.flash = { type: 'err', msg: t('invalidEmail') };
        return res.redirect('/signup');
      }
    }
    const hash = await bcrypt.hash(password, 10);
    const emailToken = emailTrim ? crypto.randomBytes(32).toString('hex') : null;
    const u = await db.query(
      'INSERT INTO users(role,name,phone,password_hash,email,email_token) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [role, name.trim(), phone.trim(), hash, emailTrim || null, emailToken]
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
    await notify(db, userId, 'welcome', '/welcome', 'welcomeTitle', 'welcomeBody');
    if (emailToken) {
      const { sendVerificationEmail, mailerEnabled, BASE_URL } = require('../lib/mailer');
      if (mailerEnabled()) {
        try {
          await sendVerificationEmail(emailTrim, `${BASE_URL}/verify-email/${emailToken}`);
          req.session.flash = { type: 'ok', msg: t('checkInbox') };
        } catch (e) { console.error('[mailer] send failed:', e.message); }
      }
    }
    res.redirect('/'); // both roles land on home after registration
  } catch (e) { next(e); }
});

router.get('/signin', (req, res) => {
  if (req.user) return res.redirect('/');
  const login = req.session.loginAttempt || '';
  delete req.session.loginAttempt;
  res.render('auth/signin', { title: res.locals.t('signIn'), login });
});

router.post('/signin', async (req, res, next) => {
  try {
    const t = res.locals.t;
    const { password } = req.body;
    const login = (req.body.login || '').trim();
    // Accept email or phone in the same field (existing phone users + admin keep working)
    const r = login.includes('@')
      ? await db.query('SELECT * FROM users WHERE email=$1', [login.toLowerCase()])
      : await db.query('SELECT * FROM users WHERE phone=$1', [login]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
      req.session.flash = { type: 'err', msg: t('invalidLogin') };
      req.session.loginAttempt = login; // keep what they typed
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
      const gEmail = (pg.email || '').trim().toLowerCase() || null;
      if (gEmail) {
        const emailExists = await db.query('SELECT id FROM users WHERE email=$1', [gEmail]);
        if (emailExists.rows.length) {
          req.session.flash = { type: 'err', msg: t('invalidEmail') };
          return res.redirect('/signup/google');
        }
      }
      // Google-confirmed email: trusted, mark verified immediately, no email sent
      const u = await db.query(
        'INSERT INTO users(role,name,phone,password_hash,google_id,email,avatar_url,email_verified,email_token) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [role, name.trim(), phone.trim(), hash, pg.google_id, gEmail, pg.avatar_url, Boolean(gEmail), null]
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
    await notify(db, userId, 'welcome', '/welcome', 'welcomeTitle', 'welcomeBody');
      res.redirect('/');
    } catch (e) { next(e); }
  });
}

// Email verification: user taps the link from the verification email
router.get('/verify-email/:token', async (req, res, next) => {
  try {
    const t = res.locals.t;
    const r = await db.query('SELECT id, email_verified FROM users WHERE email_token=$1', [req.params.token]);
    if (!r.rows.length) {
      req.session.flash = { type: 'err', msg: t('invalidToken') };
      return res.redirect(req.session.userId ? '/' : '/signin');
    }
    await db.query('UPDATE users SET email_verified=TRUE, email_token=NULL WHERE id=$1', [r.rows[0].id]);
    req.session.flash = { type: 'ok', msg: t('emailVerified') };
    res.redirect(req.session.userId ? '/' : '/signin');
  } catch (e) { next(e); }
});

// Resend verification email (dashboard button, only when email set + unverified)
router.post('/resend-verification', async (req, res, next) => {
  try {
    const t = res.locals.t;
    if (!req.session.userId) return res.redirect('/signin');
    const r = await db.query('SELECT id, email, email_verified FROM users WHERE id=$1', [req.session.userId]);
    const u = r.rows[0];
    if (u && u.email && !u.email_verified) {
      const token = crypto.randomBytes(32).toString('hex');
      await db.query('UPDATE users SET email_token=$1 WHERE id=$2', [token, u.id]);
      const { sendVerificationEmail, mailerEnabled, BASE_URL } = require('../lib/mailer');
      if (mailerEnabled()) {
        try {
          await sendVerificationEmail(u.email, `${BASE_URL}/verify-email/${token}`);
          req.session.flash = { type: 'ok', msg: t('emailSent') };
        } catch (e) { console.error('[mailer] resend failed:', e.message); }
      }
    }
    res.redirect(req.get('Referrer') || '/');
  } catch (e) { next(e); }
});

module.exports = router;
