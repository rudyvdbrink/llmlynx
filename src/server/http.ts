import { NextResponse } from "next/server";

export function jsonError(message: string, status: number, headers?: HeadersInit) {
  return NextResponse.json({ message }, { status, headers });
}

/** Reads the request body as a JSON object. Returns {} when the body is missing or invalid. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function getClientIp(req: Request): string | null {
  return (
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    null
  );
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
