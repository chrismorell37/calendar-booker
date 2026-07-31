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

2. **Google Cloud**

- Create a project and enable the **Google Calendar API**
- Configure OAuth consent screen
- Create an OAuth **Web** client
- Add authorized redirect URI matching `GOOGLE_REDIRECT_URI`
- Add your Google account as a test user if the app is in testing mode

3. **Run**

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

SQLite data lives in `data/booking.db` (created automatically).
