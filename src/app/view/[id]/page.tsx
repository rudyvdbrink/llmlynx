import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { ownFile } from "@/server/files/served";
import { baseName, isHtml } from "@/lib/files";
import { HtmlFrame } from "@/app/chat/components/FileCards";
import styles from "./View.module.css";

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: "LLMLYNX" };

// /view/:id -> an HTML file of a chat's sandbox, full size, in the same
// sandboxed frame as in the chat (see /api/attachments/:id/frame). The frame
// cannot navigate away from it: this page, like every page of the app, only
// lets frames show the app's own pages. Only for the owner of the chat.
export default async function ViewPage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const file = await ownFile(id, user.id);
  if (!file || !isHtml(file.mimeType)) notFound();
  return (
    <main className={styles.view}>
      <HtmlFrame id={file.id} title={baseName(file.name)} className={styles.frame} />
    </main>
  );
}
