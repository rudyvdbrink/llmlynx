import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/session";
import AgentsClient from "./AgentsClient";

// Server component: protect the Agents page
export default async function AgentsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return <AgentsClient initialUser={{ id: user.id, email: user.email }} />;
}