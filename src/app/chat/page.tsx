import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import ChatClientPage from "./ChatClientPage";

// `conversation` is set by the sidebar on other pages, to open that conversation here
type Props = { searchParams: Promise<{ conversation?: string | string[] }> };

export default async function ChatPage({ searchParams }: Props) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  const { conversation } = await searchParams;
  return <ChatClientPage user={user} initialConversationId={typeof conversation === "string" ? conversation : null} />;
}
