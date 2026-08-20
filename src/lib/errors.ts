/** Thrown when a stored Google refresh token is revoked/expired. */
export class GoogleAccountAuthError extends Error {
  accountId: number;
  accountEmail: string | null;

  constructor(accountId: number, accountEmail: string | null, cause?: unknown) {
    const who = accountEmail ? ` for ${accountEmail}` : "";
    super(
      `Google access${who} expired or was revoked. Disconnect and reconnect that account in Admin.`,
    );
    this.name = "GoogleAccountAuthError";
    this.accountId = accountId;
    this.accountEmail = accountEmail;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const withResponse = err as Error & {
      response?: { data?: { error?: string; error_description?: string } };
      cause?: unknown;
    };
    return [
      err.message,
      withResponse.response?.data?.error,
      withResponse.response?.data?.error_description,
      errorText(withResponse.cause),
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (typeof err === "object") {
    const o = err as {
      message?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    return [o.message, o.error, o.error_description]
      .filter((v) => typeof v === "string")
      .join(" ");
  }
  return String(err);
}

/** True for revoked/expired Google OAuth refresh failures. */
export function isGoogleAuthFailure(err: unknown): boolean {
  if (err instanceof GoogleAccountAuthError) return true;
  const text = errorText(err).toLowerCase();
  return (
    text.includes("invalid_grant") ||
    text.includes("invalid_rapt") ||
    text.includes("token has been expired or revoked") ||
    text.includes("deleted_client") ||
    text.includes("unauthorized_client")
  );
}

/** Safe message for public bookers — never leak OAuth internals. */
export const PUBLIC_SCHEDULING_UNAVAILABLE =
  "Scheduling is temporarily unavailable. Please try again soon.";

export function publicApiErrorMessage(err: unknown): string {
  if (err instanceof GoogleAccountAuthError || isGoogleAuthFailure(err)) {
    return PUBLIC_SCHEDULING_UNAVAILABLE;
  }
  const message = err instanceof Error ? err.message : "";
  // Anything that looks like an OAuth/API credential leak → generic.
  if (
    /invalid_grant|invalid_client|oauth|insufficient (permissions|scopes)|unauthorized|access_denied|login.?required/i.test(
      message,
    )
  ) {
    return PUBLIC_SCHEDULING_UNAVAILABLE;
  }
  // Known product messages are fine to show.
  if (
    message &&
    /no longer available|invalid duration|booking page not found|not connected|destination calendar|pick another/i.test(
      message,
    )
  ) {
    return message;
  }
  return PUBLIC_SCHEDULING_UNAVAILABLE;
}

/** Humanize OAuth redirect / admin-facing Google errors. */
export function adminGoogleErrorMessage(raw: string): string {
  if (/invalid_grant/i.test(raw)) {
    return "Google access expired or was revoked (invalid_grant). Disconnect the affected account below, then connect it again. If it keeps failing, remove this app under Google Account → Security → Third-party access and retry.";
  }
  if (/access_denied/i.test(raw)) {
    return "Google access was denied. Try connecting again and accept the permissions.";
  }
  return raw;
}
