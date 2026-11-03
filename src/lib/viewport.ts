// Below this width the UI uses its mobile behavior (sidebar starts collapsed,
// the composer does not grab focus, which would open the on-screen keyboard).
const NARROW_VIEWPORT_PX = 760;

export function isNarrowViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth < NARROW_VIEWPORT_PX;
}

// Up to this width the sidebar opens over the page instead of beside it, so it
// starts collapsed. Matches the 860px breakpoints in AppShell.module.css and
// Sidebar.module.css.
const SIDEBAR_OVERLAY_MAX_PX = 860;

export function isSidebarOverlay(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= SIDEBAR_OVERLAY_MAX_PX;
}
