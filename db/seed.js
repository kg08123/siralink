// Seed demo data. Usage: USE_PGMEM=1 node db/seed.js  (after migrate)
// In production: DATABASE_URL=... node db/seed.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const bcrypt = require('bcryptjs');
const db = require('./index');

const hash = bcrypt.hashSync('password123', 10);
const ADMIN_PHONE = '0911000000';
const ADMIN_PASS = 'admin123';

// minimal valid PNG placeholder (solid light gray 200x120) for the demo receipt
function writePlaceholderPng(filePath) {
  const w = 200, h = 120;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = 230; raw[o + 1] = 235; raw[o + 2] = 230;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? 0 : 0, 0);
    // simple CRC32
    let c = 0xffffffff;
    const buf = Buffer.concat([t, data]);
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(filePath, png);
}

async function main(opts = {}) {
  // apply schema first (idempotent) so seed works standalone, incl. pg-mem single-process
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);
  const existing = await db.query('SELECT COUNT(*) AS c FROM users');
  if (Number(existing.rows[0].c) > 0) {
    console.log('already seeded — skipping');
    if (!opts.keepAlive && typeof db.pool.end === 'function') await db.pool.end();
    return;
  }

  // admin
  const ah = bcrypt.hashSync(ADMIN_PASS, 10);
  await db.query("INSERT INTO users(role,name,phone,password_hash) VALUES('admin','SiraLink Admin',$1,$2)",
    [ADMIN_PHONE, ah]);

  // companies: [company_name, contact, phone, license, tin, verified?]
  const companies = [
    ['Addis Digital Studio', 'Nahom Bekele', '0911222333', 'ET-001234', '100200300', true],
    ['Habesha Logistics', 'Tigist Alem', '0911333444', 'ET-002345', '100200301', true],
    ['Buna Café House', 'Kebede Mulu', '0911444555', 'ET-003456', '100200302', true],
    ['Ednova Learning', 'Selam Tesfaye', '0911555666', 'ET-004567', '100200303', true],
    ['Rift Valley AgriTech', 'Girma Dadi', '0911666777', 'ET-005678', '100200304', true],
    ['Dire Dawa Textiles', 'Amina Yusuf', '0911777888', 'ET-006789', '100200305', true],
    ['Lalibela Crafts PLC', 'Yonas Assefa', '0911888999', 'ET-007890', '100200306', false],
    ['Gondar Heritage Tours', 'Mulugeta Kassa', '0911999000', 'ET-008901', '100200307', false],
    ['Jimma Coffee Export', 'Fatuma Hassan', '0912000111', 'ET-009012', '100200308', false],
    ['Adama Tech Hub', 'Dawit Negash', '0912111222', 'ET-010123', '100200309', false],
  ];
  const companyIds = [];
  for (const [cname, contact, phone, lic, tin, verified] of companies) {
    const u = await db.query(
      'INSERT INTO users(role,name,phone,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
      ['company', contact, phone, hash]);
    const c = await db.query(
      'INSERT INTO companies(user_id,company_name,phone,license_no,tin,verified,verification_status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [u.rows[0].id, cname, phone, lic, tin, verified, verified ? 'approved' : 'pending']);
    companyIds.push(c.rows[0].id);
  }

  // jobs: [companyIdx, title, category, work_type, city, budget, description, required_docs, published?]
  const jobs = [
    [0, 'Website for Restaurant', 'webdev', 'online', 'addis', 15000, 'Build a simple 5-page website for a restaurant in Bole. Menu page, contact form, Amharic + English.', 'CV, Portfolio', true],
    [0, 'Mobile App UI Design', 'design', 'online', 'addis', 25000, 'Design 12 mobile screens in Figma for a food delivery app. Modern, clean style.', 'CV, Portfolio', true],
    [1, 'Delivery Rider — Piassa Route', 'delivery', 'offline', 'addis', 8000, 'Daily deliveries around Piassa. Must own a motorcycle. Fuel allowance included.', 'CV, National ID, Driving License', true],
    [1, 'Warehouse Packer', 'delivery', 'offline', 'addis', 6000, 'Packing parcels at our Kality warehouse, 6 days a week.', 'National ID', true],
    [2, 'Morning Cleaner', 'cleaning', 'offline', 'addis', 5000, 'Clean our café in CMC every morning 6–9 AM.', 'National ID', true],
    [2, 'Social Media Manager', 'marketing', 'online', 'addis', 12000, 'Run our Instagram and TikTok: 4 posts a week, reply to comments.', 'CV, Portfolio', true],
    [3, 'Grade 10 Math Tutor', 'tutoring', 'online', 'bahirdar', 9000, 'Online math tutoring for grade 10 students, 3 evenings a week via Telegram video.', 'CV, Degree Certificate', true],
    [3, 'English Tutor — Kids', 'tutoring', 'offline', 'bahirdar', 7000, 'Teach English to kids ages 7–12 at our center near the lake.', 'CV', true],
    [4, 'Farm Data Collector', 'other', 'offline', 'hawassa', 10000, 'Collect crop data from farms around Hawassa using our phone app.', 'CV, National ID', true],
    [4, 'Logo Designer', 'design', 'online', 'hawassa', 8000, 'New logo for our agri brand. Deliver AI + PNG files.', 'Portfolio', true],
    [5, 'Product Photographer', 'design', 'offline', 'diredawa', 11000, 'Shoot 40 textile products at our Dire Dawa workshop.', 'Portfolio', true],
    [5, 'Sales Agent', 'marketing', 'offline', 'diredawa', 9000, 'Sell our fabrics to shops in Dire Dawa and Harar. Commission on top.', 'CV, National ID', true],
    [0, 'E-commerce Site (Shopify)', 'webdev', 'online', 'addis', 40000, 'Full Shopify store setup with telebirr payment instructions page.', 'CV, Portfolio', false], // pending payment
    [1, 'Intercity Driver — Addis/Hawassa', 'delivery', 'offline', 'addis', 14000, 'Drive our van between Addis and Hawassa twice a week.', 'Driving License, National ID', true],
    [3, 'Amharic Content Writer', 'writing', 'online', 'bahirdar', 6000, 'Write 8 blog posts in Amharic about education topics.', 'CV', true],
    [2, 'Barista — Weekend Shift', 'other', 'offline', 'addis', 4500, 'Weekend barista at our CMC branch. Jebena and espresso experience a plus.', 'National ID', true],
    [4, 'Translator EN→AM', 'writing', 'online', 'hawassa', 7500, 'Translate 20 pages of training material from English to Amharic.', 'CV', true],
    [5, 'Delivery Coordinator', 'delivery', 'offline', 'diredawa', 9500, 'Coordinate our riders and track parcels from the office.', 'CV', true],
    [0, 'Bug Fix Sprint — React', 'webdev', 'online', 'addis', 18000, 'Fix 15 reported bugs in our React dashboard within one week.', 'CV, Portfolio', true],
    [6, 'Craft Photographer', 'design', 'offline', 'addis', 7000, 'Photograph handmade crafts for our online shop.', 'Portfolio', false], // company pending
  ];
  const jobIds = [];
  for (const [ci, title, cat, wt, city, budget, desc, docs, pub] of jobs) {
    const j = await db.query(
      `INSERT INTO jobs(company_id,title,category,work_type,city,budget_etb,description,required_docs,payment_status,published)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [companyIds[ci], title, cat, wt, city, budget, desc, docs, pub ? 'approved' : 'pending', pub]);
    jobIds.push(j.rows[0].id);
    if (pub) await db.query("INSERT INTO payments(job_id, receipt_path, status) VALUES($1,'seed', 'approved')", [j.rows[0].id]);
  }
  // one pending payment receipt (for the admin to approve) on job index 12
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  writePlaceholderPng(path.join(uploadsDir, 'seed-receipt.png'));
  await db.query("INSERT INTO payments(job_id, receipt_path, status) VALUES($1,'/uploads/seed-receipt.png','pending')", [jobIds[12]]);

  // freelancers: [name, phone, profession, skills, bio]
  const freelancers = [
    ['Abebe Tesfaye', '0922000111', 'webdev', 'React, Node.js', 'Web developer from Addis, 3 years building sites for local businesses.'],
    ['Sara Mekonnen', '0922000222', 'design', 'Photoshop, Figma', 'Graphic designer. Logos, social media kits, brand identity.'],
    ['Yohannes Tadesse', '0922000333', 'delivery', 'Driving, Motorcycle', 'Reliable driver with own motorcycle. Addis Ababa area.'],
    ['Meskerem Alemu', '0922000444', 'tutoring', 'Math, Physics', 'Math tutor for grades 9–12. Patient, exam-focused.'],
    ['Dawit Haile', '0922000555', 'writing', 'Amharic, English', 'Writer and translator EN↔AM. Blogs, business docs.'],
    ['Hiwot Girma', '0922000666', 'marketing', 'Social media, Ads', 'I grow Instagram and TikTok pages for Ethiopian brands.'],
  ];
  const freelancerIds = [];
  for (const [name, phone, prof, skills, bio] of freelancers) {
    const u = await db.query("INSERT INTO users(role,name,phone,password_hash) VALUES('freelancer',$1,$2,$3) RETURNING id",
      [name, phone, hash]);
    await db.query('INSERT INTO freelancers(user_id,profession,skills,bio) VALUES($1,$2,$3,$4)',
      [u.rows[0].id, prof, skills, bio]);
    freelancerIds.push(u.rows[0].id);
  }

  // reviews: [companyIdx, freelancerIdx, stars, comment]
  const reviews = [
    [0, 0, 5, 'Great company — clear brief, paid on time via telebirr.'],
    [0, 1, 5, 'Professional team, fast feedback on designs.'],
    [1, 2, 4, 'Good routes and fair pay. Fuel allowance arrived late once.'],
    [2, 5, 5, 'Lovely people, flexible hours.'],
    [3, 3, 5, 'Students are motivated, management is organized. በጣም ጥሩ!'],
    [4, 4, 4, 'Interesting work, payment took a week.'],
    [5, 1, 5, 'Paid exactly as agreed. Would work again.'],
    [1, 2, 5, 'Second job with them — always fair.'],
  ];
  for (const [ci, fi, stars, comment] of reviews) {
    await db.query('INSERT INTO reviews(company_id, freelancer_user_id, stars, comment) VALUES($1,$2,$3,$4)',
      [companyIds[ci], freelancerIds[fi], stars, comment]);
  }
  for (const cid of companyIds) {
    await db.query(
      `UPDATE companies SET rating_avg=(SELECT COALESCE(AVG(stars),0) FROM reviews WHERE company_id=$1),
        rating_count=(SELECT COUNT(*) FROM reviews WHERE company_id=$1) WHERE id=$1`, [cid]);
  }

  // applications: [jobIdx, freelancerIdx, proposal]
  const applications = [
    [0, 0, 'I built 6 restaurant sites last year. I can deliver in 10 days.'],
    [2, 2, 'I own a motorcycle and know Piassa very well.'],
    [6, 3, 'Math degree from Addis Ababa University, 4 years tutoring.'],
  ];
  for (const [ji, fi, proposal] of applications) {
    const a = await db.query('INSERT INTO applications(job_id, freelancer_user_id, proposal) VALUES($1,$2,$3) RETURNING id',
      [jobIds[ji], freelancerIds[fi], proposal]);
    const docs = (jobs[ji][7] || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const d of docs) {
      await db.query('INSERT INTO application_docs(application_id, doc_name, file_path) VALUES($1,$2,$3)',
        [a.rows[0].id, d, null]);
    }
  }

  console.log('seeded OK');
  console.log(`admin login: phone=${ADMIN_PHONE} password=${ADMIN_PASS}`);
  console.log('demo password for all other users: password123');
  if (!opts.keepAlive && typeof db.pool.end === 'function') await db.pool.end();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { main };
