// Settings: language, change password, platform-announcement toggle, account info.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { t } = require('../i18n');
const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const u = await db.query(
      'SELECT id, role, name, phone, email, email_verified, notify_platform, created_at FROM users WHERE id=$1',
      [req.user.id]);
    res.render('settings', { title: res.locals.t('settings'), account: u.rows[0] });
  } catch (e) { next(e); }
});

// Language: same cookie preference as the header toggle
router.post('/language', requireAuth, (req, res) => {
  const lang = req.body.lang === 'am' ? 'am' : 'en';
  res.cookie('lang', lang, { maxAge: 1000 * 60 * 60 * 24 * 365 });
  req.session.flash = { type: 'ok', msg: t(lang, 'settingsSaved') };
  res.redirect('/settings?lang=' + lang);
});

// Change password: current + new + confirm (same rules as the reset flow: min 4 chars)
router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const lt = res.locals.t;
    const { current, password, password2 } = req.body;
    const u = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!u.rows.length || !(await bcrypt.compare(current || '', u.rows[0].password_hash))) {
      req.session.flash = { type: 'err', msg: lt('wrongCurrentPassword') };
      return res.redirect('/settings');
    }
    if (!password || password.length < 4 || password !== password2) {
      req.session.flash = {
        type: 'err',
        msg: password && password.length < 4 ? lt('passwordTooShort') : lt('passwordsDontMatch'),
      };
      return res.redirect('/settings');
    }
    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    req.session.flash = { type: 'ok', msg: lt('passwordChanged') };
    res.redirect('/settings');
  } catch (e) { next(e); }
});

// Platform announcements toggle
router.post('/notifications', requireAuth, async (req, res, next) => {
  try {
    const on = req.body.notify_platform === 'on';
    await db.query('UPDATE users SET notify_platform=$1 WHERE id=$2', [on, req.user.id]);
    req.session.flash = { type: 'ok', msg: res.locals.t('settingsSaved') };
    res.redirect('/settings');
  } catch (e) { next(e); }
});

module.exports = router;
