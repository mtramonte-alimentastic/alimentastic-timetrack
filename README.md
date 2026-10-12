# Brand Time

Weekly brand time allocation for the marketing team. Each person logs hours worked
per day and splits them across brands; the tool reports the REPLOID share against
an 80% target and exports to Excel.

Entries are private: a person can only ever read and write their own weeks.
Only admins see the team view, the roster, the brand list and the export — and
that is enforced in the function, not just hidden in the interface.

---

## What's in here

```
public/index.html            the whole front end, one file, no build step
public/reports.html          the admin hours report (shown in the Reports tab), one file
netlify/functions/auth.mjs   signup / login / logout
netlify/functions/api.mjs    all data reads and writes, with the access checks
netlify/functions/identity.mjs  denies signups from addresses not on the allowlist
netlify/functions/seed.mjs   starting brand and task lists
netlify.toml                 build config and the /api + /auth routes
```

Storage is Netlify Blobs. No database to provision.

---

## Deploy (about 15 minutes)

### 1. Put it in Git and connect it

Push this folder to a GitHub repo, then in Netlify: **Add new project → Import an
existing project**, pick the repo, accept the detected settings, deploy.

Drag-and-drop deploy will *not* work — the functions need their dependencies
installed, which only happens on a Git-connected or CLI build. If you prefer the
CLI: `npm install`, then `netlify deploy --prod`.

### 2. Enable Identity

**Project configuration → Identity → Enable Identity.**

Then under **Registration**:

- Leave **Registration preferences** on **Open**. The allowlist below is what
  actually keeps people out, and it is more reliable than invite emails.
- Turn **confirmation emails off**: Emails → Confirmation template → Configure →
  allow signups without confirmation. Without this, people sign up and then can't
  log in until they click a link, and the link needs client-side code this build
  deliberately doesn't carry.

### 3. Set the environment variables

**Site configuration → Environment variables:**

| Variable | Value |
|---|---|
| `ALLOWED_EMAILS` | every team address that may create a login, comma-separated — this is also the roster the completion email checks against |
| `ADMIN_EMAILS` | your address (and anyone else who should see everyone's data) |
| `RESEND_API_KEY` | from resend.com — see below |
| `NOTIFY_EMAIL` | who receives the completion email — one address or several, comma-separated, e.g. `m.tramonte@alimentastic.com,other@alimentastic.com`. Recipients do not need to be in `ALLOWED_EMAILS` and do not need a login. If unset, it falls back to the first address in `ADMIN_EMAILS`. Until a sending domain is verified in Resend, only the address you signed up to Resend with can receive mail — see step 4 |
| `RESEND_FROM` | optional, see below |

```
ALLOWED_EMAILS = marco@…,luke@…,jessica@…,markus@…,sonja@…,ana@…,madlen@…,melanie@…,patrick@…
ADMIN_EMAILS   = marco@…
RESEND_API_KEY = re_xxxxxxxxxxxxxxxx
NOTIFY_EMAIL   = m.tramonte@alimentastic.com
```

`ALLOWED_EMAILS` fails safe: if it's empty, nobody can sign up, and the
completion check has no roster to compare against so it never fires.

Redeploy after setting them — functions read environment variables at deploy time.

### 4. Sign up for Resend and get an API key

resend.com → sign up with your work email → **API Keys** → create one → paste
it into `RESEND_API_KEY`. No domain or card needed to get started.

One limit worth knowing: until you verify a sending domain, Resend's shared
sandbox address only delivers **to the email you signed up with**. So if
`m.tramonte@alimentastic.com` is also the Resend account email, this works out
of the box. If you'd rather send from your own domain (`brandtime@alimentastic.com`,
say), add and verify it under **Domains** in Resend, then set `RESEND_FROM` to
that address — a few DNS records, a few minutes to propagate.

### 5. First run

Open the site, click **First time here? Create a login**, use your own work
address. Because you're in `ADMIN_EMAILS` you'll see all five tabs, and the brand
list is written on your first visit.

Go to **Brands** before you tell anyone else about it. See the notes below.

---

## Closing a week and the completion email

A week **closes** the moment every address in `ALLOWED_EMAILS` has submitted it.
From then on nobody can change or reopen it — saves are refused, the week shows
as read-only with a "closed" banner, and the Submit button disappears. Until the
last person submits, anyone can still reopen and correct their own week.

At the moment of closing, the app builds the week's Excel file and emails it to
`NOTIFY_EMAIL`. **One email per week, ever.** The close is an atomic
write-only-if-new in Netlify Blobs, so even if the last two people submit in the
same second, exactly one of them closes the week and sends the email. The store
is also read with strong consistency, so a recent change is never read stale.

"Everyone" means everyone in `ALLOWED_EMAILS` — not everyone who has ever opened
the tool. An address listed twice counts once. **A week cannot close until every
listed person has submitted**, so remove anyone who has left from
`ALLOWED_EMAILS` (and redeploy), or their week will hold it open.

If Resend rejects the send (bad key, sandbox restriction, etc.) the week is
**not** closed: the claim is released, the submission is kept, and the next save
of a submitted week tries again. The error shows up in the function logs
(**Logs -> Functions -> api** in the Netlify dashboard), not to the person
submitting — check there first if an expected email doesn't arrive.

Weeks that were already emailed under the previous version count as closed.

There is currently **no way to reopen a closed week** — by design, a closed week
is final. If that ever becomes a real need, it should be built as an explicit
admin "reopen" action rather than done by hand in the Blobs browser: removing the
`closed/<week>` entry alone would not work, because everyone is still marked
submitted and the very next save would close the week again and send another
email.

---

## Reports (admins only)

Admins get a **Reports** tab: the hours report, built on the same data people enter
in Brand Time, so nothing has to be exported and uploaded by hand. It has the same
layout as the standalone "Stundenreport" it was modelled on, in English:

- **Overview** — KPI cards (total, Reploid, diverse brands, General), expandable
  brand bars, hours per calendar week, and a table by department.
- **Investor report** — a ready-to-copy summary text, a Reploid / diverse brands /
  General split, a per-month table, focus areas per brand.
- **By brand** — one brand at a time: text, KPIs, activities, hours by week.
  Employee names are hidden by default, and notes are never shown here.
- **Review** — who has not submitted which week (with one-click "Remind" emails
  that open in Outlook), and findings in the data: BMD differences, brands named in
  notes, 0 h rows, days with hours worked but nothing assigned. Findings can be
  marked "all good".
- **Data** — every entry, searchable.
- **Settings** — how "General" hours are allocated, which brands count as Reploid,
  start week, hourly rates, and the people list (start / leaving dates).
- **More** menu — Excel exports (report, investor report, one brand, all brands).

Period selector: Week, Month or All. Reports read the live data each time the tab
opens; use **More -> Refresh data** to reload without leaving the page.

What the report counts, and how it differs from Excel uploads:

- **Only submitted weeks count** by default, so the numbers are finished ones. Hours
  in weeks that are not submitted yet are shown as "Not yet counted"; switch on
  "Include weeks not yet submitted" in Settings to count them too.
- **One department.** Brand Time covers Marketing only, so "By department" has a
  single column. The structure is there for when other departments are added.
- **Groups are the report's own.** A brand's group in the report (Reploid / Diverse /
  Do not report) is set in Reports -> Settings and is separate from the group on the
  Brands tab. The defaults are those of the original report: REPLOID, Beak Bandits,
  Huhnglaublich and Schnauze & Co. are Reploid, the rest are diverse brands, and
  internal categories plus Alimentastic count as General. **Check this once** in
  Settings (for example ReGreen and Vitus).
- **Automatic assignment is on.** A General row whose note names a brand is counted
  for that brand (e.g. a note "Regreen" on an Alimentastic row), and is listed under
  Review. Switch it off in Settings if you would rather it never moves hours.
- **Tasks, not notes, are the "content"** shown in brand reports and the investor
  report. Notes stay internal (Review and Data tabs only).
- The upload, demo-data and AI-review features of the original are not included, as
  they exist only because that tool reads Excel files.

Technical notes: the report is a separate page (`reports.html`) loaded in a frame, so
its styles cannot clash with the rest of the app. It reads from two admin-only API
operations (`reports`, `reports-save`); non-admins get a 403 even if they open
`/reports.html` directly. Report settings, excused weeks, "all good" marks and people
details are stored in Netlify Blobs under `reports/`. `netlify.toml` allows framing
from the same site only (`X-Frame-Options: SAMEORIGIN`).

---

## Things to check before rollout

**Already deployed and the brand list is wrong?** The Brands tab has a
"Load standard list (13 brands)" button — click it and it replaces
whatever's there with the corrected 13-brand list below in one write, no
need to archive each old entry by hand. Historic weeks that referenced an
archived or removed brand still show it as "(archived)" in their own row,
so nothing already submitted is lost.

**Standard list:** Alimentastic, Beak Bandits, feelfood, GYW, HappyChicken,
Huhnglaublich, Moments, ReGreen, REPLOID, Schnauze & Co., Vifon, Vitus — all
REPLOID — plus White-label client work and New business/pitches (external),
and Team & planning / Admin & reporting / Recruiting & onboarding / Learning
& development (internal).

**Two shares exist, but only admins see either one.** The REPLOID-share
gauge is admin-only now — the person filling in their own hours just sees
the day list, not a percentage. "REPLOID share of hours worked" counts
overhead in the denominator; "excluding overhead" counts only client-facing
time. Decide which one you'll actually manage against.

**BMD stays the record.** This is self-reported allocation. Say so when you
introduce it, and expect daily totals to drift from BMD by a few minutes —
anything over about half an hour a day is worth a question, not an error.

**Austria.** Per-person time data that produces brand-level reporting is
Leistungskontrolle. Private-by-default helps the argument; it does not replace the
Betriebsrat conversation. Have that before rollout, not after.

---

## Known limits

- **Auth doesn't work under `netlify dev`.** Identity endpoints aren't available
  locally. Test on a deploy preview.
- **Password login only.** Google sign-in via Identity needs client-side
  `oauthLogin()` and `handleAuthCallback()`, which would mean adding a bundler.
  Worth doing if people complain about another password; not worth it on day one.
- **Password reset** isn't wired up. For nine people, resetting from
  **Identity → Users** in the Netlify dashboard is faster than building the flow.
- **Export reads every stored week** and filters by date in the browser. Fine at
  ten people for a couple of years; if it ever gets slow, that's the thing to fix.
