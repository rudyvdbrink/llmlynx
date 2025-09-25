import { redirect } from "next/navigation";

// For now, always show login first.
// Later, replace with a session check and redirect to /chat if authenticated.
export default function Index() {
  redirect("/login");
}