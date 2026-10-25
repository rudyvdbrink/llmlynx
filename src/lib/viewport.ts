// Below this width the UI uses its mobile behavior (sidebar starts collapsed,
// the composer does not grab focus, which would open the on-screen keyboard).
const NARROW_VIEWPORT_PX = 760;

export function isNarrowViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth < NARROW_VIEWPORT_PX;
}
