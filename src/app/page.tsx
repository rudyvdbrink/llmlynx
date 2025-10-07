import { redirect } from "next/navigation";
import { getCurrentUser } from "../lib/session";

export default async function Index() {
  const user = await getCurrentUser();
  redirect(user ? "/chat" : "/login");
}