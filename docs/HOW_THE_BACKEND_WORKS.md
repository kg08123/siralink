# How the SiraLink Backend Works

A plain-English map of the server: what each part does, how a request travels
through it, and where your data lives. Written for the owner of this codebase.

---

## 1. The big picture

SiraLink is a classic **server-rendered web app**. There is no separate frontend
app — the server builds every HTML page itself and sends it to the phone.

```
Your phone  →  Render (runs server.js)  →  Neon (PostgreSQL database)
     ↑                    |
     └──── HTML page ─────┘
```

One request, step by step:

1. You tap a link. Your phone sends an HTTP request, e.g. `GET /jobs/21`.
2. **Render** (the free host) receives it and hands it to our Node.js process.
3. **Express** (the web framework, in `server.js`) runs the request through a
   chain of middleware, then finds the matching **route**.
4. The route function queries **PostgreSQL** (the database, hosted on Neon)
   for the data it needs.
5. The route renders an **EJS template** (a HTML file with placeholders in
   `views/`) filled with that data.
6. The finished HTML goes back to your phone. The phone just displays it —
   almost no JavaScript runs on it.

That is the whole architecture. Everything below is detail on these steps.

---

## 2. The pieces (repo map)

| Path | What it is |
|---|---|
| `server.js` | The entry point. Sets up Express, connects to the DB, registers middleware and routes, then listens for requests. |
| `routes/` | The "controllers". One file per area: `index.js` (home, jobs, likes), `auth.js` (signup/signin/Google), `freelancer.js`, `company.js`, `messages.js`, `admin.js`. Each maps URLs to functions. |
| `views/` | EJS templates — the HTML pages. `layout.ejs` is the shared shell (header, language toggle); the rest are pages plugged into it. |
| `db/schema.sql` | The database blueprint: all tables, created automatically on boot. |
| `db/seed.js` | Demo data (18 jobs, 10 companies, 6 freelancers) used for local testing. |
| `lib/` | Helpers: `notify.js` (platform notifications), `google.js` (Google login setup), `upload.js` (file uploads), `icons.js` (SVG icons). |
| `middleware/` | Small reusable checks (e.g. "must be logged in", "must be admin"). |
| `i18n.js` | English/Amharic translations. `?lang=am` switches language. |
| `public/` | Static files served as-is: CSS, client JS. |
| `uploads/` | Uploaded files (payment receipts, application documents). **Ephemeral on Render** — wiped on redeploy/restart. Known limitation; swap `lib/upload.js` for cloud storage later. |

---

## 3. The database (14 tables)

PostgreSQL on Neon (free tier, Frankfurt). `server.js` runs `db/schema.sql` on
every boot with `IF NOT EXISTS`, so tables are created automatically, and later
changes are applied as idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

Core chain — how the tables connect:

```
users  →  freelancers        (1 user has 1 freelancer profile)
users  →  companies          (1 user has 1 company profile)
companies → jobs             (a company posts many jobs)
jobs → applications          (freelancers apply; each row = 1 application)
applications → application_docs   (the files the company asked for)
applications → conversations      (created automatically when company ACCEPTS)
conversations → messages          (the chat; images stored as base64 text)
users → notifications             (platform messages: "New application", …)
```

Supporting tables:

| Table | Purpose |
|---|---|
| `users` | Everyone. `role` = freelancer / company / admin. Password is a bcrypt hash (never plain text). Also `google_id`, `avatar_url`, `email` for Google sign-in. |
| `payments` | Company's telebirr/CBE receipt upload per job post. Admin approves → job goes live. |
| `job_likes` | Star taps on jobs (one row per user per job). |
| `reviews` | Text reviews on jobs/freelancers. |
| `conversation_reads` | Tracks what each user has read → drives the unread badge. |

---

## 4. How one request is handled (the middleware chain)

In `server.js`, every request passes through these layers **in order** before
reaching a route:

1. **Body parsers** — read form data and JSON from the request.
2. **Static files** — if the URL is `/css/...` or `/uploads/...`, serve the file immediately, skip the rest.
3. **Session** — reads the session cookie, so the server knows *who you are* (`req.session.userId`). Sessions live **in server memory** (reset on restart — known limitation).
4. **Language** — `?lang=am` / `?lang=en` or saved cookie decides the translation.
5. **Attach user** — loads your `users` row (and `companies` row if you're a company) so every page knows your name, role, etc.
6. **Unread badge count** — counts unread chat messages + unread platform notifications for the header icon.
7. **24h reminder sweep** — checks for job applications sitting in `pending` for over 24h and nudges the company. Runs at most once every 10 minutes (lazy scheduler — this is how we do "cron" with no cron service on the free tier).
8. **Flash messages** — one-time notices ("Application sent") stored in the session.
9. **Route** — finally, the matching route function runs (see §6).
10. If no route matched → 404 page. If a route throws → error page.

---

## 5. Auth: how login works

- **Phone + password signup/login** (`routes/auth.js`): password is hashed with
  **bcrypt** before storing. On login, the server puts your user id in the
  session and gives your phone a session **cookie**. Every later request sends
  that cookie back, so the server recognizes you (step 5 above).
- **Google sign-in** (`lib/google.js` + passport): "Continue with Google" →
  Google → back to `/auth/google/callback`. If your Google id is known, you're
  logged in. If not, you're sent to `/signup/google` to pick a role and answer
  the questions, then the account is created linked to Google. Needs
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars (already set on Render).
- **Admin** is just a user with `role='admin'`, gated by middleware on every
  `/admin/*` route. Admin login: phone `0911000000`.

---

## 6. The key flows (routes in action)

**Post a job (company)** — `GET /c/post` (form) → `POST /c/post` saves the job
as unpaid → redirect to `/c/post/payment/:jobId` → company uploads the
telebirr/CBE receipt (`POST`, saved to `uploads/` + `payments` row) → admin
approves in `/admin/payments` → job goes live on home.

**Apply (freelancer)** — `GET /f/apply/:jobId` shows exactly the documents the
company listed → `POST /f/apply/:jobId` saves the `applications` row + files in
`application_docs` → `lib/notify.js` writes a **notification** row for the
company user ("New application"). The company sees it under the **Platform**
section in the chat inbox.

**Accept / reject (company)** — `POST /c/applications/:id/status` on the
applicants page → on **accept**, a `conversations` row is auto-created between
company and freelancer, and the freelancer gets a notification ("Application
approved — you can now chat"). On **reject**, the freelancer gets a polite
notification. Only after accept can the two message each other (freelancers
can't start chats).

**Messaging** — `GET /messages` (inbox: Platform section + Chats) →
`GET /messages/:id` (thread). Sending is `POST /messages/:id`: text and/or an
image (stored as a base64 data-URL in `messages.image_data`, so it survives
restarts). The thread polls `/:id/json` every 5 seconds for new messages.

**Search** — `GET /` with `?q=...`: splits the query into words and matches
them across job title, description, company name and city, ranked by relevance,
order-independent.

---

## 7. Deploy: how code becomes the live site

```
git push origin master  →  GitHub (kg08123/siralink)
                                ↓  (Render watches the repo)
                          Render rebuilds  →  npm install + node server.js
                                ↓
                          siralink.onrender.com is live (~1 min)
```

- **Render** (free, Frankfurt): runs the Node process. Sleeps after 15 min idle
  → first visit takes ~30s to wake.
- **Neon** (free, Frankfurt): the PostgreSQL database. `server.js` connects via
  the `DATABASE_URL` env var.
- **Env vars** (Render dashboard → Environment): `DATABASE_URL`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TELEBIRR_NUMBER` (still the
  placeholder — update to the real number), `SESSION_SECRET`.
- **Local dev**: `USE_PGMEM=1 node server.js` runs the whole app against an
  in-memory fake Postgres — no Neon needed.

---

## 8. Limits worth knowing (all by design, $0 stack)

1. `uploads/` is wiped on redeploy/restart (Render free has no persistent disk).
   Chat images are safe (base64 in the DB); receipts and application docs are not.
2. Sessions live in memory — everyone gets logged out on restart.
3. No real cron — the 24h reminder is a lazy check inside the request pipeline.
4. No phone/email verification on signup yet.
5. Google OAuth is in **testing mode** — only approved test accounts can use
   "Continue with Google" until the app is published.

---

*Last updated 2026-10-30. If the code changes, update this doc with it.*
