// Google OAuth setup. Only active when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
// env vars are set; otherwise googleEnabled=false and nothing is initialized.
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const googleEnabled = !!(GOOGLE_ID && GOOGLE_SECRET);
let passport = null;
if (googleEnabled) {
  passport = require('passport');
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  const BASE = (process.env.BASE_URL || 'https://siralink.onrender.com').replace(/\/$/, '');
  passport.use(new GoogleStrategy(
    {
      clientID: GOOGLE_ID,
      clientSecret: GOOGLE_SECRET,
      callbackURL: BASE + '/auth/google/callback',
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  ));
}
module.exports = { googleEnabled, passport };
