import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppBaseUrl } from "@/lib/app-url";
import {
  getDestinationCalendar,
  getHostSettings,
  getPendingBookingById,
  getStorageBackend,
  listCalendars,
  listConnectedAccounts,
  listPendingBookings,
  markPendingBookingFulfilled,
  removeOAuthAccount,
  updateCalendarPrefs,
  updateHostSettings,
} from "@/lib/db";
import { adminGoogleErrorMessage } from "@/lib/errors";
import {
  createCalendarEvent,
  getAccountAuthStatuses,
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

async function adminPayload(request?: Request) {
  const settings = await getHostSettings();
  const accountAuth = await getAccountAuthStatuses();
  return {
    authenticated: true,
    googleConnected: await isGoogleConnected(),
    googleEmails: await getConnectedEmails(),
    accounts: await listConnectedAccounts(),
    accountAuth,
    pendingBookings: await listPendingBookings(false),
    settings,
    calendars: await listCalendars(),
    storageBackend: getStorageBackend(),
    bookingUrl: `${getAppBaseUrl(request)}/book/${settings.slug}`,
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
    console.error("Admin load error", err);
    const raw = err instanceof Error ? err.message : "Failed to load admin";
    return NextResponse.json(
      { error: adminGoogleErrorMessage(raw) },
      { status: 500 },
    );
  }
}

const settingsSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, hyphens"),
  hostName: z.string().min(1).max(120),
  notifyEmail: z
    .string()
    .max(200)
    .refine(
      (v) => v.trim() === "" || z.string().email().safeParse(v.trim()).success,
      "Invalid notification email",
    ),
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
      retryPendingBookingId?: number;
    };

    if (typeof body.removeAccountId === "number") {
      await removeOAuthAccount(body.removeAccountId);
    }

    if (typeof body.retryPendingBookingId === "number") {
      const pending = await getPendingBookingById(body.retryPendingBookingId);
      if (!pending || pending.fulfilledAt) {
        return NextResponse.json(
          { error: "Pending booking not found or already fulfilled" },
          { status: 404 },
        );
      }
      const destination = await getDestinationCalendar();
      if (!destination) {
        return NextResponse.json(
          { error: "Choose a destination calendar before retrying" },
          { status: 400 },
        );
      }
      const settings = await getHostSettings();
      const notifyEmail =
        process.env.HOST_NOTIFY_EMAIL?.trim() || settings.notifyEmail.trim();
      const event = await createCalendarEvent({
        calendarId: destination.googleCalendarId,
        summary: pending.summary,
        description: pending.description ?? undefined,
        start: new Date(pending.startIso),
        end: new Date(pending.endIso),
        timezone: pending.timezone,
        attendeeEmail: pending.guestEmail,
        attendeeName: pending.guestName,
        additionalGuestEmails: pending.guestEmails,
        hostNotifyEmail: notifyEmail || undefined,
      });
      await markPendingBookingFulfilled(pending.id, event.id ?? null);
    }

    let refreshAccountErrors: { id: number; email: string; message: string }[] =
      [];
    if (body.refreshCalendars) {
      const refreshed = await refreshCalendarList();
      refreshAccountErrors = refreshed.accountErrors;
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

    const payload = await adminPayload(request);
    return NextResponse.json({
      ok: true,
      ...payload,
      refreshAccountErrors:
        refreshAccountErrors.length > 0 ? refreshAccountErrors : undefined,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }
    console.error("Admin save error", err);
    const raw = err instanceof Error ? err.message : "Save failed";
    return NextResponse.json(
      { error: adminGoogleErrorMessage(raw) },
      { status: 500 },
    );
  }
}
