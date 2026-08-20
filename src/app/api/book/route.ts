import { addMinutes } from "date-fns";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  findHostBySlug,
  getDestinationCalendar,
  insertPendingBooking,
} from "@/lib/db";
import { GoogleAccountAuthError, isGoogleAuthFailure } from "@/lib/errors";
import { createCalendarEvent, queryFreeBusy } from "@/lib/google";
import { generateOpenSlots, getDayBounds } from "@/lib/slots";

const bookSchema = z.object({
  slug: z.string().min(1),
  start: z.string().datetime(),
  duration: z.number().int().positive(),
  name: z.string().min(1).max(120),
  email: z.string().email(),
  guestEmails: z.array(z.string().email()).max(10).optional(),
  notes: z.string().max(2000).optional(),
});

function bookingSuccessResponse(input: {
  settings: { hostName: string; timezone: string };
  start: Date;
  end: Date;
  pending?: boolean;
  htmlLink?: string | null;
  hangoutLink?: string | null;
  eventId?: string | null;
}) {
  return NextResponse.json({
    ok: true as const,
    pending: input.pending ?? false,
    eventId: input.eventId ?? null,
    htmlLink: input.htmlLink ?? null,
    hangoutLink: input.hangoutLink ?? null,
    start: input.start.toISOString(),
    end: input.end.toISOString(),
    timezone: input.settings.timezone,
    hostName: input.settings.hostName,
  });
}

export async function POST(request: Request) {
  try {
    const body = bookSchema.parse(await request.json());
    const guestEmails = (body.guestEmails ?? []).filter(
      (e) => e.toLowerCase() !== body.email.toLowerCase(),
    );
    const settings = await findHostBySlug(body.slug);
    if (!settings) {
      return NextResponse.json({ error: "Booking page not found" }, { status: 404 });
    }
    if (!settings.durations.includes(body.duration)) {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }

    const start = new Date(body.start);
    const end = addMinutes(start, body.duration);

    const y = new Intl.DateTimeFormat("en-CA", {
      timeZone: settings.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(start);
    const bounds = getDayBounds(y, settings.timezone);
    const busy = await queryFreeBusy(bounds.start, bounds.end);
    const open = generateOpenSlots({
      settings,
      dateYmd: y,
      durationMinutes: body.duration,
      busy,
    });
    if (!open.some((s) => new Date(s).getTime() === start.getTime())) {
      return NextResponse.json(
        { error: "That time is no longer available. Pick another slot." },
        { status: 409 },
      );
    }

    const summary = settings.meetingTitle.replaceAll("{name}", body.name);
    const description = [
      `Booked via your booking page.`,
      `Guest: ${body.name} <${body.email}>`,
      guestEmails.length
        ? `Additional guests: ${guestEmails.join(", ")}`
        : null,
      body.notes ? `Notes: ${body.notes}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const notifyEmail =
      process.env.HOST_NOTIFY_EMAIL?.trim() || settings.notifyEmail.trim();

    const destination = await getDestinationCalendar();
    if (!destination) {
      await insertPendingBooking({
        slug: body.slug,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        durationMinutes: body.duration,
        guestName: body.name,
        guestEmail: body.email,
        guestEmails,
        notes: body.notes,
        summary,
        description,
        timezone: settings.timezone,
      });
      return bookingSuccessResponse({ settings, start, end, pending: true });
    }

    try {
      const event = await createCalendarEvent({
        calendarId: destination.googleCalendarId,
        summary,
        description,
        start,
        end,
        timezone: settings.timezone,
        attendeeEmail: body.email,
        attendeeName: body.name,
        additionalGuestEmails: guestEmails,
        hostNotifyEmail: notifyEmail || undefined,
      });

      const hangoutLink =
        event.hangoutLink ??
        event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")
          ?.uri;

      return bookingSuccessResponse({
        settings,
        start,
        end,
        eventId: event.id ?? null,
        htmlLink: event.htmlLink,
        hangoutLink,
      });
    } catch (err) {
      if (
        err instanceof GoogleAccountAuthError ||
        isGoogleAuthFailure(err)
      ) {
        console.error("Google unavailable; queueing pending booking", err);
        await insertPendingBooking({
          slug: body.slug,
          startIso: start.toISOString(),
          endIso: end.toISOString(),
          durationMinutes: body.duration,
          guestName: body.name,
          guestEmail: body.email,
          guestEmails,
          notes: body.notes,
          summary,
          description,
          timezone: settings.timezone,
        });
        return bookingSuccessResponse({ settings, start, end, pending: true });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }
    console.error("Booking error", err);
    return NextResponse.json({ error: "Booking failed. Please try again." }, { status: 500 });
  }
}
