import { NextResponse } from "next/server";
import { adminGoogleErrorMessage } from "@/lib/errors";
import { exchangeCodeForTokens } from "@/lib/google";
import { getAdminSession } from "@/lib/session";

export async function GET(request: Request) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const session = await getAdminSession();
    if (!session.isAdmin) {
      return NextResponse.redirect(`${appUrl}/admin?error=unauthorized`);
    }
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");
    const error = searchParams.get("error");
    if (error) {
      return NextResponse.redirect(
        `${appUrl}/admin?error=${encodeURIComponent(adminGoogleErrorMessage(error))}`,
      );
    }
    if (!code) {
      return NextResponse.redirect(`${appUrl}/admin?error=missing_code`);
    }
    await exchangeCodeForTokens(code);
    return NextResponse.redirect(`${appUrl}/admin?connected=1`);
  } catch (err) {
    console.error("Google OAuth callback failed", err);
    const message = adminGoogleErrorMessage(
      err instanceof Error ? err.message : "OAuth failed",
    );
    return NextResponse.redirect(
      `${appUrl}/admin?error=${encodeURIComponent(message)}`,
    );
  }
}
