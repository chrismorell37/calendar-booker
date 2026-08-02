import Link from "next/link";
import { DEFAULT_SETTINGS } from "@/lib/types";

export default function HomePage() {
  // Keep the landing page free of SQLite so it always loads on Vercel.
  const name = DEFAULT_SETTINGS.hostName || "Chris";
  const slug = DEFAULT_SETTINGS.slug;

  return (
    <div className="page-shell">
      <main className="page-content mx-auto flex min-h-screen max-w-xl flex-col px-6 py-20">
        <div className="flex flex-1 flex-col justify-center">
          <div className="animate-rise">
            <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-accent">
              Scheduling
            </p>
            <div className="accent-rule mt-4" />
            <h1 className="font-display mt-6 text-[2.75rem] leading-[1.05] tracking-[-0.02em] text-ink-soft sm:text-5xl">
              Book with <span className="text-accent">{name}</span>
            </h1>
            <p className="mt-5 max-w-md text-[1.05rem] leading-relaxed text-muted">
              Choose a length, pick an open time across calendars, and get an invite —
              simple as that.
            </p>
          </div>

          <div className="animate-rise-delay-1 mt-10">
            <Link
              href={`/book/${slug}`}
              className="inline-flex rounded-md bg-accent px-5 py-3 text-sm font-semibold text-white shadow-[0_10px_28px_-14px_rgba(26,107,85,0.7)] transition hover:bg-accent-hover hover:shadow-[0_12px_30px_-12px_rgba(26,107,85,0.75)]"
            >
              Book a meeting
            </Link>
          </div>
        </div>

        <p className="animate-rise-delay-2 pt-12 text-center text-xs text-muted/70">
          <Link href="/admin" className="underline-offset-2 transition hover:text-muted hover:underline">
            Admin
          </Link>
        </p>
      </main>
    </div>
  );
}
