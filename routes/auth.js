const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
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

module.exports = router;
