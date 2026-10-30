const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

const JOB_COLS = `j.id, j.company_id, j.title, j.category, j.work_type, j.city, j.budget_etb,
  j.description, j.required_docs, j.payment_status, j.published, j.created_at,
  c.company_name, c.verified, c.rating_avg, c.rating_count,
  COALESCE(l.likes, 0) AS like_count`;
const JOB_FROM = `FROM jobs j JOIN companies c ON c.id = j.company_id
  LEFT JOIN (SELECT job_id, COUNT(*) AS likes FROM job_likes GROUP BY job_id) l ON l.job_id = j.id`;

// Enrich job rows with applied_count + comment_count + liked-by-viewer (portable, no GROUP BY on the main query)
async function enrichJobs(jobs, userId) {
  if (!jobs.length) return jobs;
  const ids = jobs.map((j) => j.id);
  const coIds = [...new Set(jobs.map((j) => j.company_id))];
  const iph = ids.map((_, i) => `$${i + 1}`).join(',');
  const cph = coIds.map((_, i) => `$${i + 1}`).join(',');
  const ac = await db.query(`SELECT job_id, COUNT(*) AS c FROM applications WHERE job_id IN (${iph}) GROUP BY job_id`, ids);
  const rc = await db.query(`SELECT company_id, COUNT(*) AS c FROM reviews WHERE company_id IN (${cph}) GROUP BY company_id`, coIds);
  const aMap = Object.fromEntries(ac.rows.map((x) => [x.job_id, Number(x.c)]));
  const rMap = Object.fromEntries(rc.rows.map((x) => [x.company_id, Number(x.c)]));
  let likedSet = new Set();
  if (userId) {
    const lph = ids.map((_, i) => `$${i + 2}`).join(',');
    const lk = await db.query(`SELECT job_id FROM job_likes WHERE user_id=$1 AND job_id IN (${lph})`, [userId, ...ids]);
    likedSet = new Set(lk.rows.map((x) => x.job_id));
  }
  jobs.forEach((j) => {
    j.applied_count = aMap[j.id] || 0;
    j.comment_count = rMap[j.company_id] || 0;
    j.like_count = Number(j.like_count) || 0;
    j.liked = likedSet.has(j.id);
  });
  return jobs;
}

async function companyLikes(companyId) {
  const r = await db.query(
    'SELECT COUNT(*)::int AS n FROM job_likes l JOIN jobs j ON j.id=l.job_id WHERE j.company_id=$1',
    [companyId]);
  return r.rows[0].n;
}

const SORTS = {
  newest: 'j.created_at DESC',
  budget_desc: 'COALESCE(j.budget_etb, -1) DESC, j.created_at DESC',
  budget_asc: 'COALESCE(j.budget_etb, 999999999) ASC, j.created_at DESC',
  likes: 'like_count DESC, j.created_at DESC',
};

// Word-based search: split query into words; a job matches if ANY word hits
// title/description/company/city (partial matches kept, ranked below full matches).
// Relevance score per word: title=3, company=2, description=1, city=1.
function buildSearch(words, startIdx) {
  const ors = [], scores = [], params = [];
  let i = startIdx;
  for (const w of words) {
    params.push(`%${w}%`);
    ors.push(`(j.title ILIKE $${i} OR c.company_name ILIKE $${i} OR j.description ILIKE $${i} OR j.city ILIKE $${i})`);
    scores.push(`(CASE WHEN j.title ILIKE $${i} THEN 3 ELSE 0 END + CASE WHEN c.company_name ILIKE $${i} THEN 2 ELSE 0 END + CASE WHEN j.description ILIKE $${i} THEN 1 ELSE 0 END + CASE WHEN j.city ILIKE $${i} THEN 1 ELSE 0 END)`);
    i++;
  }
  return { ors, scores, params, nextIdx: i };
}

function buildFilters(q) {
  const where = ['j.published = TRUE', "j.payment_status = 'approved'"];
  const params = [];
  let i = 1, score = '0';
  const words = (q.q || '').trim().split(/\s+/).filter(Boolean);
  if (words.length) {
    const s = buildSearch(words, i);
    where.push('(' + s.ors.join(' OR ') + ')');
    params.push(...s.params);
    i = s.nextIdx;
    score = s.scores.join(' + ');
  }
  if (q.work_type === 'online' || q.work_type === 'offline') { where.push(`j.work_type = $${i}`); params.push(q.work_type); i++; }
  if (q.category) { where.push(`j.category = $${i}`); params.push(q.category); i++; }
  if (q.city) { where.push(`j.city = $${i}`); params.push(q.city); i++; }
  if (q.min && !isNaN(Number(q.min))) { where.push(`j.budget_etb >= $${i}`); params.push(Number(q.min)); i++; }
  if (q.max && !isNaN(Number(q.max))) { where.push(`j.budget_etb <= $${i}`); params.push(Number(q.max)); i++; }
  if (q.verified === '1') { where.push('c.verified = TRUE'); }
  return { where: where.join(' AND '), params, score };
}

// Home: job feed + filters
router.get('/', async (req, res, next) => {
  try {
    const f = {
      q: req.query.q || '', work_type: req.query.work_type || '',
      category: req.query.category || '', city: req.query.city || '',
      min: req.query.min || '', max: req.query.max || '',
      sort: Object.keys(SORTS).includes(req.query.sort) ? req.query.sort : 'newest',
      verified: req.query.verified === '1' ? '1' : '',
    };
    const { where, params, score } = buildFilters(f);
    const hasQ = (f.q || '').trim().length > 0;
    const orderBy = hasQ ? `(${score}) DESC, ${SORTS[f.sort]}` : SORTS[f.sort];
    const r = await db.query(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE ${where} ORDER BY ${orderBy} LIMIT 100`, params);
    const jobs = await enrichJobs(r.rows, req.user && req.user.id);
    const cr = await db.query(`SELECT DISTINCT city FROM jobs WHERE published = TRUE AND city IS NOT NULL AND city <> '' ORDER BY city`);
    res.render('home', { title: res.locals.t('home'), jobs, f, cities: cr.rows.map((x) => x.city) });
  } catch (e) { next(e); }
});

// Like / unlike a job (login required; JSON for fetch, redirect for plain visits)
router.post('/jobs/:id/like', requireAuth, async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    const jr = await db.query('SELECT id FROM jobs WHERE id=$1', [jobId]);
    if (!jr.rows.length) {
      if (req.accepts('json')) return res.status(404).json({ error: 'not found' });
      return res.status(404).render('404');
    }
    const del = await db.query('DELETE FROM job_likes WHERE job_id=$1 AND user_id=$2', [jobId, req.user.id]);
    let liked;
    if (del.rowCount === 0) {
      await db.query('INSERT INTO job_likes(job_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [jobId, req.user.id]);
      liked = true;
    } else {
      liked = false;
    }
    const c = await db.query('SELECT COUNT(*)::int AS n FROM job_likes WHERE job_id=$1', [jobId]);
    if (req.accepts('json')) return res.json({ liked, count: c.rows[0].n });
    res.redirect('/jobs/' + jobId);
  } catch (e) { next(e); }
});

// Job detail
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const r = await db.query(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE j.id = $1 AND j.published = TRUE`, [req.params.id]);
    if (!r.rows.length) return res.status(404).render('404');
    const jobRows = await enrichJobs(r.rows, req.user && req.user.id);
    const job = jobRows[0];
    const likesTotal = await companyLikes(job.company_id);
    const rev = await db.query(
      `SELECT r.comment, r.created_at, u.name AS reviewer_name
       FROM reviews r JOIN users u ON u.id = r.freelancer_user_id
       WHERE r.company_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [job.company_id]);
    let applied = false;
    if (req.user && req.user.role === 'freelancer') {
      const a = await db.query('SELECT id FROM applications WHERE job_id=$1 AND freelancer_user_id=$2',
        [job.id, req.user.id]);
      applied = a.rows.length > 0;
    }
    res.render('job', { title: job.title, job, reviews: rev.rows, applied, likesTotal });
  } catch (e) { next(e); }
});

// Leave a comment on a company (freelancers only; text only, no star ratings)
router.post('/jobs/:id/review', requireAuth, async (req, res, next) => {
  try {
    const t = res.locals.t;
    if (req.user.role !== 'freelancer') {
      req.session.flash = { type: 'err', msg: t('mustBeFreelancer') };
      return res.redirect('/jobs/' + req.params.id);
    }
    const jr = await db.query('SELECT company_id FROM jobs WHERE id=$1', [req.params.id]);
    if (!jr.rows.length) return res.status(404).render('404');
    const comment = (req.body.comment || '').trim();
    if (!comment) return res.redirect('/jobs/' + req.params.id);
    await db.query(
      'INSERT INTO reviews(company_id, freelancer_user_id, stars, comment) VALUES($1,$2,NULL,$3)',
      [jr.rows[0].company_id, req.user.id, comment]);
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
    const jr = await db.query(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE j.company_id=$1 AND j.published=TRUE ORDER BY ${SORTS.newest}`, [company.id]);
    const jobs = await enrichJobs(jr.rows, req.user && req.user.id);
    const totalLikes = await companyLikes(company.id);
    const rc = await db.query('SELECT COUNT(*)::int AS n FROM reviews WHERE company_id=$1', [company.id]);
    const rev = await db.query(
      `SELECT r.comment, r.created_at, u.name AS reviewer_name
       FROM reviews r JOIN users u ON u.id = r.freelancer_user_id
       WHERE r.company_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [company.id]);
    res.render('company-public', { title: company.company_name, company, jobs, reviews: rev.rows, totalLikes, reviewCount: rc.rows[0].n });
  } catch (e) { next(e); }
});

// Notifications inbox (marks read on view)
router.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const r = await db.query(
      'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
    await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND is_read=FALSE', [req.user.id]);
    res.render('notifications', { title: res.locals.t('notifications'), notifs: r.rows });
  } catch (e) { next(e); }
});

// Public freelancer profile (login required) — for companies viewing applicants
router.get('/freelancers/:id', requireAuth, async (req, res, next) => {
  try {
    const u = await db.query(
      `SELECT u.id, u.name, u.phone, u.email, u.avatar_url, u.created_at,
              f.profession, f.skills, f.bio
       FROM users u LEFT JOIN freelancers f ON f.user_id = u.id
       WHERE u.id = $1 AND u.role = 'freelancer'`, [req.params.id]);
    if (!u.rows.length) return res.status(404).render('404');
    const freelancer = u.rows[0];
    const ac = await db.query(
      'SELECT COUNT(*)::int AS n FROM applications WHERE freelancer_user_id=$1', [freelancer.id]);
    res.render('freelancer-public', {
      title: freelancer.name,
      freelancer,
      appCount: ac.rows[0].n,
    });
  } catch (e) { next(e); }
});

module.exports = router;
