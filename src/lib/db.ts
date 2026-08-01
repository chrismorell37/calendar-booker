import { createClient, type Client, type InArgs, type ResultSet } from "@libsql/client";
import fs from "fs";
import path from "path";
import {
  DEFAULT_SETTINGS,
  type CalendarPref,
  type ConnectedAccount,
  type HostSettings,
  type OAuthTokenRow,
  type WeeklyHours,
} from "./types";

let clientInstance: Client | null = null;
let initPromise: Promise<Client> | null = null;

export type StorageBackend = "turso" | "local-file";

/** Which persistence backend is active (does not open a connection). */
export function getStorageBackend(): StorageBackend {
  return process.env.TURSO_DATABASE_URL ? "turso" : "local-file";
}

function createDbClient(): Client {
  const tursoUrl = process.env.TURSO_DATABASE_URL?.trim();
  const tursoToken = process.env.TURSO_AUTH_TOKEN?.trim();

  if (tursoUrl) {
    if (!tursoToken) {
      throw new Error(
        "TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is set.",
      );
    }
    return createClient({
      url: tursoUrl,
      authToken: tursoToken,
    });
  }

  // Vercel /tmp is ephemeral: each serverless instance gets its own empty DB,
  // so OAuth tokens and calendar prefs appear to "disconnect" within minutes.
  if (process.env.VERCEL) {
    throw new Error(
      "Persistent storage required on Vercel. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (Production env), merge this fix to main, redeploy, then reconnect Google in /admin.",
    );
  }

  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = process.env.SQLITE_PATH || path.join(dataDir, "booking.db");
  return createClient({ url: `file:${dbPath}` });
}

async function migrateLegacy(client: Client) {
  const calCols = await client.execute(`PRAGMA table_info(calendars)`);
  const hasAccountId = calCols.rows.some((c) => c.name === "account_id");
  if (calCols.rows.length > 0 && !hasAccountId) {
    await client.execute(`ALTER TABLE calendars ADD COLUMN account_id INTEGER`);
  }

  const tables = await client.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_tokens'`,
  );
  if (tables.rows.length === 0) return;

  const legacyRes = await client.execute(
    `SELECT access_token_encrypted, refresh_token_encrypted, expiry_date, email, updated_at
     FROM oauth_tokens WHERE id = 1`,
  );
  const legacyRow = legacyRes.rows[0];
  if (!legacyRow) {
    await client.execute("DROP TABLE IF EXISTS oauth_tokens");
    return;
  }

  const legacyEmail =
    legacyRow.email == null ? null : String(legacyRow.email);
  const legacyRefresh =
    legacyRow.refresh_token_encrypted == null
      ? null
      : String(legacyRow.refresh_token_encrypted);

  if (legacyEmail && legacyRefresh) {
    const existing = await client.execute({
      sql: "SELECT id FROM oauth_accounts WHERE email = ?",
      args: [legacyEmail],
    });
    let accountId = existing.rows[0]?.id as number | undefined;
    if (!accountId) {
      const info = await client.execute({
        sql: `INSERT INTO oauth_accounts (email, access_token_encrypted, refresh_token_encrypted, expiry_date, updated_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          legacyEmail,
          legacyRow.access_token_encrypted == null
            ? null
            : String(legacyRow.access_token_encrypted),
          legacyRefresh,
          legacyRow.expiry_date == null ? null : Number(legacyRow.expiry_date),
          String(legacyRow.updated_at ?? new Date().toISOString()),
        ],
      });
      accountId = Number(info.lastInsertRowid);
    }
    await client.execute({
      sql: `UPDATE calendars SET account_id = ? WHERE account_id IS NULL OR account_id = 0`,
      args: [accountId],
    });
  }

  await client.execute("DROP TABLE IF EXISTS oauth_tokens");
}

async function seedDefaults(client: Client) {
  const countRes = await client.execute("SELECT COUNT(*) AS c FROM settings");
  const count = Number(countRes.rows[0]?.c ?? 0);
  if (count > 0) return;

  await client.batch(
    [
      {
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        args: ["slug", DEFAULT_SETTINGS.slug],
      },
      {
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        args: ["hostName", DEFAULT_SETTINGS.hostName],
      },
      {
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        args: ["timezone", DEFAULT_SETTINGS.timezone],
      },
      {
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        args: ["bufferMinutes", String(DEFAULT_SETTINGS.bufferMinutes)],
      },
      {
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        args: ["slotIntervalMinutes", String(DEFAULT_SETTINGS.slotIntervalMinutes)],
      },
      {
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        args: ["durations", JSON.stringify(DEFAULT_SETTINGS.durations)],
      },
      {
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        args: ["weeklyHours", JSON.stringify(DEFAULT_SETTINGS.weeklyHours)],
      },
      {
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        args: ["meetingTitle", DEFAULT_SETTINGS.meetingTitle],
      },
    ],
    "write",
  );
}

async function ensureDb(): Promise<Client> {
  if (clientInstance) return clientInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const client = createDbClient();
    try {
      await client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS oauth_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE,
          access_token_encrypted TEXT,
          refresh_token_encrypted TEXT NOT NULL,
          expiry_date INTEGER,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS calendars (
          google_calendar_id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          account_id INTEGER NOT NULL,
          check_conflicts INTEGER NOT NULL DEFAULT 1,
          is_destination INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (account_id) REFERENCES oauth_accounts(id) ON DELETE CASCADE
        );
      `);
      await migrateLegacy(client);
      await seedDefaults(client);
      clientInstance = client;
      return client;
    } catch (err) {
      // Allow the next request to retry after a failed cold start / Turso blip.
      initPromise = null;
      clientInstance = null;
      try {
        client.close();
      } catch {
        // ignore
      }
      throw err;
    }
  })();

  return initPromise;
}

async function getDb(): Promise<Client> {
  return ensureDb();
}

async function execute(sql: string, args: InArgs = []): Promise<ResultSet> {
  const db = await getDb();
  return db.execute({ sql, args });
}

async function getSetting(key: string): Promise<string | null> {
  const row = await execute("SELECT value FROM settings WHERE key = ?", [key]);
  const value = row.rows[0]?.value;
  return typeof value === "string" ? value : null;
}

async function setSetting(key: string, value: string) {
  await execute(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export async function getHostSettings(): Promise<HostSettings> {
  return {
    slug: (await getSetting("slug")) ?? DEFAULT_SETTINGS.slug,
    hostName: (await getSetting("hostName")) ?? DEFAULT_SETTINGS.hostName,
    timezone: (await getSetting("timezone")) ?? DEFAULT_SETTINGS.timezone,
    bufferMinutes: Number(
      (await getSetting("bufferMinutes")) ?? DEFAULT_SETTINGS.bufferMinutes,
    ),
    slotIntervalMinutes: Number(
      (await getSetting("slotIntervalMinutes")) ?? DEFAULT_SETTINGS.slotIntervalMinutes,
    ),
    durations: JSON.parse(
      (await getSetting("durations")) ?? JSON.stringify(DEFAULT_SETTINGS.durations),
    ) as number[],
    weeklyHours: JSON.parse(
      (await getSetting("weeklyHours")) ?? JSON.stringify(DEFAULT_SETTINGS.weeklyHours),
    ) as WeeklyHours,
    meetingTitle: (await getSetting("meetingTitle")) ?? DEFAULT_SETTINGS.meetingTitle,
  };
}

export async function updateHostSettings(partial: Partial<HostSettings>) {
  if (partial.slug !== undefined) await setSetting("slug", partial.slug);
  if (partial.hostName !== undefined) await setSetting("hostName", partial.hostName);
  if (partial.timezone !== undefined) await setSetting("timezone", partial.timezone);
  if (partial.bufferMinutes !== undefined) {
    await setSetting("bufferMinutes", String(partial.bufferMinutes));
  }
  if (partial.slotIntervalMinutes !== undefined) {
    await setSetting("slotIntervalMinutes", String(partial.slotIntervalMinutes));
  }
  if (partial.durations !== undefined) {
    await setSetting("durations", JSON.stringify(partial.durations));
  }
  if (partial.weeklyHours !== undefined) {
    await setSetting("weeklyHours", JSON.stringify(partial.weeklyHours));
  }
  if (partial.meetingTitle !== undefined) {
    await setSetting("meetingTitle", partial.meetingTitle);
  }
}

export async function listConnectedAccounts(): Promise<ConnectedAccount[]> {
  const res = await execute(
    `SELECT id, email FROM oauth_accounts ORDER BY email COLLATE NOCASE`,
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    email: String(r.email),
  }));
}

export async function getAccountById(id: number): Promise<OAuthTokenRow | null> {
  const res = await execute(
    `SELECT id,
            email,
            access_token_encrypted AS accessTokenEncrypted,
            refresh_token_encrypted AS refreshTokenEncrypted,
            expiry_date AS expiryDate
     FROM oauth_accounts WHERE id = ?`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    email: String(row.email),
    accessTokenEncrypted:
      row.accessTokenEncrypted == null ? null : String(row.accessTokenEncrypted),
    refreshTokenEncrypted: String(row.refreshTokenEncrypted),
    expiryDate: row.expiryDate == null ? null : Number(row.expiryDate),
  };
}

export async function getAccountByEmail(email: string): Promise<OAuthTokenRow | null> {
  const res = await execute(
    `SELECT id,
            email,
            access_token_encrypted AS accessTokenEncrypted,
            refresh_token_encrypted AS refreshTokenEncrypted,
            expiry_date AS expiryDate
     FROM oauth_accounts WHERE email = ?`,
    [email],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    email: String(row.email),
    accessTokenEncrypted:
      row.accessTokenEncrypted == null ? null : String(row.accessTokenEncrypted),
    refreshTokenEncrypted: String(row.refreshTokenEncrypted),
    expiryDate: row.expiryDate == null ? null : Number(row.expiryDate),
  };
}

/** Upsert by email; returns account id. */
export async function saveOAuthAccount(input: {
  email: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string;
  expiryDate: number | null;
}): Promise<number> {
  const existing = await getAccountByEmail(input.email);
  const updatedAt = new Date().toISOString();
  if (existing) {
    await execute(
      `UPDATE oauth_accounts SET
         access_token_encrypted = ?,
         refresh_token_encrypted = COALESCE(?, refresh_token_encrypted),
         expiry_date = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        input.accessTokenEncrypted,
        input.refreshTokenEncrypted,
        input.expiryDate,
        updatedAt,
        existing.id,
      ],
    );
    return existing.id;
  }
  const info = await execute(
    `INSERT INTO oauth_accounts (email, access_token_encrypted, refresh_token_encrypted, expiry_date, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.email,
      input.accessTokenEncrypted,
      input.refreshTokenEncrypted,
      input.expiryDate,
      updatedAt,
    ],
  );
  return Number(info.lastInsertRowid);
}

export async function updateAccountTokens(
  accountId: number,
  input: {
    accessTokenEncrypted: string | null;
    refreshTokenEncrypted?: string;
    expiryDate: number | null;
  },
) {
  const current = await getAccountById(accountId);
  if (!current) return;
  await execute(
    `UPDATE oauth_accounts SET
       access_token_encrypted = ?,
       refresh_token_encrypted = ?,
       expiry_date = ?,
       updated_at = ?
     WHERE id = ?`,
    [
      input.accessTokenEncrypted,
      input.refreshTokenEncrypted ?? current.refreshTokenEncrypted,
      input.expiryDate,
      new Date().toISOString(),
      accountId,
    ],
  );
}

export async function removeOAuthAccount(accountId: number) {
  const db = await getDb();
  await db.batch(
    [
      {
        sql: "DELETE FROM calendars WHERE account_id = ?",
        args: [accountId],
      },
      {
        sql: "DELETE FROM oauth_accounts WHERE id = ?",
        args: [accountId],
      },
    ],
    "write",
  );
}

export async function listCalendars(): Promise<CalendarPref[]> {
  const res = await execute(
    `SELECT c.google_calendar_id AS googleCalendarId,
            c.summary,
            c.account_id AS accountId,
            a.email AS accountEmail,
            c.check_conflicts AS checkConflicts,
            c.is_destination AS isDestination
     FROM calendars c
     JOIN oauth_accounts a ON a.id = c.account_id
     ORDER BY a.email COLLATE NOCASE, c.summary COLLATE NOCASE`,
  );
  return res.rows.map((r) => ({
    googleCalendarId: String(r.googleCalendarId),
    summary: String(r.summary),
    accountId: Number(r.accountId),
    accountEmail: String(r.accountEmail),
    checkConflicts: Boolean(Number(r.checkConflicts)),
    isDestination: Boolean(Number(r.isDestination)),
  }));
}

export async function upsertCalendarsForAccount(
  accountId: number,
  calendars: Array<{ googleCalendarId: string; summary: string }>,
) {
  const existingList = (await listCalendars()).filter((c) => c.accountId === accountId);
  const existing = new Map(existingList.map((c) => [c.googleCalendarId, c]));
  const seen = new Set(calendars.map((c) => c.googleCalendarId));
  const now = new Date().toISOString();
  const stmts: Array<{ sql: string; args: InArgs }> = [];

  for (const cal of calendars) {
    const prev = existing.get(cal.googleCalendarId);
    stmts.push({
      sql: `INSERT INTO calendars (google_calendar_id, summary, account_id, check_conflicts, is_destination, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(google_calendar_id) DO UPDATE SET
              summary = excluded.summary,
              account_id = excluded.account_id,
              updated_at = excluded.updated_at`,
      args: [
        cal.googleCalendarId,
        cal.summary,
        accountId,
        prev?.checkConflicts !== false ? 1 : 0,
        prev?.isDestination ? 1 : 0,
        now,
      ],
    });
  }
  for (const prev of existing.values()) {
    if (!seen.has(prev.googleCalendarId)) {
      stmts.push({
        sql: `DELETE FROM calendars WHERE account_id = ? AND google_calendar_id = ?`,
        args: [accountId, prev.googleCalendarId],
      });
    }
  }

  if (stmts.length === 0) return;
  const db = await getDb();
  await db.batch(stmts, "write");
}

export async function updateCalendarPrefs(
  prefs: Array<{
    googleCalendarId: string;
    checkConflicts: boolean;
    isDestination: boolean;
  }>,
) {
  const now = new Date().toISOString();
  const stmts: Array<{ sql: string; args: InArgs }> = [
    { sql: "UPDATE calendars SET is_destination = 0", args: [] },
  ];
  for (const p of prefs) {
    stmts.push({
      sql: `UPDATE calendars
            SET check_conflicts = ?,
                is_destination = ?,
                updated_at = ?
            WHERE google_calendar_id = ?`,
      args: [
        p.checkConflicts ? 1 : 0,
        p.isDestination ? 1 : 0,
        now,
        p.googleCalendarId,
      ],
    });
  }
  const db = await getDb();
  await db.batch(stmts, "write");
}

export async function getDestinationCalendar(): Promise<{
  googleCalendarId: string;
  accountId: number;
} | null> {
  const res = await execute(
    `SELECT google_calendar_id AS googleCalendarId, account_id AS accountId
     FROM calendars WHERE is_destination = 1 LIMIT 1`,
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    googleCalendarId: String(row.googleCalendarId),
    accountId: Number(row.accountId),
  };
}

export async function getConflictCalendars(): Promise<
  Array<{
    googleCalendarId: string;
    accountId: number;
  }>
> {
  const res = await execute(
    `SELECT google_calendar_id AS googleCalendarId, account_id AS accountId
     FROM calendars WHERE check_conflicts = 1`,
  );
  return res.rows.map((r) => ({
    googleCalendarId: String(r.googleCalendarId),
    accountId: Number(r.accountId),
  }));
}

export async function findHostBySlug(slug: string): Promise<HostSettings | null> {
  const settings = await getHostSettings();
  if (settings.slug !== slug) return null;
  return settings;
}

export async function hasAnyGoogleAccount(): Promise<boolean> {
  const res = await execute("SELECT COUNT(*) AS c FROM oauth_accounts");
  return Number(res.rows[0]?.c ?? 0) > 0;
}
