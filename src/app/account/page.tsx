import { redirect } from "next/navigation";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { getProviderSettings } from "@/server/providers";
import AccountClient from "./AccountClient";

// Server component: protect the Account page and load its settings
export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const [account, providerSettings] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { createdAt: true } }),
    getProviderSettings(user.id),
  ]);
  // Formatted here with a fixed locale, so server and browser render the same text.
  const memberSince = account?.createdAt.toLocaleDateString("en", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  return <AccountClient user={user} memberSince={memberSince ?? null} initialProviderSettings={providerSettings} />;
}
