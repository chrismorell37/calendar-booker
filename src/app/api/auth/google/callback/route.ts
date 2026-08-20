import { NextResponse } from "next/server";
import { adminGoogleErrorMessage } from "@/lib/errors";
import { exchangeCodeForTokens } from "@/lib/google";
import { getAdminSession } from "@/lib/session";

export async function GET(request: Request) {
  const adminUrl = (suffix: string) =>
    new URL(suffix, new URL(request.url).origin);

  try {
    const session = await getAdminSession();
    if (!session.isAdmin) {
      return NextResponse.redirect(adminUrl("/admin?error=unauthorized"));
    }
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");
    const error = searchParams.get("error");
    if (error) {
      return NextResponse.redirect(
        adminUrl(
          `/admin?error=${encodeURIComponent(adminGoogleErrorMessage(error))}`,
        ),
      );
    }
    if (!code) {
      return NextResponse.redirect(adminUrl("/admin?error=missing_code"));
    }
    await exchangeCodeForTokens(code, request);
    return NextResponse.redirect(adminUrl("/admin?connected=1"));
  } catch (err) {
    console.error("Google OAuth callback failed", err);
    const message = adminGoogleErrorMessage(
      err instanceof Error ? err.message : "OAuth failed",
    );
    return NextResponse.redirect(
      adminUrl(`/admin?error=${encodeURIComponent(message)}`),
    );
  }
}
