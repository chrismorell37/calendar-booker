"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CalendarPref,
  ConnectedAccount,
  HostSettings,
  TimeWindow,
  WeeklyHours,
} from "@/lib/types";
import { DEFAULT_WEEKLY_HOURS } from "@/lib/types";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

type AdminData = {
  authenticated: boolean;
  googleConnected?: boolean;
  googleEmails?: string[];
  accounts?: ConnectedAccount[];
  settings?: HostSettings;
  calendars?: CalendarPref[];
  bookingUrl?: string;
  /** "turso" on Vercel; "local-file" only for local dev */
  storageBackend?: "turso" | "local-file";
};

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [data, setData] = useState<AdminData | null>(null);
  const [settings, setSettings] = useState<HostSettings | null>(null);
  const [calendars, setCalendars] = useState<CalendarPref[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin");
      if (res.status === 401) {
        setData({ authenticated: false });
        setSettings(null);
        setCalendars([]);
        return;
      }
      const json = (await res.json()) as AdminData & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to load");
      setData(json);
      if (json.settings) setSettings(json.settings);
      if (json.calendars) setCalendars(json.calendars);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) setMessage("Google Calendar connected.");
    if (params.get("error")) setError(params.get("error"));
    void load();
  }, [load]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) {
      setError(json.error ?? "Login failed");
      return;
    }
    setPassword("");
    await load();
  }

  async function logout() {
    await fetch("/api/auth/login", { method: "DELETE" });
    setData({ authenticated: false });
    setSettings(null);
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings, calendars }),
      });
      const json = (await res.json()) as AdminData & { error?: string; ok?: boolean };
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      if (json.settings) setSettings(json.settings);
      if (json.calendars) setCalendars(json.calendars);
      setData((d) =>
        d
          ? {
              ...d,
              bookingUrl: json.bookingUrl ?? d.bookingUrl,
              accounts: json.accounts ?? d.accounts,
              googleEmails: json.googleEmails ?? d.googleEmails,
              googleConnected: json.googleConnected ?? d.googleConnected,
            }
          : d,
      );
      setMessage("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function refreshCalendars() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshCalendars: true }),
      });
      const json = (await res.json()) as AdminData & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Refresh failed");
      if (json.calendars) setCalendars(json.calendars);
      setData((d) =>
        d
          ? {
              ...d,
              accounts: json.accounts ?? d.accounts,
              googleEmails: json.googleEmails ?? d.googleEmails,
              googleConnected: json.googleConnected ?? d.googleConnected,
            }
          : d,
      );
      setMessage("Calendar list refreshed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setSaving(false);
    }
  }

  async function removeAccount(accountId: number) {
    if (!confirm("Disconnect this Google account and its calendars?")) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeAccountId: accountId }),
      });
      const json = (await res.json()) as AdminData & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Remove failed");
      if (json.calendars) setCalendars(json.calendars);
      setData((d) =>
        d
          ? {
              ...d,
              accounts: json.accounts ?? [],
              googleEmails: json.googleEmails ?? [],
              googleConnected: json.googleConnected ?? false,
            }
          : d,
      );
      setMessage("Google account disconnected.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setSaving(false);
    }
  }

  function toggleDuration(mins: number) {
    if (!settings) return;
    const has = settings.durations.includes(mins);
    const durations = has
      ? settings.durations.filter((d) => d !== mins)
      : [...settings.durations, mins].sort((a, b) => a - b);
    if (durations.length === 0) return;
    setSettings({ ...settings, durations });
  }

  function setDayEnabled(day: string, enabled: boolean) {
    if (!settings) return;
    const weeklyHours: WeeklyHours = { ...settings.weeklyHours };
    weeklyHours[day] = enabled
      ? (DEFAULT_WEEKLY_HOURS[day] ?? [{ start: "09:00", end: "17:00" }])
      : null;
    setSettings({ ...settings, weeklyHours });
  }

  function updateWindow(day: string, field: keyof TimeWindow, value: string) {
    if (!settings) return;
    const current = settings.weeklyHours[day];
    if (!current?.[0]) return;
    const next: TimeWindow[] = [{ ...current[0], [field]: value }];
    setSettings({
      ...settings,
      weeklyHours: { ...settings.weeklyHours, [day]: next },
    });
  }

  function setDestination(id: string) {
    setCalendars((prev) =>
      prev.map((c) => ({ ...c, isDestination: c.googleCalendarId === id })),
    );
  }

  function toggleConflict(id: string) {
    setCalendars((prev) =>
      prev.map((c) =>
        c.googleCalendarId === id
          ? { ...c, checkConflicts: !c.checkConflicts }
          : c,
      ),
    );
  }

  const calendarsByAccount = useMemo(() => {
    const map = new Map<string, CalendarPref[]>();
    for (const cal of calendars) {
      const key = cal.accountEmail || "Unknown";
      const list = map.get(key) ?? [];
      list.push(cal);
      map.set(key, list);
    }
    return map;
  }, [calendars]);

  const bookingUrl = useMemo(() => {
    if (!settings) return "";
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    // Prefer the browser origin so Vercel never shows a leftover localhost env value
    if (origin) return `${origin}/book/${settings.slug}`;
    return data?.bookingUrl ?? "";
  }, [data?.bookingUrl, settings]);

  if (loading) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-muted">Loading…</main>
    );
  }

  if (!data?.authenticated || !settings) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-16">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="mt-2 text-sm text-muted">Enter your admin password to continue.</p>
        <form onSubmit={login} className="mt-6 flex flex-col gap-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-border bg-surface px-3 py-2"
            placeholder="Password"
            autoFocus
          />
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button
            type="submit"
            className="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Sign in
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Admin</h1>
          <p className="mt-1 text-sm text-muted">
            Connect calendars, set availability, share your booking link.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          className="text-sm text-muted underline-offset-2 hover:underline"
        >
          Sign out
        </button>
      </div>

      {(message || error) && (
        <div
          className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            error
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-900"
          }`}
        >
          {error ?? message}
        </div>
      )}

      <section className="mt-8 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-medium">Booking link</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="flex-1 break-all rounded-md bg-background px-3 py-2 text-sm">
            {bookingUrl}
          </code>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-background"
            onClick={() => {
              void navigator.clipboard.writeText(bookingUrl);
              setMessage("Link copied.");
            }}
          >
            Copy
          </button>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-medium">Google calendars</h2>
        <p className="mt-1 text-sm text-muted">
          Connect personal and work Google accounts. Mark calendars to check for
          conflicts; pick one calendar to receive bookings.
        </p>

        {data.storageBackend && (
          <p
            className={`mt-3 rounded-md border px-3 py-2 text-xs ${
              data.storageBackend === "turso"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-amber-200 bg-amber-50 text-amber-950"
            }`}
          >
            {data.storageBackend === "turso"
              ? "Persistent storage: Turso (connections survive redeploys)."
              : "Storage: local file DB (dev only). On Vercel this must show Turso or calendars will keep disconnecting."}
          </p>
        )}

        {(data.accounts?.length ?? 0) > 0 && (
          <ul className="mt-4 space-y-2">
            {(data.accounts ?? []).map((account) => (
              <li
                key={account.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background px-3 py-2 text-sm"
              >
                <span>{account.email}</span>
                <button
                  type="button"
                  onClick={() => void removeAccount(account.id)}
                  className="text-muted underline-offset-2 hover:underline"
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href="/api/auth/google"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            {data.googleConnected ? "Add another Google account" : "Connect Google"}
          </a>
          {data.googleConnected && (
            <button
              type="button"
              onClick={() => void refreshCalendars()}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-background"
            >
              Refresh calendars
            </button>
          )}
        </div>

        {calendars.length > 0 && (
          <div className="mt-5 space-y-6">
            {[...calendarsByAccount.entries()].map(([email, cals]) => (
              <div key={email}>
                <h3 className="text-sm font-medium text-muted">{email}</h3>
                <ul className="mt-2 divide-y divide-border">
                  {cals.map((cal) => (
                    <li
                      key={cal.googleCalendarId}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium">{cal.summary}</p>
                        <p className="text-xs text-muted">{cal.googleCalendarId}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-4 text-sm">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={cal.checkConflicts}
                            onChange={() => toggleConflict(cal.googleCalendarId)}
                          />
                          Check conflicts
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="destination"
                            checked={cal.isDestination}
                            onChange={() => setDestination(cal.googleCalendarId)}
                          />
                          Book into this
                        </label>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-medium">Profile &amp; durations</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-muted">Display name</span>
            <input
              className="mt-1 w-full rounded-md border border-border px-3 py-2"
              value={settings.hostName}
              onChange={(e) => setSettings({ ...settings, hostName: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">URL slug</span>
            <input
              className="mt-1 w-full rounded-md border border-border px-3 py-2"
              value={settings.slug}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                })
              }
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Timezone</span>
            <select
              className="mt-1 w-full rounded-md border border-border px-3 py-2"
              value={settings.timezone}
              onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
            >
              {!TIMEZONES.includes(settings.timezone) && (
                <option value={settings.timezone}>{settings.timezone}</option>
              )}
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-muted">Meeting title</span>
            <input
              className="mt-1 w-full rounded-md border border-border px-3 py-2"
              value={settings.meetingTitle}
              onChange={(e) => setSettings({ ...settings, meetingTitle: e.target.value })}
              placeholder="Meeting with {name}"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Buffer (minutes)</span>
            <input
              type="number"
              min={0}
              max={120}
              className="mt-1 w-full rounded-md border border-border px-3 py-2"
              value={settings.bufferMinutes}
              onChange={(e) =>
                setSettings({ ...settings, bufferMinutes: Number(e.target.value) })
              }
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Slot interval (minutes)</span>
            <input
              type="number"
              min={5}
              max={60}
              className="mt-1 w-full rounded-md border border-border px-3 py-2"
              value={settings.slotIntervalMinutes}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  slotIntervalMinutes: Number(e.target.value),
                })
              }
            />
          </label>
        </div>
        <div className="mt-4">
          <p className="text-sm text-muted">Meeting lengths</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {[30, 45, 60].map((mins) => (
              <label key={mins} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.durations.includes(mins)}
                  onChange={() => toggleDuration(mins)}
                />
                {mins} min
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-medium">Weekly availability</h2>
        <ul className="mt-4 space-y-3">
          {DAY_LABELS.map((label, i) => {
            const key = String(i);
            const windows = settings.weeklyHours[key];
            const enabled = Boolean(windows?.length);
            return (
              <li key={key} className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex w-16 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setDayEnabled(key, e.target.checked)}
                  />
                  {label}
                </label>
                {enabled && windows?.[0] && (
                  <>
                    <input
                      type="time"
                      value={windows[0].start}
                      onChange={(e) => updateWindow(key, "start", e.target.value)}
                      className="rounded-md border border-border px-2 py-1"
                    />
                    <span className="text-muted">to</span>
                    <input
                      type="time"
                      value={windows[0].end}
                      onChange={(e) => updateWindow(key, "end", e.target.value)}
                      className="rounded-md border border-border px-2 py-1"
                    />
                  </>
                )}
                {!enabled && <span className="text-muted">Closed</span>}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mt-8 flex justify-end">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </main>
  );
}
