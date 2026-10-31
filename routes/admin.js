const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const router = express.Router();

router.use(requireRole('admin'));
const POST_FEE = Number(process.env.JOB_POST_FEE_ETB || 99);

// Dashboard
router.get('/', async (req, res, next) => {
  try {
    const users = await db.query('SELECT COUNT(*) AS c FROM users');
    const pending = await db.query("SELECT COUNT(*) AS c FROM companies WHERE verification_status='pending'");
    const live = await db.query('SELECT COUNT(*) AS c FROM jobs WHERE published=TRUE');
    const rev = await db.query("SELECT COUNT(*) AS c FROM payments WHERE status='approved'");
    const vol = await db.query('SELECT COALESCE(SUM(budget_etb),0) AS v FROM jobs');
    res.render('admin/dashboard', {
      title: res.locals.t('adminPanel'),
      totalUsers: users.rows[0].c,
      pendingVerifications: pending.rows[0].c,
      jobsLive: live.rows[0].c,
      revenue: Number(rev.rows[0].c) * POST_FEE,
      marketVolume: vol.rows[0].v,
    });
  } catch (e) { next(e); }
});

// Company verifications
router.get('/verifications', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT c.*, u.name AS contact_name, u.phone AS contact_phone
       FROM companies c JOIN users u ON u.id=c.user_id
       WHERE c.verification_status='pending' ORDER BY c.created_at DESC`);
    res.render('admin/verifications', { title: res.locals.t('pendingCompanies'), companies: r.rows });
  } catch (e) { next(e); }
});

router.post('/verifications/:id/:action', async (req, res, next) => {
  try {
    const ok = req.params.action === 'approve';
    await db.query('UPDATE companies SET verification_status=$1, verified=$2 WHERE id=$3',
      [ok ? 'approved' : 'rejected', ok, req.params.id]);
    res.redirect('/admin/verifications');
  } catch (e) { next(e); }
});

// Payment receipts
router.get('/payments', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT p.id, p.receipt_path, p.status, p.created_at, j.id AS job_id, j.title,
              c.company_name, c.user_id AS company_user_id
       FROM payments p JOIN jobs j ON j.id=p.job_id JOIN companies c ON c.id=j.company_id
       WHERE p.status='pending' ORDER BY p.created_at DESC`);
    res.render('admin/payments', { title: res.locals.t('paymentReceipts'), payments: r.rows });
  } catch (e) { next(e); }
});

router.post('/payments/:id/:action', async (req, res, next) => {
  try {
    const ok = req.params.action === 'approve';
    const p = await db.query('SELECT job_id FROM payments WHERE id=$1', [req.params.id]);
    if (!p.rows.length) return res.status(404).render('404');
    await db.query('UPDATE payments SET status=$1 WHERE id=$2', [ok ? 'approved' : 'rejected', req.params.id]);
    await db.query('UPDATE jobs SET payment_status=$1, published=$2 WHERE id=$3',
      [ok ? 'approved' : 'rejected', ok, p.rows[0].job_id]);
    res.redirect('/admin/payments');
  } catch (e) { next(e); }
});

// All users
router.get('/users', async (req, res, next) => {
  try {
    const r = await db.query('SELECT id, role, name, phone, created_at FROM users ORDER BY created_at DESC LIMIT 200');
    res.render('admin/users', { title: res.locals.t('allUsers'), users: r.rows });
  } catch (e) { next(e); }
});

// User detail — everything about one user
router.get('/users/:id', async (req, res, next) => {
  try {
    const u = await db.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!u.rows.length) return res.status(404).render('404');
    const user = u.rows[0];
    let profile = null, counts = {};
    if (user.role === 'freelancer') {
      const f = await db.query('SELECT * FROM freelancers WHERE user_id=$1', [user.id]);
      profile = f.rows[0] || null;
      const a = await db.query('SELECT COUNT(*)::int AS n FROM applications WHERE freelancer_user_id=$1', [user.id]);
      counts.applications = a.rows[0].n;
    } else if (user.role === 'company') {
      const c = await db.query('SELECT * FROM companies WHERE user_id=$1', [user.id]);
      profile = c.rows[0] || null;
      if (profile) {
        const j = await db.query('SELECT COUNT(*)::int AS n FROM jobs WHERE company_id=$1', [profile.id]);
        counts.jobs = j.rows[0].n;
        const a = await db.query(
          `SELECT COUNT(*)::int AS n FROM applications app JOIN jobs j ON j.id=app.job_id
           WHERE j.company_id=$1`, [profile.id]);
        counts.applicationsReceived = a.rows[0].n;
      }
    }
    const m = await db.query('SELECT COUNT(*)::int AS n FROM messages WHERE sender_user_id=$1', [user.id]);
    counts.messagesSent = m.rows[0].n;
    res.render('admin/user-detail', { title: user.name, user, profile, counts, tab: 'users' });
  } catch (e) { next(e); }
});
router.get('/applications', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.proposal, a.status, a.created_at, a.freelancer_user_id,
              u.name AS freelancer_name, u.phone AS freelancer_phone,
              j.title AS job_title, c.company_name, c.user_id AS company_user_id
       FROM applications a
       JOIN users u ON u.id = a.freelancer_user_id
       JOIN jobs j ON j.id = a.job_id
       JOIN companies c ON c.id = j.company_id
       ORDER BY a.created_at DESC LIMIT 200`);
    const apps = r.rows;
    const docs = {};
    for (const a of apps) {
      const d = await db.query('SELECT doc_name, file_path FROM application_docs WHERE application_id=$1', [a.id]);
      docs[a.id] = d.rows;
    }
    res.render('admin/applications', { title: res.locals.t('applications'), apps, docs, tab: 'apps' });
  } catch (e) { next(e); }
});

// All jobs
router.get('/jobs', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT j.id, j.title, j.published, j.payment_status, j.created_at, c.company_name
       FROM jobs j JOIN companies c ON c.id=j.company_id ORDER BY j.created_at DESC LIMIT 200`);
    res.render('admin/jobs', { title: res.locals.t('allJobs'), jobs: r.rows });
  } catch (e) { next(e); }
});

// Announcements: admin broadcasts a platform message to users
router.get('/announcements', (req, res) => {
  res.render('admin/announcements', { title: res.locals.t('announcements') });
});

router.post('/announcements', async (req, res, next) => {
  try {
    const t = res.locals.t;
    const audience = ['all', 'freelancer', 'company'].includes(req.body.audience) ? req.body.audience : 'all';
    const title = String(req.body.title || '').trim();
    const body = String(req.body.body || '').trim();
    if (!title || !body) {
      req.session.flash = { type: 'err', msg: t('annRequired') };
      return res.redirect('/admin/announcements');
    }
    if (body.length > 500) {
      req.session.flash = { type: 'err', msg: t('annTooLong') };
      return res.redirect('/admin/announcements');
    }
    const roles = audience === 'all' ? ['freelancer', 'company'] : [audience];
    const inList = roles.map((r) => `'${r}'`).join(',');
    const r = await db.query(
      `INSERT INTO notifications(user_id, kind, title, body, link)
       SELECT id, 'announcement', $1, $2, '/' FROM users WHERE role IN (${inList})
       RETURNING id`,
      [JSON.stringify({ k: '__raw', text: title }), JSON.stringify({ k: '__raw', text: body })]
    );
    req.session.flash = { type: 'ok', msg: t('annSent').replace('{0}', String(r.rowCount)) };
    res.redirect('/admin/announcements');
  } catch (e) { next(e); }
});

module.exports = router;
