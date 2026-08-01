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
| `GOOGLE_REDIRECT_URI` | e.g. `http://localhost:3000/api/auth/google/callback` |
| `TOKEN_ENCRYPTION_KEY` | 16+ chars; encrypts OAuth tokens |
| `SESSION_SECRET` | 32+ chars; admin cookie |
| `ADMIN_PASSWORD` | Password for `/admin` |
| `NEXT_PUBLIC_APP_URL` | Public base URL |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | **Required on Vercel** — persistent DB for OAuth tokens & settings |

2. **Google Cloud**

- Create a project and enable the **Google Calendar API**
- Configure OAuth consent screen
- Create an OAuth **Web** client
- Add authorized redirect URI matching `GOOGLE_REDIRECT_URI`
- Add your Google account as a test user if the app is in testing mode

3. **Database (local vs Vercel)**

- **Local:** omit Turso vars; data is stored in `data/booking.db`
- **Vercel / serverless:** you **must** use [Turso](https://turso.tech) (or any libSQL URL). SQLite on `/tmp` is wiped when instances recycle, which makes Google calendars look disconnected every few minutes.

```bash
# Example Turso setup
brew install tursodatabase/tap/turso   # or see turso.tech docs
turso auth login
turso db create calendar-booker
turso db show calendar-booker --url          # → TURSO_DATABASE_URL
turso db tokens create calendar-booker       # → TURSO_AUTH_TOKEN
```

Add both values in the Vercel project → **Settings → Environment Variables** for the
**Production** environment (not only Preview), then **merge this code to `main`** and
redeploy production. Preview deploys alone will not fix `calendar-booker.vercel.app`.

After production is on Turso, open `/admin` — you should see
“Persistent storage: Turso”. Then reconnect Google once (old `/tmp` tokens cannot migrate).

Keep `TOKEN_ENCRYPTION_KEY` stable across deploys; changing it makes stored tokens unreadable.

4. **Run**

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

Availability uses Google Calendar `freebusy` on every conflict calendar (queried per Google account), then filters your weekly windows. Booking creates an event (with Meet link) on the destination calendar and invites the guest.

Add each Google account you connect as a **test user** on the OAuth consent screen while the app is in testing mode.

After deploying with Turso, reconnect Google once in `/admin` — previous tokens stored in ephemeral `/tmp` SQLite will not migrate.
