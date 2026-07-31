import { NextResponse } from "next/server";
import { findHostBySlug, hasAnyGoogleAccount } from "@/lib/db";
import { queryFreeBusy } from "@/lib/google";
import { generateOpenSlots, getDayBounds } from "@/lib/slots";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const slug = searchParams.get("slug");
    const date = searchParams.get("date");
    const duration = Number(searchParams.get("duration"));

    if (!slug || !date || !duration) {
      return NextResponse.json(
        { error: "slug, date, and duration are required" },
        { status: 400 },
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    }

    const settings = findHostBySlug(slug);
    if (!settings) {
      return NextResponse.json({ error: "Booking page not found" }, { status: 404 });
    }
    if (!settings.durations.includes(duration)) {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }
    if (!hasAnyGoogleAccount()) {
      return NextResponse.json(
        { error: "Host has not connected Google Calendar yet" },
        { status: 503 },
      );
    }

    const bounds = getDayBounds(date, settings.timezone);
    const busy = await queryFreeBusy(bounds.start, bounds.end);
    const slots = generateOpenSlots({
      settings,
      dateYmd: date,
      durationMinutes: duration,
      busy,
    });

    return NextResponse.json({
      date,
      duration,
      timezone: settings.timezone,
      slots,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load availability";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
