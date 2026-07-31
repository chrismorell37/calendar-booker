import { google } from "googleapis";
import { decrypt, encrypt } from "./crypto";
import {
  getAccountById,
  getConflictCalendars,
  getDestinationCalendar,
  hasAnyGoogleAccount,
  listCalendars,
  listConnectedAccounts,
  saveOAuthAccount,
  updateAccountTokens,
  updateCalendarPrefs,
  upsertCalendarsForAccount,
} from "./db";

// Full calendar scope covers list, freebusy, and create events.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
];

function oauthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set",
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getGoogleAuthUrl(state?: string) {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: SCOPES,
    state,
  });
}

export async function exchangeCodeForTokens(code: string) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh token returned. Remove app access in Google Account permissions and try again.",
    );
  }
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const me = await oauth2.userinfo.get();
  const email = me.data.email;
  if (!email) {
    throw new Error("Google did not return an email for this account");
  }
  const accountId = saveOAuthAccount({
    accessTokenEncrypted: tokens.access_token ? encrypt(tokens.access_token) : null,
    refreshTokenEncrypted: encrypt(tokens.refresh_token),
    expiryDate: tokens.expiry_date ?? null,
    email,
  });
  await refreshCalendarListForAccount(accountId);
  return { email, accountId };
}

async function getAuthedClient(accountId: number) {
  const stored = getAccountById(accountId);
  if (!stored) {
    throw new Error("Google account not connected");
  }
  const client = oauthClient();
  client.setCredentials({
    access_token: stored.accessTokenEncrypted
      ? decrypt(stored.accessTokenEncrypted)
      : undefined,
    refresh_token: decrypt(stored.refreshTokenEncrypted),
    expiry_date: stored.expiryDate ?? undefined,
  });

  client.on("tokens", (tokens) => {
    const current = getAccountById(accountId);
    if (!current) return;
    updateAccountTokens(accountId, {
      accessTokenEncrypted: tokens.access_token
        ? encrypt(tokens.access_token)
        : current.accessTokenEncrypted,
      refreshTokenEncrypted: tokens.refresh_token
        ? encrypt(tokens.refresh_token)
        : undefined,
      expiryDate: tokens.expiry_date ?? current.expiryDate,
    });
  });

  return client;
}

export async function refreshCalendarListForAccount(accountId: number) {
  const auth = await getAuthedClient(accountId);
  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.calendarList.list({ maxResults: 250 });
  const items = (res.data.items ?? [])
    .filter((c) => c.id && c.summary)
    .map((c) => ({
      googleCalendarId: c.id!,
      summary: c.summary!,
    }));
  upsertCalendarsForAccount(accountId, items);

  const prefs = listCalendars();
  if (!prefs.some((p) => p.isDestination) && items.length > 0) {
    const primary =
      (res.data.items ?? []).find((c) => c.primary)?.id ?? items[0].googleCalendarId;
    updateCalendarPrefs(
      prefs.map((p) => ({
        googleCalendarId: p.googleCalendarId,
        checkConflicts: true,
        isDestination: p.googleCalendarId === primary,
      })),
    );
  }

  return listCalendars();
}

export async function refreshCalendarList() {
  const accounts = listConnectedAccounts();
  if (accounts.length === 0) {
    throw new Error("No Google accounts connected");
  }
  for (const account of accounts) {
    await refreshCalendarListForAccount(account.id);
  }
  return listCalendars();
}

export type BusyPeriod = { start: Date; end: Date };

export async function queryFreeBusy(
  timeMin: Date,
  timeMax: Date,
): Promise<BusyPeriod[]> {
  const conflictCals = getConflictCalendars();
  if (conflictCals.length === 0) return [];

  const byAccount = new Map<number, string[]>();
  for (const cal of conflictCals) {
    const list = byAccount.get(cal.accountId) ?? [];
    list.push(cal.googleCalendarId);
    byAccount.set(cal.accountId, list);
  }

  const busy: BusyPeriod[] = [];
  for (const [accountId, calendarIds] of byAccount) {
    const auth = await getAuthedClient(accountId);
    const calendar = google.calendar({ version: "v3", auth });
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: calendarIds.map((id) => ({ id })),
      },
    });
    const calendars = res.data.calendars ?? {};
    for (const id of calendarIds) {
      const periods = calendars[id]?.busy ?? [];
      for (const p of periods) {
        if (!p.start || !p.end) continue;
        busy.push({ start: new Date(p.start), end: new Date(p.end) });
      }
    }
  }
  return busy;
}

export async function createCalendarEvent(input: {
  calendarId: string;
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  timezone: string;
  attendeeEmail: string;
  attendeeName: string;
  additionalGuestEmails?: string[];
}) {
  const destination = getDestinationCalendar();
  if (!destination || destination.googleCalendarId !== input.calendarId) {
    // Still allow explicit calendarId if it matches a known calendar
  }
  const accountId =
    destination?.googleCalendarId === input.calendarId
      ? destination.accountId
      : listCalendars().find((c) => c.googleCalendarId === input.calendarId)?.accountId;

  if (!accountId) {
    throw new Error("Destination calendar is not linked to a Google account");
  }

  const primary = input.attendeeEmail.trim().toLowerCase();
  const extras = (input.additionalGuestEmails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e !== primary);
  const uniqueExtras = [...new Set(extras)];

  const auth = await getAuthedClient(accountId);
  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.events.insert({
    calendarId: input.calendarId,
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: {
        dateTime: input.start.toISOString(),
        timeZone: input.timezone,
      },
      end: {
        dateTime: input.end.toISOString(),
        timeZone: input.timezone,
      },
      attendees: [
        {
          email: input.attendeeEmail,
          displayName: input.attendeeName,
        },
        ...uniqueExtras.map((email) => ({ email })),
      ],
      conferenceData: {
        createRequest: {
          requestId: `booking-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });
  return res.data;
}

export function isGoogleConnected(): boolean {
  return hasAnyGoogleAccount();
}

export function getConnectedEmails(): string[] {
  return listConnectedAccounts().map((a) => a.email);
}
