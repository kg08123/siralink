// Messaging: company-initiated conversations only.
// A conversation is auto-created when a company ACCEPTS an application.
// Freelancers cannot start conversations; they reply from their inbox.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// One conversation row, access-checked: only the two participants may see it.
async function getConv(id, userId) {
  const r = await db.query(
    `SELECT c.id, c.job_id, c.company_user_id, c.freelancer_user_id, c.created_at,
            j.title AS job_title,
            CASE WHEN c.company_user_id=$1 THEN fu.name ELSE cu.name END AS other_name
     FROM conversations c
     JOIN jobs j ON j.id=c.job_id
     JOIN users fu ON fu.id=c.freelancer_user_id
     JOIN users cu ON cu.id=c.company_user_id
     WHERE c.id=$2 AND (c.company_user_id=$1 OR c.freelancer_user_id=$1)`,
    [userId, id]);
  return r.rows[0];
}

async function unreadFor(convId, userId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM messages m
     LEFT JOIN conversation_reads r ON r.conversation_id=m.conversation_id AND r.user_id=$1
     WHERE m.conversation_id=$2 AND m.sender_user_id<>$1
       AND m.created_at > COALESCE(r.last_read_at, '1970-01-01')`,
    [userId, convId]);
  return r.rows[0].n;
}

async function markRead(convId, userId) {
  await db.query(
    `INSERT INTO conversation_reads(user_id, conversation_id, last_read_at) VALUES($1,$2,NOW())
     ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at=NOW()`,
    [userId, convId]);
}

// Inbox
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.job_id, c.created_at, j.title AS job_title,
              CASE WHEN c.company_user_id=$1 THEN fu.name ELSE cu.name END AS other_name
       FROM conversations c
       JOIN jobs j ON j.id=c.job_id
       JOIN users fu ON fu.id=c.freelancer_user_id
       JOIN users cu ON cu.id=c.company_user_id
       WHERE c.company_user_id=$1 OR c.freelancer_user_id=$1
       ORDER BY c.created_at DESC`,
      [req.user.id]);
    const convs = r.rows;
    for (const c of convs) {
      const lm = await db.query(
        'SELECT body FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 1', [c.id]);
      c.lastBody = lm.rows.length ? lm.rows[0].body : '';
      c.unread = await unreadFor(c.id, req.user.id);
    }
    res.render('messages-inbox', { title: res.locals.t('messages'), convs });
  } catch (e) { next(e); }
});

// Chat thread
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const conv = await getConv(req.params.id, req.user.id);
    if (!conv) return res.status(404).render('404');
    await markRead(conv.id, req.user.id);
    const m = await db.query(
      `SELECT m.id, m.body, m.created_at, m.sender_user_id, u.name AS sender_name
       FROM messages m JOIN users u ON u.id=m.sender_user_id
       WHERE m.conversation_id=$1 ORDER BY m.id ASC LIMIT 200`, [conv.id]);
    res.render('messages-thread', { title: conv.other_name, conv, messages: m.rows });
  } catch (e) { next(e); }
});

// JSON poll for new messages (used by the thread's 5s refresher)
router.get('/:id/json', requireAuth, async (req, res, next) => {
  try {
    const conv = await getConv(req.params.id, req.user.id);
    if (!conv) return res.status(404).json({ error: 'not found' });
    if (!req.xhr) return res.redirect('/messages/' + conv.id);
    const after = Number(req.query.after) || 0;
    const m = await db.query(
      `SELECT m.id, m.body, m.created_at, m.sender_user_id
       FROM messages m WHERE m.conversation_id=$1 AND m.id>$2 ORDER BY m.id ASC LIMIT 100`,
      [conv.id, after]);
    await markRead(conv.id, req.user.id);
    res.json({
      messages: m.rows.map((x) => ({
        id: x.id, body: x.body, created_at: x.created_at, mine: x.sender_user_id === req.user.id,
      })),
    });
  } catch (e) { next(e); }
});

// Send a message (participants only)
router.post('/:id', requireAuth, async (req, res, next) => {
  try {
    const conv = await getConv(req.params.id, req.user.id);
    if (!conv) return res.status(404).render('404');
    const body = (req.body.body || '').trim();
    if (!body) return res.redirect('/messages/' + conv.id);
    await db.query(
      'INSERT INTO messages(conversation_id, sender_user_id, body) VALUES($1,$2,$3)',
      [conv.id, req.user.id, body.slice(0, 2000)]);
    if (req.xhr) return res.json({ ok: true });
    res.redirect('/messages/' + conv.id);
  } catch (e) { next(e); }
});

module.exports = router;
