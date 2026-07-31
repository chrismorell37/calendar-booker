import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { password?: string };
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) {
      return NextResponse.json(
        { error: "ADMIN_PASSWORD is not configured" },
        { status: 500 },
      );
    }
    if (!body.password || body.password !== expected) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const session = await getAdminSession();
    session.isAdmin = true;
    await session.save();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Login failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  const session = await getAdminSession();
  session.destroy();
  return NextResponse.json({ ok: true });
}
