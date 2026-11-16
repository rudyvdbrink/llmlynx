// The audit log of the security checks (the SecurityEvent model). Events are
// collected in memory and written in one go, so that no check waits on the
// database. An event holds no content and no full URL: a host and a hash only.

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";

export type SecurityEventInput = {
  tool?: string; // the tool whose call or result was checked
  check: "url" | "injection" | "virus" | "decision";
  verdict: "allow" | "warn" | "block";
  reason: string; // a reason code, such as "clean", "injection" or "url_exfil"
  score?: number;
  host?: string | null;
  contentHash?: string;
  durationMs?: number;
  decision?: string; // what the user chose in a dialog
};

export type AuditLog = {
  /** Notes an event. Does not touch the database. */
  add(event: SecurityEventInput): void;
  /** Writes the events noted so far. Never throws: a log that cannot be written must not break a reply. */
  flush(): Promise<void>;
};

/** SHA-256 of a text or of bytes, in hex: how the log refers to content. */
export function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A log for the checks of one request of `userId`, in `conversationId` (null for a file that is not in one yet). */
export function createAuditLog(userId: string, conversationId: string | null): AuditLog {
  let events: Prisma.SecurityEventCreateManyInput[] = [];
  return {
    add(event) {
      events.push({ ...event, userId, conversationId, createdAt: new Date() });
    },
    async flush() {
      if (!events.length) return;
      const batch = events;
      events = [];
      try {
        await prisma.securityEvent.createMany({ data: batch });
      } catch (err) {
        console.error(`Writing ${batch.length} security event(s) failed: ${(err as Error)?.message || err}`);
      }
    },
  };
}
