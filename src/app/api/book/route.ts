import { addMinutes } from "date-fns";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  findHostBySlug,
  getDestinationCalendar,
  hasAnyGoogleAccount,
} from "@/lib/db";
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

export async function POST(request: Request) {
  try {
    const body = bookSchema.parse(await request.json());
    const guestEmails = (body.guestEmails ?? []).filter(
      (e) => e.toLowerCase() !== body.email.toLowerCase(),
    );
    const settings = findHostBySlug(body.slug);
    if (!settings) {
      return NextResponse.json({ error: "Booking page not found" }, { status: 404 });
    }
    if (!settings.durations.includes(body.duration)) {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }
    if (!hasAnyGoogleAccount()) {
      return NextResponse.json(
        { error: "Host has not connected Google Calendar yet" },
        { status: 503 },
      );
    }

    const destination = getDestinationCalendar();
    if (!destination) {
      return NextResponse.json(
        { error: "Host has not chosen a destination calendar" },
        { status: 503 },
      );
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
    });

    return NextResponse.json({
      ok: true,
      eventId: event.id,
      htmlLink: event.htmlLink,
      hangoutLink:
        event.hangoutLink ??
        event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")
          ?.uri,
      start: start.toISOString(),
      end: end.toISOString(),
      timezone: settings.timezone,
      hostName: settings.hostName,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Booking failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
