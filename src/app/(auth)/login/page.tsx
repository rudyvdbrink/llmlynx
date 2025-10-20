import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../server/auth/session";
import LoginForm from "./LoginForm";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/dashboard");
  }
  return <LoginForm />;
}