import Database from "better-sqlite3";
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

const DATA_DIR =
  process.env.VERCEL || process.env.SQLITE_PATH
    ? path.dirname(process.env.SQLITE_PATH || "/tmp/calendar-booking/booking.db")
    : path.join(process.cwd(), "data");
const DB_PATH =
  process.env.SQLITE_PATH ||
  (process.env.VERCEL
    ? "/tmp/calendar-booking/booking.db"
    : path.join(DATA_DIR, "booking.db"));

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  // WAL can be flaky on ephemeral /tmp filesystems (Vercel)
  db.pragma(process.env.VERCEL ? "journal_mode = DELETE" : "journal_mode = WAL");
  db.exec(`
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
  migrateLegacy(db);
  seedDefaults(db);
  dbInstance = db;
  return db;
}

/** Migrate old single-row oauth_tokens / calendars schema if present. */
function migrateLegacy(db: Database.Database) {
  // Ensure calendars.account_id exists on older DBs
  const calCols = db.prepare(`PRAGMA table_info(calendars)`).all() as Array<{
    name: string;
  }>;
  if (calCols.length > 0 && !calCols.some((c) => c.name === "account_id")) {
    db.exec(`ALTER TABLE calendars ADD COLUMN account_id INTEGER`);
  }

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_tokens'`)
    .get() as { name: string } | undefined;
  if (!tables) return;

  const legacy = db
    .prepare(
      `SELECT access_token_encrypted, refresh_token_encrypted, expiry_date, email, updated_at
       FROM oauth_tokens WHERE id = 1`,
    )
    .get() as
    | {
        access_token_encrypted: string | null;
        refresh_token_encrypted: string;
        expiry_date: number | null;
        email: string | null;
        updated_at: string;
      }
    | undefined;

  if (legacy?.email && legacy.refresh_token_encrypted) {
    const existing = db
      .prepare("SELECT id FROM oauth_accounts WHERE email = ?")
      .get(legacy.email) as { id: number } | undefined;
    let accountId = existing?.id;
    if (!accountId) {
      const info = db
        .prepare(
          `INSERT INTO oauth_accounts (email, access_token_encrypted, refresh_token_encrypted, expiry_date, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          legacy.email,
          legacy.access_token_encrypted,
          legacy.refresh_token_encrypted,
          legacy.expiry_date,
          legacy.updated_at,
        );
      accountId = Number(info.lastInsertRowid);
    }
    db.prepare(
      `UPDATE calendars SET account_id = ? WHERE account_id IS NULL OR account_id = 0`,
    ).run(accountId);
  }

  db.exec("DROP TABLE IF EXISTS oauth_tokens");
}

function seedDefaults(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM settings").get() as { c: number };
  if (count.c > 0) return;
  const insert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  const seed = db.transaction(() => {
    insert.run("slug", DEFAULT_SETTINGS.slug);
    insert.run("hostName", DEFAULT_SETTINGS.hostName);
    insert.run("timezone", DEFAULT_SETTINGS.timezone);
    insert.run("bufferMinutes", String(DEFAULT_SETTINGS.bufferMinutes));
    insert.run("slotIntervalMinutes", String(DEFAULT_SETTINGS.slotIntervalMinutes));
    insert.run("durations", JSON.stringify(DEFAULT_SETTINGS.durations));
    insert.run("weeklyHours", JSON.stringify(DEFAULT_SETTINGS.weeklyHours));
    insert.run("meetingTitle", DEFAULT_SETTINGS.meetingTitle);
  });
  seed();
}

function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function getHostSettings(): HostSettings {
  return {
    slug: getSetting("slug") ?? DEFAULT_SETTINGS.slug,
    hostName: getSetting("hostName") ?? DEFAULT_SETTINGS.hostName,
    timezone: getSetting("timezone") ?? DEFAULT_SETTINGS.timezone,
    bufferMinutes: Number(getSetting("bufferMinutes") ?? DEFAULT_SETTINGS.bufferMinutes),
    slotIntervalMinutes: Number(
      getSetting("slotIntervalMinutes") ?? DEFAULT_SETTINGS.slotIntervalMinutes,
    ),
    durations: JSON.parse(
      getSetting("durations") ?? JSON.stringify(DEFAULT_SETTINGS.durations),
    ) as number[],
    weeklyHours: JSON.parse(
      getSetting("weeklyHours") ?? JSON.stringify(DEFAULT_SETTINGS.weeklyHours),
    ) as WeeklyHours,
    meetingTitle: getSetting("meetingTitle") ?? DEFAULT_SETTINGS.meetingTitle,
  };
}

export function updateHostSettings(partial: Partial<HostSettings>) {
  if (partial.slug !== undefined) setSetting("slug", partial.slug);
  if (partial.hostName !== undefined) setSetting("hostName", partial.hostName);
  if (partial.timezone !== undefined) setSetting("timezone", partial.timezone);
  if (partial.bufferMinutes !== undefined) {
    setSetting("bufferMinutes", String(partial.bufferMinutes));
  }
  if (partial.slotIntervalMinutes !== undefined) {
    setSetting("slotIntervalMinutes", String(partial.slotIntervalMinutes));
  }
  if (partial.durations !== undefined) {
    setSetting("durations", JSON.stringify(partial.durations));
  }
  if (partial.weeklyHours !== undefined) {
    setSetting("weeklyHours", JSON.stringify(partial.weeklyHours));
  }
  if (partial.meetingTitle !== undefined) setSetting("meetingTitle", partial.meetingTitle);
}

export function listConnectedAccounts(): ConnectedAccount[] {
  return getDb()
    .prepare(`SELECT id, email FROM oauth_accounts ORDER BY email COLLATE NOCASE`)
    .all() as ConnectedAccount[];
}

export function getAccountById(id: number): OAuthTokenRow | null {
  const row = getDb()
    .prepare(
      `SELECT id,
              email,
              access_token_encrypted AS accessTokenEncrypted,
              refresh_token_encrypted AS refreshTokenEncrypted,
              expiry_date AS expiryDate
       FROM oauth_accounts WHERE id = ?`,
    )
    .get(id) as OAuthTokenRow | undefined;
  return row ?? null;
}

export function getAccountByEmail(email: string): OAuthTokenRow | null {
  const row = getDb()
    .prepare(
      `SELECT id,
              email,
              access_token_encrypted AS accessTokenEncrypted,
              refresh_token_encrypted AS refreshTokenEncrypted,
              expiry_date AS expiryDate
       FROM oauth_accounts WHERE email = ?`,
    )
    .get(email) as OAuthTokenRow | undefined;
  return row ?? null;
}

/** Upsert by email; returns account id. */
export function saveOAuthAccount(input: {
  email: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string;
  expiryDate: number | null;
}): number {
  const existing = getAccountByEmail(input.email);
  const updatedAt = new Date().toISOString();
  if (existing) {
    getDb()
      .prepare(
        `UPDATE oauth_accounts SET
           access_token_encrypted = @accessTokenEncrypted,
           refresh_token_encrypted = COALESCE(@refreshTokenEncrypted, refresh_token_encrypted),
           expiry_date = @expiryDate,
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id: existing.id,
        accessTokenEncrypted: input.accessTokenEncrypted,
        refreshTokenEncrypted: input.refreshTokenEncrypted,
        expiryDate: input.expiryDate,
        updatedAt,
      });
    return existing.id;
  }
  const info = getDb()
    .prepare(
      `INSERT INTO oauth_accounts (email, access_token_encrypted, refresh_token_encrypted, expiry_date, updated_at)
       VALUES (@email, @accessTokenEncrypted, @refreshTokenEncrypted, @expiryDate, @updatedAt)`,
    )
    .run({
      email: input.email,
      accessTokenEncrypted: input.accessTokenEncrypted,
      refreshTokenEncrypted: input.refreshTokenEncrypted,
      expiryDate: input.expiryDate,
      updatedAt,
    });
  return Number(info.lastInsertRowid);
}

export function updateAccountTokens(
  accountId: number,
  input: {
    accessTokenEncrypted: string | null;
    refreshTokenEncrypted?: string;
    expiryDate: number | null;
  },
) {
  const current = getAccountById(accountId);
  if (!current) return;
  getDb()
    .prepare(
      `UPDATE oauth_accounts SET
         access_token_encrypted = @accessTokenEncrypted,
         refresh_token_encrypted = @refreshTokenEncrypted,
         expiry_date = @expiryDate,
         updated_at = @updatedAt
       WHERE id = @id`,
    )
    .run({
      id: accountId,
      accessTokenEncrypted: input.accessTokenEncrypted,
      refreshTokenEncrypted:
        input.refreshTokenEncrypted ?? current.refreshTokenEncrypted,
      expiryDate: input.expiryDate,
      updatedAt: new Date().toISOString(),
    });
}

export function removeOAuthAccount(accountId: number) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM calendars WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM oauth_accounts WHERE id = ?").run(accountId);
  });
  tx();
}

export function listCalendars(): CalendarPref[] {
  const rows = getDb()
    .prepare(
      `SELECT c.google_calendar_id AS googleCalendarId,
              c.summary,
              c.account_id AS accountId,
              a.email AS accountEmail,
              c.check_conflicts AS checkConflicts,
              c.is_destination AS isDestination
       FROM calendars c
       JOIN oauth_accounts a ON a.id = c.account_id
       ORDER BY a.email COLLATE NOCASE, c.summary COLLATE NOCASE`,
    )
    .all() as Array<{
    googleCalendarId: string;
    summary: string;
    accountId: number;
    accountEmail: string;
    checkConflicts: number;
    isDestination: number;
  }>;
  return rows.map((r) => ({
    googleCalendarId: r.googleCalendarId,
    summary: r.summary,
    accountId: r.accountId,
    accountEmail: r.accountEmail,
    checkConflicts: Boolean(r.checkConflicts),
    isDestination: Boolean(r.isDestination),
  }));
}

export function upsertCalendarsForAccount(
  accountId: number,
  calendars: Array<{ googleCalendarId: string; summary: string }>,
) {
  const existing = new Map(
    listCalendars()
      .filter((c) => c.accountId === accountId)
      .map((c) => [c.googleCalendarId, c]),
  );
  const seen = new Set(calendars.map((c) => c.googleCalendarId));
  const upsert = getDb().prepare(
    `INSERT INTO calendars (google_calendar_id, summary, account_id, check_conflicts, is_destination, updated_at)
     VALUES (@id, @summary, @accountId, @checkConflicts, @isDestination, @updatedAt)
     ON CONFLICT(google_calendar_id) DO UPDATE SET
       summary = excluded.summary,
       account_id = excluded.account_id,
       updated_at = excluded.updated_at`,
  );
  const del = getDb().prepare(
    `DELETE FROM calendars WHERE account_id = ? AND google_calendar_id = ?`,
  );
  const now = new Date().toISOString();
  const tx = getDb().transaction(() => {
    for (const cal of calendars) {
      const prev = existing.get(cal.googleCalendarId);
      upsert.run({
        id: cal.googleCalendarId,
        summary: cal.summary,
        accountId,
        checkConflicts: prev?.checkConflicts !== false ? 1 : 0,
        isDestination: prev?.isDestination ? 1 : 0,
        updatedAt: now,
      });
    }
    for (const prev of existing.values()) {
      if (!seen.has(prev.googleCalendarId)) {
        del.run(accountId, prev.googleCalendarId);
      }
    }
  });
  tx();
}

export function updateCalendarPrefs(
  prefs: Array<{
    googleCalendarId: string;
    checkConflicts: boolean;
    isDestination: boolean;
  }>,
) {
  const update = getDb().prepare(
    `UPDATE calendars
     SET check_conflicts = @checkConflicts,
         is_destination = @isDestination,
         updated_at = @updatedAt
     WHERE google_calendar_id = @id`,
  );
  const clearDest = getDb().prepare("UPDATE calendars SET is_destination = 0");
  const now = new Date().toISOString();
  const tx = getDb().transaction(() => {
    clearDest.run();
    for (const p of prefs) {
      update.run({
        id: p.googleCalendarId,
        checkConflicts: p.checkConflicts ? 1 : 0,
        isDestination: p.isDestination ? 1 : 0,
        updatedAt: now,
      });
    }
  });
  tx();
}

export function getDestinationCalendar(): {
  googleCalendarId: string;
  accountId: number;
} | null {
  const row = getDb()
    .prepare(
      `SELECT google_calendar_id AS googleCalendarId, account_id AS accountId
       FROM calendars WHERE is_destination = 1 LIMIT 1`,
    )
    .get() as { googleCalendarId: string; accountId: number } | undefined;
  return row ?? null;
}

export function getConflictCalendars(): Array<{
  googleCalendarId: string;
  accountId: number;
}> {
  return getDb()
    .prepare(
      `SELECT google_calendar_id AS googleCalendarId, account_id AS accountId
       FROM calendars WHERE check_conflicts = 1`,
    )
    .all() as Array<{ googleCalendarId: string; accountId: number }>;
}

export function findHostBySlug(slug: string): HostSettings | null {
  const settings = getHostSettings();
  if (settings.slug !== slug) return null;
  return settings;
}

export function hasAnyGoogleAccount(): boolean {
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM oauth_accounts").get() as {
    c: number;
  };
  return row.c > 0;
}
