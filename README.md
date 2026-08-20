# Calendar Booking

Personal Calendly-style booking: connect multiple Google calendars, share one link, show only open 30/45/60-minute slots, and create the event on the calendar you choose.

## Setup

1. **Install & env**

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | Local: `http://localhost:3000/api/auth/google/callback` |
| `TOKEN_ENCRYPTION_KEY` | 32+ chars; encrypts OAuth tokens (keep stable across deploys) |
| `SESSION_SECRET` | 32+ chars; admin cookie |
| `ADMIN_PASSWORD` | Password for `/admin` |
| `NEXT_PUBLIC_APP_URL` | Public base URL |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | **Required on Vercel** — persistent DB for OAuth tokens & settings |

2. **Google Cloud**

- Create a project and enable the **Google Calendar API**
- Configure OAuth consent screen
- Create an OAuth **Web** client
- Add **both** authorized redirect URIs in Google Cloud Console:
  - `http://localhost:3000/api/auth/google/callback` (local dev)
  - `https://www.chrismorell.xyz/api/auth/google/callback` (production)
- **Critical:** set Publishing status to **In production** (not Testing). While the app is in Testing, Google expires refresh tokens after **7 days** and guests will see broken booking until you reconnect.

3. **Vercel Production env**

Set these for the **Production** environment (not localhost values from `.env.example`):

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_APP_URL` | `https://www.chrismorell.xyz` |
| `GOOGLE_REDIRECT_URI` | `https://www.chrismorell.xyz/api/auth/google/callback` |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | From Turso |
| `TOKEN_ENCRYPTION_KEY` | Same stable value — never rotate without reconnecting Google |

After changing env vars, **redeploy production**. OAuth redirects derive from the live request host, but these env vars must still be correct for Google Cloud and booking links.

4. **Database (local vs Vercel)**

- **Local:** omit Turso vars; data is stored in `data/booking.db`
- **Vercel / serverless:** you **must** use [Turso](https://turso.tech). SQLite on `/tmp` is wiped when instances recycle.

After production is on Turso, open `/admin` — you should see “Persistent storage: Turso”. Then reconnect Google once on the **live site** (not localhost).

5. **Run**

```bash
npm run dev
```

- Admin: [http://localhost:3000/admin](http://localhost:3000/admin)
- Public booking: [http://localhost:3000/book/meet](http://localhost:3000/book/meet) (slug configurable in admin)

## How it works

1. Sign in at `/admin` and connect Google (personal and/or work — use **Add another Google account** for each)
2. Mark which calendars to **check for conflicts** (across all connected accounts)
3. Pick one calendar to **book into**
4. Set weekly hours, buffer, and durations
5. Copy your booking link and send it to clients

Availability uses Google Calendar `freebusy` on every conflict calendar, then filters your weekly windows. If Google is temporarily unavailable, guests still see times from your weekly hours (one dead account cannot brick the page).

Booking creates an event (with Meet link) on the destination calendar and invites the guest. Your **Notify email** (default `ctmorell@gmail.com`) is added as a calendar attendee so you receive the invite too.

If Google is down when someone books, the guest still gets confirmation and the booking is queued in **Pending bookings** in `/admin`. Reconnect Google and click **Send invite**.

## OAuth troubleshooting

| Symptom | Fix |
|---------|-----|
| `invalid_grant` every ~7 days | OAuth app still in **Testing** → set to **In production**, reconnect Google |
| Reconnect redirects to `localhost:3000` | Vercel `NEXT_PUBLIC_APP_URL` / `GOOGLE_REDIRECT_URI` still set to localhost → fix Production env and redeploy |
| `?error=unauthorized` after Google consent | Admin cookie was on a different host than the callback (e.g. apex vs www) → always use `https://www.chrismorell.xyz/admin` |
| Calendars “disconnect” after deploy | Turso env missing on Production, or `TOKEN_ENCRYPTION_KEY` changed |

Guests never see raw Google errors (`invalid_grant`, etc.). A broken grant only affects you in `/admin` (account marked **Needs reconnect**).
