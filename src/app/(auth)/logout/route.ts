import { NextResponse } from "next/server";
import { destroySession } from "../../../lib/session";

export async function GET(request: Request) {
  // Destroy the session (cookie + db row)
  await destroySession();

  // Use an absolute URL for reliability in redirects
  const loginURL = new URL("/login", request.url);
  return NextResponse.redirect(loginURL);
}

// Optional: allow POST as well if something posts to /logout
export const POST = GET;
export const HEAD = GET;