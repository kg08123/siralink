function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/signin');
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/signin');
    if (req.user.role !== role) return res.status(403).render('403');
    next();
  };
}
module.exports = { requireAuth, requireRole };
