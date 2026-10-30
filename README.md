# SiraLink — Ethiopian Freelance Platform

Verified companies post online/offline jobs, freelancers browse and apply.
Bilingual (English + Amharic), mobile-first. Node.js + Express + EJS + PostgreSQL.

## Run locally (no database needed)

```bash
npm install
npm run dev        # starts with in-memory Postgres (pg-mem), auto-seeds demo data
```

Open http://localhost:3000

- `npm run dev` = `USE_PGMEM=1 node server.js` (seed runs automatically on first boot)
- To reseed: delete is not needed — seed skips when users exist.

### Demo logins (password for all demo users: `password123`)

| Role | Phone | Password | Notes |
|---|---|---|---|
| Admin | `0911000000` | `admin123` | approve companies, receipts, see stats |
| Company (verified) | `0911222333` | `password123` | Addis Digital Studio |
| Company (pending) | `0911888999` | `password123` | Lalibela Crafts PLC — cannot post until verified |
| Freelancer | `0922000111` | `password123` | Abebe Tesfaye, web dev |

The seed includes ~10 companies, ~20 jobs, reviews, applications, and one
**pending telebirr receipt** so the admin panel has something to approve.

## Run against real Postgres

```bash
export DATABASE_URL="postgres://user:pass@host:5432/siralink"
node db/migrate.js
node db/seed.js        # optional demo data (also creates the admin account)
node server.js         # or: npm start
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string (production) |
| `USE_PGMEM` | — | Set `1` for in-memory DB (local dev/test) |
| `SESSION_SECRET` | `siralink-dev-secret-change-me` | Session signing secret — **change in production** |
| `TELEBIRR_NUMBER` | `0911 23 45 67` | Number companies send the job-post fee to |
| `JOB_POST_FEE_ETB` | `99` | Fee per job post, in ETB |
| `PORT` | `3000` | HTTP port |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID (enables "Continue with Google") |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `BASE_URL` | `https://siralink.onrender.com` | Public base URL (used for the Google OAuth callback) |

## Google Sign-In setup (optional)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials.
2. Create Credentials → OAuth client ID → Web application.
3. Under "Authorized redirect URIs" add exactly:
   `https://siralink.onrender.com/auth/google/callback`
4. Copy the Client ID and Client secret into Render → your service → Environment:
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then save (triggers a redeploy).
5. The "Continue with Google" buttons appear on the sign-in / sign-up pages.
   Without these vars the buttons stay hidden and password sign-in works as before.

## Deploy for free: Render (app) + Neon (database)

Both have permanent free tiers, no credit card required.

### 1. Push to GitHub
```bash
git init && git add . && git commit -m "SiraLink v1"
# create a repo on github.com, then:
git remote add origin https://github.com/<you>/siralink.git
git push -u origin main
```

### 2. Neon — free Postgres
1. Sign up at neon.tech (email — you must click the verification link).
2. Create a project (region: EU closest to you), copy the **connection string**.
3. In the Neon SQL editor, paste the contents of `db/schema.sql` and run it.
4. Optional: seed demo data + admin account by running locally once with the
   Neon URL: `DATABASE_URL="<neon-string>" node db/seed.js`

### 3. Render — free web service
1. Sign up at render.com (email — click the verification link).
2. **New → Web Service** → connect your GitHub repo.
3. Settings: Build command `npm install`, Start command `npm start`, plan **Free**.
4. Environment variables:
   - `DATABASE_URL` = your Neon connection string
   - `SESSION_SECRET` = any long random string
   - `TELEBIRR_NUMBER` = your real telebirr number
   - `NODE_ENV` = `production`
5. Deploy. Your app lives at `https://<name>.onrender.com`.

Free-tier notes: the service sleeps after ~15 min idle and wakes in ~1 min
on the next visit. The database stays up (Neon scales to zero and wakes per query).

## How it works

- **Sign up** → choose Freelancer or Company → role questions → land on home.
- **Company** → dashboard → Post a job (step 1: details + required documents)
  → step 2: send fee via telebirr, upload receipt → job is **hidden** until admin approves.
- **Admin** (`/admin`) → verify companies, approve/reject receipts (approval publishes the job), stats, users, jobs.
- **Freelancer** → job page → Apply now → proposal + upload exactly the documents
  the company listed → company sees applicants with documents, accepts/rejects.
- **Reviews** → freelancers rate companies (stars + comment); aggregates show on
  job cards and company pages.
- **Language** → EN/አማ toggle in the header, stored in a cookie.

## Honest limitations

- **File uploads** (`uploads/`) live on local disk. Render's free disk is
  **ephemeral** — uploaded receipts/documents can disappear on redeploy/restart.
  For production, move uploads to Supabase Storage or S3 (the `lib/upload.js`
  file is the single place to swap).
- **Sessions** use the default in-memory store — fine for one free instance,
  but logins reset on restart. Use `connect-pg-simple` for persistent sessions later.
- **Payments** are manual (telebirr receipt + admin approval). Upgrade path:
  Chapa gateway when the business is registered.
- No email/SMS verification yet — phone numbers are trusted on signup.
