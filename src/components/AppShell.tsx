"use client";

import { useEffect, useState } from "react";
import styles from "./AppShell.module.css";
import Sidebar, { type SidebarProps } from "./sidebar/Sidebar";
import { isNarrowViewport } from "@/lib/viewport";

/** Page frame with the collapsible sidebar. On small screens a backdrop closes it on tap. */
export default function AppShell({
  sidebar,
  children,
}: {
  sidebar: Omit<SidebarProps, "collapsed" | "onToggle">;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // The viewport width is unknown during server rendering, so the server always
  // renders the sidebar expanded and this corrects it once after hydration.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isNarrowViewport()) setCollapsed(true);
  }, []);

  return (
    <main className={styles.page}>
      {!collapsed && (
        <button
          type="button"
          className={styles.sidebarBackdrop}
          aria-label="Collapse sidebar"
          onClick={() => setCollapsed(true)}
        />
      )}

      <Sidebar {...sidebar} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />

      {children}
    </main>
  );
}
