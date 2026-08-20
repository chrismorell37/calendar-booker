/** Canonical production host (apex redirects here). */
export const CANONICAL_HOST = "www.chrismorell.xyz";

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}

function envAppUrl(): string | null {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!fromEnv || fromEnv.includes("localhost")) return null;
  return fromEnv;
}

/** Public site origin for links and OAuth redirects. */
export function getRequestOrigin(request?: Request): string {
  if (request) {
    const url = new URL(request.url);
    const hostRaw =
      request.headers.get("x-forwarded-host") ??
      request.headers.get("host") ??
      url.host;
    const host = hostRaw.split(",")[0]?.trim();
    const proto =
      request.headers.get("x-forwarded-proto") ??
      (host?.includes("localhost") ? "http" : "https");
    if (host) return `${proto}://${host}`;
    return url.origin;
  }

  const fromEnv = envAppUrl();
  if (fromEnv) return fromEnv;

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  if (isProductionRuntime()) {
    return `https://${CANONICAL_HOST}`;
  }

  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "http://localhost:3000";
}

export function getAppBaseUrl(request?: Request): string {
  return getRequestOrigin(request);
}

/** Google OAuth redirect URI — must match an authorized URI in Google Cloud Console. */
export function getGoogleRedirectUri(request?: Request): string {
  const envUri = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (envUri && !envUri.includes("localhost")) return envUri;
  return `${getRequestOrigin(request)}/api/auth/google/callback`;
}
