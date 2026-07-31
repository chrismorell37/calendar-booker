import { NextResponse } from "next/server";
import { getGoogleAuthUrl } from "@/lib/google";
import { getAdminSession } from "@/lib/session";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = getGoogleAuthUrl("admin");
    return NextResponse.redirect(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth start failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
