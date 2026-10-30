const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

const JOB_COLS = `j.id, j.company_id, j.title, j.category, j.work_type, j.city, j.budget_etb,
  j.description, j.required_docs, j.payment_status, j.published, j.created_at,
  c.company_name, c.verified, c.rating_avg, c.rating_count`;
const JOB_FROM = `FROM jobs j JOIN companies c ON c.id = j.company_id`;

// Enrich job rows with applied_count + comment_count (portable, no GROUP BY on the main query)
async function enrichJobs(jobs) {
  if (!jobs.length) return jobs;
  const ids = jobs.map((j) => j.id);
  const coIds = [...new Set(jobs.map((j) => j.company_id))];
  const iph = ids.map((_, i) => `$${i + 1}`).join(',');
  const cph = coIds.map((_, i) => `$${i + 1}`).join(',');
  const ac = await db.query(`SELECT job_id, COUNT(*) AS c FROM applications WHERE job_id IN (${iph}) GROUP BY job_id`, ids);
  const rc = await db.query(`SELECT company_id, COUNT(*) AS c FROM reviews WHERE company_id IN (${cph}) GROUP BY company_id`, coIds);
  const aMap = Object.fromEntries(ac.rows.map((x) => [x.job_id, Number(x.c)]));
  const rMap = Object.fromEntries(rc.rows.map((x) => [x.company_id, Number(x.c)]));
  jobs.forEach((j) => { j.applied_count = aMap[j.id] || 0; j.comment_count = rMap[j.company_id] || 0; });
  return jobs;
}

function buildFilters(q) {
  const where = ['j.published = TRUE', "j.payment_status = 'approved'"];
  const params = [];
  let i = 1;
  if (q.q) { where.push(`(j.title ILIKE $${i} OR j.description ILIKE $${i} OR c.company_name ILIKE $${i})`); params.push(`%${q.q}%`); i++; }
  if (q.work_type === 'online' || q.work_type === 'offline') { where.push(`j.work_type = $${i}`); params.push(q.work_type); i++; }
  if (q.category) { where.push(`j.category = $${i}`); params.push(q.category); i++; }
  if (q.city) { where.push(`j.city = $${i}`); params.push(q.city); i++; }
  if (q.min && !isNaN(Number(q.min))) { where.push(`j.budget_etb >= $${i}`); params.push(Number(q.min)); i++; }
  if (q.max && !isNaN(Number(q.max))) { where.push(`j.budget_etb <= $${i}`); params.push(Number(q.max)); i++; }
  return { where: where.join(' AND '), params };
}

// Home: job feed + filters
router.get('/', async (req, res, next) => {
  try {
    const f = {
      q: req.query.q || '', work_type: req.query.work_type || '',
      category: req.query.category || '', city: req.query.city || '',
      min: req.query.min || '', max: req.query.max || '',
    };
    const { where, params } = buildFilters(f);
    const r = await db.query(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE ${where} ORDER BY j.created_at DESC LIMIT 100`, params);
    const jobs = await enrichJobs(r.rows);
    res.render('home', { title: res.locals.t('home'), jobs, f });
  } catch (e) { next(e); }
});

// Job detail
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const r = await db.query(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE j.id = $1 AND j.published = TRUE`, [req.params.id]);
    if (!r.rows.length) return res.status(404).render('404');
    const jobRows = await enrichJobs(r.rows);
    const job = jobRows[0];
    const rev = await db.query(
      `SELECT r.stars, r.comment, r.created_at, u.name AS reviewer_name
       FROM reviews r JOIN users u ON u.id = r.freelancer_user_id
       WHERE r.company_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [job.company_id]);
    let applied = false;
    if (req.user && req.user.role === 'freelancer') {
      const a = await db.query('SELECT id FROM applications WHERE job_id=$1 AND freelancer_user_id=$2',
        [job.id, req.user.id]);
      applied = a.rows.length > 0;
    }
    res.render('job', { title: job.title, job, reviews: rev.rows, applied });
  } catch (e) { next(e); }
});

// Leave a review on a company (freelancers only)
router.post('/jobs/:id/review', requireAuth, async (req, res, next) => {
  try {
    const t = res.locals.t;
    if (req.user.role !== 'freelancer') {
      req.session.flash = { type: 'err', msg: t('mustBeFreelancer') };
      return res.redirect('/jobs/' + req.params.id);
    }
    const jr = await db.query('SELECT company_id FROM jobs WHERE id=$1', [req.params.id]);
    if (!jr.rows.length) return res.status(404).render('404');
    const stars = Math.max(1, Math.min(5, parseInt(req.body.stars, 10) || 5));
    const comment = (req.body.comment || '').trim();
    if (!comment) return res.redirect('/jobs/' + req.params.id);
    await db.query(
      'INSERT INTO reviews(company_id, freelancer_user_id, stars, comment) VALUES($1,$2,$3,$4)',
      [jr.rows[0].company_id, req.user.id, stars, comment]);
    // recompute aggregates
    await db.query(
      `UPDATE companies SET rating_avg = (SELECT COALESCE(AVG(stars),0) FROM reviews WHERE company_id=$1),
        rating_count = (SELECT COUNT(*) FROM reviews WHERE company_id=$1) WHERE id=$1`,
      [jr.rows[0].company_id]);
    req.session.flash = { type: 'ok', msg: t('reviewThanks') };
    res.redirect('/jobs/' + req.params.id);
  } catch (e) { next(e); }
});

// Public company page
router.get('/companies/:id', async (req, res, next) => {
  try {
    const c = await db.query('SELECT * FROM companies WHERE id=$1', [req.params.id]);
    if (!c.rows.length) return res.status(404).render('404');
    const company = c.rows[0];
    const jr = await db.query(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE j.company_id=$1 AND j.published=TRUE ORDER BY j.created_at DESC`, [company.id]);
    const jobs = await enrichJobs(jr.rows);
    const rev = await db.query(
      `SELECT r.stars, r.comment, r.created_at, u.name AS reviewer_name
       FROM reviews r JOIN users u ON u.id = r.freelancer_user_id
       WHERE r.company_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [company.id]);
    res.render('company-public', { title: company.company_name, company, jobs, reviews: rev.rows });
  } catch (e) { next(e); }
});

module.exports = router;
