import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LLMLYNX Chat",
  description: "Chat with LLMLYNX",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Keep only what is truly global here. Page-specific UI (e.g., fixed logo) goes in nested layouts.
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
