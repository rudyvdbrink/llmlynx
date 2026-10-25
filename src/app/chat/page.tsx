import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import ChatClientPage from "./ChatClientPage";

export default async function ChatPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return <ChatClientPage user={user} />;
}