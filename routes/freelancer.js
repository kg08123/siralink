const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { notify } = require('../lib/notify');
const upload = require('../lib/upload');
const router = express.Router();

router.use(requireRole('freelancer'));

// Dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    const f = await db.query('SELECT * FROM freelancers WHERE user_id=$1', [req.user.id]);
    const apps = await db.query(
      `SELECT a.id, a.status, a.created_at, j.title, c.company_name
       FROM applications a JOIN jobs j ON j.id=a.job_id JOIN companies c ON c.id=j.company_id
       WHERE a.freelancer_user_id=$1 ORDER BY a.created_at DESC LIMIT 5`, [req.user.id]);
    const counts = await db.query(
      `SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted,
              COUNT(*) AS total FROM applications WHERE freelancer_user_id=$1`, [req.user.id]);
    res.render('freelancer/dashboard', {
      title: res.locals.t('dashboard'),
      profile: f.rows[0] || {}, apps: apps.rows, counts: counts.rows[0],
    });
  } catch (e) { next(e); }
});

// Apply form
router.get('/apply/:jobId', async (req, res, next) => {
  try {
    const t = res.locals.t;
    const r = await db.query(
      `SELECT j.*, c.company_name, c.verified FROM jobs j JOIN companies c ON c.id=j.company_id
       WHERE j.id=$1 AND j.published=TRUE`, [req.params.jobId]);
    if (!r.rows.length) return res.status(404).render('404');
    const already = await db.query('SELECT id FROM applications WHERE job_id=$1 AND freelancer_user_id=$2',
      [req.params.jobId, req.user.id]);
    if (already.rows.length) {
      req.session.flash = { type: 'err', msg: t('alreadyApplied') };
      return res.redirect('/jobs/' + req.params.jobId);
    }
    const docs = (r.rows[0].required_docs || '').split(',').map((s) => s.trim()).filter(Boolean);
    res.render('freelancer/apply', { title: t('applyNow'), job: r.rows[0], docs });
  } catch (e) { next(e); }
});

// Submit application (proposal + one file per required document, in order)
router.post('/apply/:jobId', upload.array('documents', 10), async (req, res, next) => {
  try {
    const t = res.locals.t;
    const r = await db.query('SELECT required_docs FROM jobs WHERE id=$1 AND published=TRUE', [req.params.jobId]);
    if (!r.rows.length) return res.status(404).render('404');
    const already = await db.query('SELECT id FROM applications WHERE job_id=$1 AND freelancer_user_id=$2',
      [req.params.jobId, req.user.id]);
    if (already.rows.length) {
      req.session.flash = { type: 'err', msg: t('alreadyApplied') };
      return res.redirect('/jobs/' + req.params.jobId);
    }
    const docs = (r.rows[0].required_docs || '').split(',').map((s) => s.trim()).filter(Boolean);
    const a = await db.query(
      'INSERT INTO applications(job_id, freelancer_user_id, proposal) VALUES($1,$2,$3) RETURNING id',
      [req.params.jobId, req.user.id, (req.body.proposal || '').trim() || null]);
    const appId = a.rows[0].id;
    for (let i = 0; i < docs.length; i++) {
      const file = (req.files || [])[i];
      await db.query('INSERT INTO application_docs(application_id, doc_name, file_path) VALUES($1,$2,$3)',
        [appId, docs[i], file ? '/uploads/' + file.filename : null]);
    }
    // Notify the company
    try {
      const ju = await db.query(
        `SELECT u.id AS company_user_id, j.title AS job_title, fu.name AS freelancer_name
         FROM jobs j JOIN companies c ON c.id = j.company_id
         JOIN users u ON u.id = c.user_id
         JOIN users fu ON fu.id = $2
         WHERE j.id = $1`, [req.params.jobId, req.user.id]);
      if (ju.rows.length) {
        await notify(db, ju.rows[0].company_user_id, 'application',
          '/c/jobs/' + req.params.jobId + '/applicants',
          'notifNewAppT', 'notifNewAppB', [ju.rows[0].freelancer_name, ju.rows[0].job_title]);
      }
    } catch (ne) { console.error('notify on apply failed:', ne.message); }
    req.session.flash = { type: 'ok', msg: t('applicationSent') };
    res.redirect('/f/applications');
  } catch (e) { next(e); }
});

// My applications
router.get('/applications', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.status, a.proposal, a.created_at, j.id AS job_id, j.title, c.company_name
       FROM applications a JOIN jobs j ON j.id=a.job_id JOIN companies c ON c.id=j.company_id
       WHERE a.freelancer_user_id=$1 ORDER BY a.created_at DESC`, [req.user.id]);
    res.render('freelancer/applications', { title: res.locals.t('myApplications'), apps: r.rows });
  } catch (e) { next(e); }
});

// Profile
router.get('/profile', async (req, res, next) => {
  try {
    const r = await db.query('SELECT * FROM freelancers WHERE user_id=$1', [req.user.id]);
    res.render('freelancer/profile', { title: res.locals.t('profile'), profile: r.rows[0] || {} });
  } catch (e) { next(e); }
});

router.post('/profile', async (req, res, next) => {
  try {
    const { profession, skills, bio } = req.body;
    const up = await db.query('UPDATE freelancers SET profession=$2, skills=$3, bio=$4 WHERE user_id=$1',
      [req.user.id, profession || null, (skills || '').trim() || null, (bio || '').trim() || null]);
    if (up.rowCount === 0) {
      await db.query('INSERT INTO freelancers(user_id, profession, skills, bio) VALUES($1,$2,$3,$4)',
        [req.user.id, profession || null, (skills || '').trim() || null, (bio || '').trim() || null]);
    }
    req.session.flash = { type: 'ok', msg: res.locals.t('profileUpdated') };
    res.redirect('/f/dashboard');
  } catch (e) { next(e); }
});

module.exports = router;
