"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import { useConversationList } from "@/hooks/useConversationList";
import { DEFAULT_SELECTION } from "@/lib/selection";
import type { ProviderSettings } from "@/lib/providers";
import type { SessionUser } from "@/lib/types";
import chatStyles from "../chat/Chat.module.css";
import styles from "./Account.module.css";
import ProvidersCard from "./components/ProvidersCard";
import PasswordCard from "./components/PasswordCard";
import DeleteAccountCard from "./components/DeleteAccountCard";

export default function AccountClient({
  user,
  memberSince,
  initialProviderSettings,
}: {
  user: SessionUser;
  memberSince: string | null;
  initialProviderSettings: ProviderSettings;
}) {
  const router = useRouter();

  // Sidebar state (auth ensured by server)
  const conversationList = useConversationList();
  const [sidebarSelection, setSidebarSelection] = useState(DEFAULT_SELECTION);
  const goToChat = () => router.push("/chat");

  const [loggingOut, setLoggingOut] = useState(false);

  async function logOut() {
    setLoggingOut(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
  }

  return (
    <AppShell
      sidebar={{
        user,
        model: sidebarSelection,
        onChangeModel: setSidebarSelection,
        conversationList,
        activeConversationId: null,
        onNewConversation: goToChat,
        onOpenConversation: goToChat,
        footerNavLabel: "Back to chat",
        footerNavHref: "/chat",
      }}
    >
      <div className={`${chatStyles.chatArea} ${styles.accountArea}`}>
        <header className={styles.header}>
          <div className={styles.headerText}>
            <h1 className={styles.title}>Account</h1>
            <p className={styles.subtitle}>
              {user.email}
              {memberSince && <> · Member since {memberSince}</>}
            </p>
          </div>
          <button type="button" className={styles.secondaryBtn} onClick={logOut} disabled={loggingOut}>
            {loggingOut ? "Logging out..." : "Log out"}
          </button>
        </header>

        <ProvidersCard initialSettings={initialProviderSettings} />
        <PasswordCard />
        <DeleteAccountCard />
      </div>
    </AppShell>
  );
}
