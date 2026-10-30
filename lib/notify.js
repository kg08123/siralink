// Platform notifications. title/body are stored as JSON {k: i18nKey, p: [params]}
// so they render in each viewer's own language via nt() in i18n.js.
async function notify(db, userId, kind, link, titleKey, bodyKey, params) {
  await db.query(
    'INSERT INTO notifications(user_id, kind, title, body, link) VALUES($1,$2,$3,$4,$5)',
    [userId, kind, JSON.stringify({ k: titleKey }), JSON.stringify({ k: bodyKey, p: params || [] }), link || null]
  );
}
module.exports = { notify };
