import { addDays, addMinutes, isBefore, parseISO } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import type { BusyPeriod } from "./google";
import type { HostSettings, TimeWindow } from "./types";

function parseHm(hm: string): { hours: number; minutes: number } {
  const [h, m] = hm.split(":").map(Number);
  return { hours: h, minutes: m };
}

/** Build Date for a local wall-clock time on a calendar date in timezone. */
function zonedDateTime(dateYmd: string, hm: string, timeZone: string): Date {
  const { hours, minutes } = parseHm(hm);
  const wall = `${dateYmd}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
  return fromZonedTime(wall, timeZone);
}

function overlaps(
  start: Date,
  end: Date,
  busy: BusyPeriod[],
  bufferMinutes: number,
): boolean {
  const bufferedStart = addMinutes(start, -bufferMinutes);
  const bufferedEnd = addMinutes(end, bufferMinutes);
  return busy.some((b) => bufferedStart < b.end && bufferedEnd > b.start);
}

function windowsForDay(settings: HostSettings, dateYmd: string): TimeWindow[] {
  const zoned = toZonedTime(parseISO(`${dateYmd}T12:00:00`), settings.timezone);
  const dow = String(zoned.getDay());
  return settings.weeklyHours[dow] ?? [];
}

/**
 * Generate open slot start times (ISO strings) for a given local date + duration.
 * `dayStart`/`dayEnd` are UTC bounds covering the local day (for freebusy queries).
 */
export function getDayBounds(dateYmd: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: fromZonedTime(`${dateYmd}T00:00:00`, timeZone),
    end: fromZonedTime(`${dateYmd}T23:59:59.999`, timeZone),
  };
}

export function generateOpenSlots(input: {
  settings: HostSettings;
  dateYmd: string;
  durationMinutes: number;
  busy: BusyPeriod[];
  now?: Date;
}): string[] {
  const { settings, dateYmd, durationMinutes, busy } = input;
  const now = input.now ?? new Date();
  const windows = windowsForDay(settings, dateYmd);
  if (!windows.length) return [];

  const slots: string[] = [];
  const interval = settings.slotIntervalMinutes;

  for (const win of windows) {
    let cursor = zonedDateTime(dateYmd, win.start, settings.timezone);
    const windowEnd = zonedDateTime(dateYmd, win.end, settings.timezone);

    while (true) {
      const slotEnd = addMinutes(cursor, durationMinutes);
      if (slotEnd > windowEnd) break;

      const farEnoughAhead = addMinutes(now, 5);
      if (
        !isBefore(cursor, farEnoughAhead) &&
        !overlaps(cursor, slotEnd, busy, settings.bufferMinutes)
      ) {
        slots.push(cursor.toISOString());
      }

      cursor = addMinutes(cursor, interval);
      if (cursor >= windowEnd) break;
    }
  }

  return slots;
}

export function listBookableDates(settings: HostSettings, daysAhead = 60): string[] {
  const dates: string[] = [];
  const now = toZonedTime(new Date(), settings.timezone);
  for (let i = 0; i < daysAhead; i++) {
    const d = addDays(now, i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const ymd = `${y}-${m}-${day}`;
    if (windowsForDay(settings, ymd).length > 0) {
      dates.push(ymd);
    }
  }
  return dates;
}
