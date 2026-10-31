// Support chat: any logged-in user can talk to the admin team.
// Separate from job conversations (those are role-specific); support is 1:1 per user.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

async function ensureThread(userId) {
  await db.query('INSERT INTO support_threads(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const uid = req.user.id;
    await ensureThread(uid);
    // Mark admin replies as read
    await db.query("UPDATE support_messages SET is_read=TRUE WHERE user_id=$1 AND sender='admin' AND is_read=FALSE", [uid]);
    const m = await db.query('SELECT id, sender, body, created_at FROM support_messages WHERE user_id=$1 ORDER BY id ASC LIMIT 200', [uid]);
    res.render('support', { title: res.locals.t('supportChat'), messages: m.rows });
  } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const uid = req.user.id;
    const body = (req.body.body || '').trim();
    if (!body) return res.redirect('/support');
    await ensureThread(uid);
    await db.query("INSERT INTO support_messages(user_id, sender, body) VALUES($1,'user',$2)", [uid, body.slice(0, 2000)]);
    res.redirect('/support');
  } catch (e) { next(e); }
});

module.exports = router;
