import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getHostSettings,
  getStorageBackend,
  listCalendars,
  listConnectedAccounts,
  removeOAuthAccount,
  updateCalendarPrefs,
  updateHostSettings,
} from "@/lib/db";
import {
  getConnectedEmails,
  isGoogleConnected,
  refreshCalendarList,
} from "@/lib/google";
import { getAdminSession } from "@/lib/session";
import type { WeeklyHours } from "@/lib/types";

async function assertAdmin() {
  const session = await getAdminSession();
  if (!session.isAdmin) {
    return null;
  }
  return session;
}

function appBaseUrl(request?: Request) {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (fromEnv && !fromEnv.includes("localhost")) return fromEnv;

  if (request) {
    const host =
      request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const proto =
      request.headers.get("x-forwarded-proto") ??
      (host?.includes("localhost") ? "http" : "https");
    if (host) return `${proto}://${host}`;
  }

  return fromEnv || "http://localhost:3000";
}

async function adminPayload(request?: Request) {
  const settings = await getHostSettings();
  return {
    authenticated: true,
    googleConnected: await isGoogleConnected(),
    googleEmails: await getConnectedEmails(),
    accounts: await listConnectedAccounts(),
    settings,
    calendars: await listCalendars(),
    storageBackend: getStorageBackend(),
    bookingUrl: `${appBaseUrl(request)}/book/${settings.slug}`,
  };
}

export async function GET(request: Request) {
  try {
    const session = await assertAdmin();
    if (!session) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }
    return NextResponse.json(await adminPayload(request));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load admin";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const settingsSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, hyphens"),
  hostName: z.string().min(1).max(120),
  timezone: z.string().min(1),
  bufferMinutes: z.number().int().min(0).max(120),
  slotIntervalMinutes: z.number().int().min(5).max(60),
  durations: z.array(z.number().int().positive()).min(1),
  weeklyHours: z.record(
    z.string(),
    z
      .array(
        z.object({
          start: z.string(),
          end: z.string(),
        }),
      )
      .nullable(),
  ),
  meetingTitle: z.string().min(1).max(200),
});

const calendarsSchema = z.object({
  calendars: z.array(
    z.object({
      googleCalendarId: z.string(),
      checkConflicts: z.boolean(),
      isDestination: z.boolean(),
    }),
  ),
});

export async function PUT(request: Request) {
  try {
    const session = await assertAdmin();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = (await request.json()) as {
      settings?: unknown;
      calendars?: unknown;
      refreshCalendars?: boolean;
      removeAccountId?: number;
    };

    if (typeof body.removeAccountId === "number") {
      await removeOAuthAccount(body.removeAccountId);
    }

    if (body.refreshCalendars) {
      await refreshCalendarList();
    }

    if (body.settings) {
      const settings = settingsSchema.parse(body.settings);
      await updateHostSettings({
        ...settings,
        weeklyHours: settings.weeklyHours as WeeklyHours,
      });
    }

    if (body.calendars) {
      const { calendars } = calendarsSchema.parse({ calendars: body.calendars });
      const destinations = calendars.filter((c) => c.isDestination);
      if (calendars.length > 0 && destinations.length !== 1) {
        return NextResponse.json(
          { error: "Select exactly one destination calendar" },
          { status: 400 },
        );
      }
      await updateCalendarPrefs(calendars);
    }

    return NextResponse.json({ ok: true, ...(await adminPayload(request)) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Save failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
