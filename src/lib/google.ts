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
import {
  GoogleAccountAuthError,
  isGoogleAuthFailure,
} from "./errors";
import type { CalendarPref } from "./types";

// Calendar for availability/booking; Gmail send for host booking alerts.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.send",
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
  const accountId = await saveOAuthAccount({
    accessTokenEncrypted: tokens.access_token ? encrypt(tokens.access_token) : null,
    refreshTokenEncrypted: encrypt(tokens.refresh_token),
    expiryDate: tokens.expiry_date ?? null,
    email,
  });
  await refreshCalendarListForAccount(accountId);
  return { email, accountId };
}

async function persistRefreshedTokens(
  accountId: number,
  tokens: {
    access_token?: string | null;
    refresh_token?: string | null;
    expiry_date?: number | null;
  },
) {
  const current = await getAccountById(accountId);
  if (!current) return;
  await updateAccountTokens(accountId, {
    accessTokenEncrypted: tokens.access_token
      ? encrypt(tokens.access_token)
      : current.accessTokenEncrypted,
    refreshTokenEncrypted: tokens.refresh_token
      ? encrypt(tokens.refresh_token)
      : undefined,
    expiryDate: tokens.expiry_date ?? current.expiryDate,
  });
}

async function getAuthedClient(accountId: number) {
  const stored = await getAccountById(accountId);
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

  // On serverless, await token persistence — fire-and-forget can be dropped
  // when the isolate freezes after the response is sent.
  const needsRefresh =
    !stored.accessTokenEncrypted ||
    !stored.expiryDate ||
    stored.expiryDate <= Date.now() + 60_000;
  if (needsRefresh) {
    try {
      const { credentials } = await client.refreshAccessToken();
      await persistRefreshedTokens(accountId, credentials);
      client.setCredentials(credentials);
    } catch (err) {
      if (isGoogleAuthFailure(err)) {
        throw new GoogleAccountAuthError(accountId, stored.email, err);
      }
      throw err;
    }
  }

  client.on("tokens", (tokens) => {
    void persistRefreshedTokens(accountId, tokens).catch((err) => {
      console.error("Failed to persist refreshed Google tokens", err);
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
  await upsertCalendarsForAccount(accountId, items);

  const prefs = await listCalendars();
  if (!prefs.some((p) => p.isDestination) && items.length > 0) {
    const primary =
      (res.data.items ?? []).find((c) => c.primary)?.id ?? items[0].googleCalendarId;
    await updateCalendarPrefs(
      prefs.map((p) => ({
        googleCalendarId: p.googleCalendarId,
        checkConflicts: true,
        isDestination: p.googleCalendarId === primary,
      })),
    );
  }

  return listCalendars();
}

export type AccountRefreshError = {
  id: number;
  email: string;
  message: string;
};

export async function refreshCalendarList(): Promise<{
  calendars: CalendarPref[];
  accountErrors: AccountRefreshError[];
}> {
  const accounts = await listConnectedAccounts();
  if (accounts.length === 0) {
    throw new Error("No Google accounts connected");
  }
  const accountErrors: AccountRefreshError[] = [];
  let okCount = 0;
  for (const account of accounts) {
    try {
      await refreshCalendarListForAccount(account.id);
      okCount += 1;
    } catch (err) {
      console.error(`Calendar refresh failed for ${account.email}`, err);
      const message =
        err instanceof GoogleAccountAuthError
          ? err.message
          : isGoogleAuthFailure(err)
            ? `Google access for ${account.email} expired or was revoked. Disconnect and reconnect that account.`
            : err instanceof Error
              ? err.message
              : "Failed to refresh calendars";
      accountErrors.push({
        id: account.id,
        email: account.email,
        message,
      });
    }
  }
  if (okCount === 0) {
    throw new Error(
      accountErrors.map((e) => e.message).join(" ") ||
        "All Google accounts need to be reconnected in Admin.",
    );
  }
  return { calendars: await listCalendars(), accountErrors };
}

export type AccountAuthStatus = {
  id: number;
  email: string;
  ok: boolean;
  error?: string;
};

/** Probe each connected account's refresh token (admin-only). */
export async function getAccountAuthStatuses(): Promise<AccountAuthStatus[]> {
  const accounts = await listConnectedAccounts();
  const statuses: AccountAuthStatus[] = [];
  for (const account of accounts) {
    try {
      await getAuthedClient(account.id);
      statuses.push({ id: account.id, email: account.email, ok: true });
    } catch (err) {
      console.error(`Google auth check failed for ${account.email}`, err);
      statuses.push({
        id: account.id,
        email: account.email,
        ok: false,
        error:
          err instanceof GoogleAccountAuthError
            ? err.message
            : isGoogleAuthFailure(err)
              ? `Google access for ${account.email} expired or was revoked. Disconnect and reconnect that account.`
              : err instanceof Error
                ? err.message
                : "Google authentication failed",
      });
    }
  }
  return statuses;
}

export type BusyPeriod = { start: Date; end: Date };

export async function queryFreeBusy(
  timeMin: Date,
  timeMax: Date,
): Promise<BusyPeriod[]> {
  const conflictCals = await getConflictCalendars();
  if (conflictCals.length === 0) return [];

  const byAccount = new Map<number, string[]>();
  for (const cal of conflictCals) {
    const list = byAccount.get(cal.accountId) ?? [];
    list.push(cal.googleCalendarId);
    byAccount.set(cal.accountId, list);
  }

  const busy: BusyPeriod[] = [];
  let okAccounts = 0;
  let lastAuthError: unknown = null;

  for (const [accountId, calendarIds] of byAccount) {
    try {
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
      okAccounts += 1;
    } catch (err) {
      lastAuthError = err;
      const account = await getAccountById(accountId);
      console.error(
        `Skipping freebusy for account ${account?.email ?? accountId}`,
        err,
      );
      if (!isGoogleAuthFailure(err)) {
        throw err;
      }
      // Keep checking other accounts so one revoked token cannot brick booking.
    }
  }

  if (okAccounts === 0) {
    if (lastAuthError instanceof GoogleAccountAuthError) {
      throw lastAuthError;
    }
    if (isGoogleAuthFailure(lastAuthError)) {
      throw new GoogleAccountAuthError(0, null, lastAuthError);
    }
    throw lastAuthError instanceof Error
      ? lastAuthError
      : new Error("Could not check calendar availability");
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
  const destination = await getDestinationCalendar();
  if (!destination || destination.googleCalendarId !== input.calendarId) {
    // Still allow explicit calendarId if it matches a known calendar
  }
  const accountId =
    destination?.googleCalendarId === input.calendarId
      ? destination.accountId
      : (await listCalendars()).find((c) => c.googleCalendarId === input.calendarId)
          ?.accountId;

  if (!accountId) {
    throw new Error("Destination calendar is not linked to a Google account");
  }

  const primary = input.attendeeEmail.trim().toLowerCase();
  const extras = (input.additionalGuestEmails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e !== primary);
  const uniqueExtras = [...new Set(extras)];

  let auth;
  try {
    auth = await getAuthedClient(accountId);
  } catch (err) {
    if (isGoogleAuthFailure(err) && !(err instanceof GoogleAccountAuthError)) {
      const account = await getAccountById(accountId);
      throw new GoogleAccountAuthError(accountId, account?.email ?? null, err);
    }
    throw err;
  }
  const calendar = google.calendar({ version: "v3", auth });
  try {
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
  } catch (err) {
    if (isGoogleAuthFailure(err) && !(err instanceof GoogleAccountAuthError)) {
      const account = await getAccountById(accountId);
      throw new GoogleAccountAuthError(accountId, account?.email ?? null, err);
    }
    throw err;
  }
}

export async function isGoogleConnected(): Promise<boolean> {
  return hasAnyGoogleAccount();
}

export async function getConnectedEmails(): Promise<string[]> {
  return (await listConnectedAccounts()).map((a) => a.email);
}

function encodeRfc2047Subject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Send a plain-text email from a connected Google account via Gmail API. */
export async function sendGmailMessage(input: {
  accountId: number;
  to: string;
  subject: string;
  body: string;
}) {
  const auth = await getAuthedClient(input.accountId);
  const gmail = google.gmail({ version: "v1", auth });
  const fromAccount = await getAccountById(input.accountId);
  const bodyBase64 = Buffer.from(input.body, "utf8").toString("base64");
  const headers = [
    ...(fromAccount?.email ? [`From: ${fromAccount.email}`] : []),
    `To: ${input.to}`,
    `Subject: ${encodeRfc2047Subject(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const mime = [...headers, "", bodyBase64].join("\r\n");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: toBase64Url(mime) },
  });
}

export async function notifyHostOfBooking(input: {
  to: string;
  guestName: string;
  guestEmail: string;
  guestEmails?: string[];
  notes?: string;
  summary: string;
  start: Date;
  end: Date;
  timezone: string;
  hangoutLink?: string | null;
  htmlLink?: string | null;
}) {
  const to = input.to.trim();
  if (!to) return;

  const destination = await getDestinationCalendar();
  if (!destination) {
    throw new Error("No destination calendar for host notification email");
  }

  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(input.start);

  const durationMins = Math.round(
    (input.end.getTime() - input.start.getTime()) / 60_000,
  );

  const lines = [
    "A new meeting was booked on your booking page.",
    "",
    `Title: ${input.summary}`,
    `When: ${when}`,
    `Duration: ${durationMins} minutes`,
    `Guest: ${input.guestName} <${input.guestEmail}>`,
  ];
  if (input.guestEmails?.length) {
    lines.push(`Additional guests: ${input.guestEmails.join(", ")}`);
  }
  if (input.notes?.trim()) {
    lines.push(`Notes: ${input.notes.trim()}`);
  }
  if (input.hangoutLink) {
    lines.push(`Meet: ${input.hangoutLink}`);
  }
  if (input.htmlLink) {
    lines.push(`Calendar: ${input.htmlLink}`);
  }

  await sendGmailMessage({
    accountId: destination.accountId,
    to,
    subject: `New booking: ${input.summary}`,
    body: lines.join("\n"),
  });
}
