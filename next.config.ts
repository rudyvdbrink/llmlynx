import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  experimental: {
    agentUpgrade: "security",
  },
  async headers() {
    return [
      {
        // The app's pages hold HTML artifacts in sandboxed frames (see
        // /api/attachments/:id/frame). A frame may only show the app's own
        // pages, so a script in an artifact cannot navigate its frame to
        // another site and carry what the page holds there.
        source: "/((?!api/).*)",
        headers: [{ key: "Content-Security-Policy", value: "frame-src 'self'" }],
      },
    ];
  },
};

export default nextConfig;
