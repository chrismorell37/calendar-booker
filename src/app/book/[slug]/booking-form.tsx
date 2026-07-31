"use client";

import { useEffect, useMemo, useState } from "react";

type Props = {
  slug: string;
  hostName: string;
  durations: number[];
  timezone: string;
  dates: string[];
};

type BookResult = {
  ok: true;
  htmlLink?: string | null;
  hangoutLink?: string | null;
  start: string;
  end: string;
  timezone: string;
  hostName: string;
};

function formatSlot(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatDateLabel(ymd: string, timeZone: string) {
  const d = new Date(`${ymd}T12:00:00`);
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}

export function BookingForm({ slug, hostName, durations, timezone, dates }: Props) {
  const [duration, setDuration] = useState(durations[0] ?? 30);
  const [date, setDate] = useState(dates[0] ?? "");
  const [slots, setSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedStart, setSelectedStart] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [guests, setGuests] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BookResult | null>(null);

  useEffect(() => {
    if (!date || !duration) return;
    let cancelled = false;
    setLoadingSlots(true);
    setSelectedStart(null);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/availability?slug=${encodeURIComponent(slug)}&date=${encodeURIComponent(date)}&duration=${duration}`,
        );
        const json = (await res.json()) as { slots?: string[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? "Could not load times");
        if (!cancelled) setSlots(json.slots ?? []);
      } catch (err) {
        if (!cancelled) {
          setSlots([]);
          setError(err instanceof Error ? err.message : "Could not load times");
        }
      } finally {
        if (!cancelled) setLoadingSlots(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, date, duration]);

  const confirmationWhen = useMemo(() => {
    if (!result) return "";
    return new Intl.DateTimeFormat(undefined, {
      timeZone: result.timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(result.start));
  }, [result]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedStart) return;
    setSubmitting(true);
    setError(null);
    try {
      const guestEmails = guests
        .split(/[,;\s]+/)
        .map((g) => g.trim())
        .filter(Boolean);
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          start: selectedStart,
          duration,
          name,
          email,
          guestEmails: guestEmails.length ? guestEmails : undefined,
          notes: notes || undefined,
        }),
      });
      const json = (await res.json()) as BookResult & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Booking failed");
      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Booking failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <section className="animate-rise mt-10 border-t border-border/70 pt-8">
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-accent">
          Confirmed
        </p>
        <h2 className="font-display mt-3 text-3xl tracking-[-0.02em]">You&apos;re booked</h2>
        <p className="mt-2 text-muted">
          {duration}-minute meeting with {result.hostName || hostName}
        </p>
        <p className="mt-5 text-lg font-medium text-ink-soft">{confirmationWhen}</p>
        <p className="mt-1 text-sm text-muted">A calendar invite was sent to {email}.</p>
        <div className="mt-7 flex flex-wrap gap-3">
          {result.hangoutLink && (
            <a
              href={result.hangoutLink}
              className="rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
              target="_blank"
              rel="noreferrer"
            >
              Join Meet link
            </a>
          )}
          {result.htmlLink && (
            <a
              href={result.htmlLink}
              className="rounded-md border border-border bg-surface/80 px-4 py-2.5 text-sm font-medium backdrop-blur-sm hover:border-accent/30"
              target="_blank"
              rel="noreferrer"
            >
              Open in Google Calendar
            </a>
          )}
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="mt-10 space-y-9">
      <section>
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-muted">
          Duration
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {durations.map((mins) => (
            <button
              key={mins}
              type="button"
              data-active={duration === mins}
              onClick={() => setDuration(mins)}
              className={`choice-btn rounded-md border px-4 py-2.5 text-sm font-medium ${
                duration === mins
                  ? "border-accent bg-accent text-white"
                  : "border-border/80 bg-surface/75 text-ink-soft backdrop-blur-sm hover:border-accent/35"
              }`}
            >
              {mins} min
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-muted">
          Date
        </h2>
        {dates.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No available days configured.</p>
        ) : (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {dates.slice(0, 21).map((d) => (
              <button
                key={d}
                type="button"
                data-active={date === d}
                onClick={() => setDate(d)}
                className={`choice-btn shrink-0 rounded-md border px-3.5 py-2.5 text-left text-sm font-medium ${
                  date === d
                    ? "border-accent bg-accent text-white"
                    : "border-border/80 bg-surface/75 text-ink-soft backdrop-blur-sm hover:border-accent/35"
                }`}
              >
                {formatDateLabel(d, timezone)}
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-muted">
          Time
        </h2>
        {loadingSlots ? (
          <p className="mt-3 text-sm text-muted">Finding open times…</p>
        ) : slots.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No open slots this day.</p>
        ) : (
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {slots.map((slot) => (
              <button
                key={slot}
                type="button"
                data-active={selectedStart === slot}
                onClick={() => setSelectedStart(slot)}
                className={`choice-btn rounded-md border px-2 py-2.5 text-sm font-medium ${
                  selectedStart === slot
                    ? "border-accent bg-accent text-white"
                    : "border-border/80 bg-surface/75 text-ink-soft backdrop-blur-sm hover:border-accent/35"
                }`}
              >
                {formatSlot(slot, timezone)}
              </button>
            ))}
          </div>
        )}
      </section>

      {selectedStart && (
        <section className="animate-rise space-y-3 border-t border-border/70 pt-7">
          <h2 className="font-display text-2xl tracking-[-0.02em]">Your details</h2>
          <p className="text-sm text-muted">
            {formatDateLabel(date, timezone)} · {formatSlot(selectedStart, timezone)} ·{" "}
            {duration} min
          </p>
          <label className="block text-sm">
            <span className="text-muted">Name</span>
            <input
              required
              className="mt-1.5 w-full rounded-md border border-border/80 bg-surface/90 px-3 py-2.5 outline-none ring-accent/30 transition focus:ring-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Email</span>
            <input
              required
              type="email"
              className="mt-1.5 w-full rounded-md border border-border/80 bg-surface/90 px-3 py-2.5 outline-none ring-accent/30 transition focus:ring-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Additional guests (optional)</span>
            <input
              type="text"
              inputMode="email"
              placeholder="email@company.com, other@email.com"
              className="mt-1.5 w-full rounded-md border border-border/80 bg-surface/90 px-3 py-2.5 outline-none ring-accent/30 transition focus:ring-2"
              value={guests}
              onChange={(e) => setGuests(e.target.value)}
            />
            <span className="mt-1 block text-xs text-muted">
              Separate multiple emails with commas
            </span>
          </label>
          <label className="block text-sm">
            <span className="text-muted">Notes (optional)</span>
            <textarea
              className="mt-1.5 w-full rounded-md border border-border/80 bg-surface/90 px-3 py-2.5 outline-none ring-accent/30 transition focus:ring-2"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="mt-2 w-full rounded-md bg-accent px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_28px_-14px_rgba(26,107,85,0.7)] transition hover:bg-accent-hover disabled:opacity-60"
          >
            {submitting ? "Booking…" : "Confirm booking"}
          </button>
        </section>
      )}

      {error && (
        <p className="rounded-md border border-red-200/80 bg-red-50/90 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
    </form>
  );
}
