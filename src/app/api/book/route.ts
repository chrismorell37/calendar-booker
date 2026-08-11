import { addMinutes } from "date-fns";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  findHostBySlug,
  getDestinationCalendar,
  hasAnyGoogleAccount,
} from "@/lib/db";
import { publicApiErrorMessage } from "@/lib/errors";
import {
  createCalendarEvent,
  notifyHostOfBooking,
  queryFreeBusy,
} from "@/lib/google";
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
    const settings = await findHostBySlug(body.slug);
    if (!settings) {
      return NextResponse.json({ error: "Booking page not found" }, { status: 404 });
    }
    if (!settings.durations.includes(body.duration)) {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }
    if (!(await hasAnyGoogleAccount())) {
      return NextResponse.json(
        { error: "Scheduling is temporarily unavailable. Please try again soon." },
        { status: 503 },
      );
    }

    const destination = await getDestinationCalendar();
    if (!destination) {
      return NextResponse.json(
        { error: "Scheduling is temporarily unavailable. Please try again soon." },
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

    const hangoutLink =
      event.hangoutLink ??
      event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")
        ?.uri;

    const notifyEmail =
      process.env.HOST_NOTIFY_EMAIL?.trim() || settings.notifyEmail.trim();
    if (notifyEmail) {
      try {
        await notifyHostOfBooking({
          to: notifyEmail,
          guestName: body.name,
          guestEmail: body.email,
          guestEmails,
          notes: body.notes,
          summary,
          start,
          end,
          timezone: settings.timezone,
          hangoutLink,
          htmlLink: event.htmlLink,
        });
      } catch (err) {
        // Booking already succeeded; don't fail the guest over host email issues.
        console.error("Failed to send host booking notification", err);
      }
    }

    return NextResponse.json({
      ok: true,
      eventId: event.id,
      htmlLink: event.htmlLink,
      hangoutLink,
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
    console.error("Booking error", err);
    return NextResponse.json(
      { error: publicApiErrorMessage(err) },
      { status: 503 },
    );
  }
}
