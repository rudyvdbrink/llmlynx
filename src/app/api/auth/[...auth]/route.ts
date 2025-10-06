import { auth } from "../../../../lib/auth";

// Better Auth exposes a single handler function that supports both methods.
export const GET = auth.handler;
export const POST = auth.handler;