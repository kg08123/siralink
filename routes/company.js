const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const upload = require('../lib/upload');
const router = express.Router();

router.use(requireRole('company'));

const POST_FEE = Number(process.env.JOB_POST_FEE_ETB || 99);
const TELEBIRR_NUMBER = process.env.TELEBIRR_NUMBER || '0911 23 45 67';

// Dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    const co = req.company;
    const jobs = await db.query('SELECT COUNT(*) AS total, SUM(CASE WHEN published THEN 1 ELSE 0 END) AS live FROM jobs WHERE company_id=$1', [co.id]);
    const apps = await db.query(
      'SELECT COUNT(*) AS total FROM applications a JOIN jobs j ON j.id=a.job_id WHERE j.company_id=$1', [co.id]);
    const likes = await db.query(
      'SELECT COUNT(*)::int AS n FROM job_likes l JOIN jobs j ON j.id=l.job_id WHERE j.company_id=$1', [co.id]);
    res.render('company/dashboard', {
      title: res.locals.t('dashboard'), company: co,
      jobStats: jobs.rows[0], appCount: apps.rows[0].total, totalLikes: likes.rows[0].n,
    });
  } catch (e) { next(e); }
});

// Post a job — step 1: details
router.get('/post', (req, res) => {
  if (req.company.verification_status !== 'approved') {
    req.session.flash = { type: 'err', msg: res.locals.t('unverifiedNote') };
    return res.redirect('/c/dashboard');
  }
  res.render('company/post1', { title: res.locals.t('postJob') });
});

router.post('/post', async (req, res, next) => {
  try {
    const t = res.locals.t;
    if (req.company.verification_status !== 'approved') {
      req.session.flash = { type: 'err', msg: t('unverifiedNote') };
      return res.redirect('/c/dashboard');
    }
    const { title, category, work_type, city, budget_etb, description } = req.body;
    let docs = req.body.docs;
    if (!Array.isArray(docs)) docs = docs ? [docs] : [];
    docs = docs.map((d) => String(d).trim()).filter(Boolean);
    if (!title || !category) {
      req.session.flash = { type: 'err', msg: t('fillAll') };
      return res.redirect('/c/post');
    }
    const r = await db.query(
      `INSERT INTO jobs(company_id,title,category,work_type,city,budget_etb,description,required_docs)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.company.id, title.trim(), category,
       work_type === 'online' ? 'online' : 'offline',
       city || null, budget_etb ? Number(budget_etb) : null,
       (description || '').trim() || null, docs.join(', ')]);
    req.session.flash = { type: 'ok', msg: t('jobPosted') };
    res.redirect('/c/post/payment/' + r.rows[0].id);
  } catch (e) { next(e); }
});

// Step 2: payment — telebirr instructions + receipt upload
router.get('/post/payment/:jobId', async (req, res, next) => {
  try {
    const r = await db.query('SELECT * FROM jobs WHERE id=$1 AND company_id=$2', [req.params.jobId, req.company.id]);
    if (!r.rows.length) return res.status(404).render('404');
    const p = await db.query('SELECT * FROM payments WHERE job_id=$1', [req.params.jobId]);
    res.render('company/post2', {
      title: res.locals.t('payment'), job: r.rows[0],
      payment: p.rows[0] || null, fee: POST_FEE, telebirr: TELEBIRR_NUMBER,
    });
  } catch (e) { next(e); }
});

router.post('/post/payment/:jobId', upload.single('receipt'), async (req, res, next) => {
  try {
    const t = res.locals.t;
    const r = await db.query('SELECT id FROM jobs WHERE id=$1 AND company_id=$2', [req.params.jobId, req.company.id]);
    if (!r.rows.length) return res.status(404).render('404');
    if (!req.file) {
      req.session.flash = { type: 'err', msg: t('uploadReceipt') };
      return res.redirect('/c/post/payment/' + req.params.jobId);
    }
    const existing = await db.query('SELECT id FROM payments WHERE job_id=$1', [req.params.jobId]);
    if (existing.rows.length) {
      await db.query("UPDATE payments SET receipt_path=$1, status='pending' WHERE job_id=$2",
        ['/uploads/' + req.file.filename, req.params.jobId]);
    } else {
      await db.query("INSERT INTO payments(job_id, receipt_path, status) VALUES($1,$2,'pending')",
        [req.params.jobId, '/uploads/' + req.file.filename]);
    }
    req.session.flash = { type: 'ok', msg: t('paymentSubmitted') };
    res.redirect('/c/jobs');
  } catch (e) { next(e); }
});

// My jobs
router.get('/jobs', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT id, title, work_type, budget_etb, payment_status, published, created_at
       FROM jobs WHERE company_id=$1 ORDER BY created_at DESC`, [req.company.id]);
    const jobs = r.rows;
    if (jobs.length) {
      const ids = jobs.map((j) => j.id);
      const iph = ids.map((_, i) => `$${i + 1}`).join(',');
      const ac = await db.query(`SELECT job_id, COUNT(*) AS c FROM applications WHERE job_id IN (${iph}) GROUP BY job_id`, ids);
      const pc = await db.query(`SELECT job_id, status FROM payments WHERE job_id IN (${iph})`, ids);
      const aMap = Object.fromEntries(ac.rows.map((x) => [x.job_id, Number(x.c)]));
      const pMap = Object.fromEntries(pc.rows.map((x) => [x.job_id, x.status]));
      jobs.forEach((j) => { j.applied_count = aMap[j.id] || 0; j.pay_status = pMap[j.id] || null; });
    }
    res.render('company/jobs', { title: res.locals.t('myJobs'), jobs });
  } catch (e) { next(e); }
});

// Applicants per job
router.get('/jobs/:id/applicants', async (req, res, next) => {
  try {
    const j = await db.query('SELECT * FROM jobs WHERE id=$1 AND company_id=$2', [req.params.id, req.company.id]);
    if (!j.rows.length) return res.status(404).render('404');
    const r = await db.query(
      `SELECT a.id, a.proposal, a.status, a.created_at, u.name AS freelancer_name, f.profession, f.skills
       FROM applications a JOIN users u ON u.id=a.freelancer_user_id
       LEFT JOIN freelancers f ON f.user_id=u.id
       WHERE a.job_id=$1 ORDER BY a.created_at DESC`, [req.params.id]);
    const docs = {};
    for (const a of r.rows) {
      const d = await db.query('SELECT doc_name, file_path FROM application_docs WHERE application_id=$1', [a.id]);
      docs[a.id] = d.rows;
    }
    res.render('company/applicants', { title: res.locals.t('applicants'), job: j.rows[0], apps: r.rows, docs });
  } catch (e) { next(e); }
});

// Accept / reject an applicant
router.post('/applications/:id/status', async (req, res, next) => {
  try {
    const a = await db.query(
      `SELECT a.id, a.job_id FROM applications a JOIN jobs j ON j.id=a.job_id
       WHERE a.id=$1 AND j.company_id=$2`, [req.params.id, req.company.id]);
    if (!a.rows.length) return res.status(404).render('404');
    const status = req.body.status === 'accepted' ? 'accepted' : 'rejected';
    await db.query('UPDATE applications SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.redirect('/c/jobs/' + a.rows[0].job_id + '/applicants');
  } catch (e) { next(e); }
});

module.exports = router;
