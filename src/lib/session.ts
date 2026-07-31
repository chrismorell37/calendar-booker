import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export type AdminSession = {
  isAdmin?: boolean;
};

function sessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set (32+ characters)");
  }
  return {
    cookieName: "booking_admin",
    password,
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
    },
  };
}

export async function getAdminSession() {
  return getIronSession<AdminSession>(await cookies(), sessionOptions());
}

export async function requireAdmin() {
  const session = await getAdminSession();
  if (!session.isAdmin) {
    throw new Error("Unauthorized");
  }
  return session;
}
