import { notFound } from "next/navigation";
import { findHostBySlug } from "@/lib/db";
import { listBookableDates } from "@/lib/slots";
import { BookingForm } from "./booking-form";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

export default async function BookPage({ params }: Props) {
  const { slug } = await params;
  const settings = findHostBySlug(slug);
  if (!settings) notFound();

  const dates = listBookableDates(settings, 60);
  const tzLabel = settings.timezone.replaceAll("_", " ");

  return (
    <div className="page-shell">
      <main className="page-content mx-auto min-h-screen max-w-lg px-6 py-14 sm:py-16">
        <header className="animate-rise">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-accent">
            With {settings.hostName}
          </p>
          <div className="accent-rule mt-4" />
          <h1 className="font-display mt-5 text-4xl leading-[1.08] tracking-[-0.02em] sm:text-[2.75rem]">
            Book a meeting
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Open times across calendars · {tzLabel}
          </p>
        </header>

        <div className="animate-rise-delay-1">
          <BookingForm
            slug={settings.slug}
            hostName={settings.hostName}
            durations={settings.durations}
            timezone={settings.timezone}
            dates={dates}
          />
        </div>
      </main>
    </div>
  );
}
