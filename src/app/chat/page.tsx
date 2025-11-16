import { redirect } from "next/navigation";
import { getCurrentUser } from "../../server/auth/session";
import ChatClientPage from "./ChatClientPage";

export default async function ChatPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  // Pass through the minimal user data the client needs
  return <ChatClientPage user={{ id: user.id, email: user.email }} />;
}