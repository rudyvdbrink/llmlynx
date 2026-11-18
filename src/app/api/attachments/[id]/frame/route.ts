import { getCurrentUser } from "@/server/auth/session";
import { jsonError } from "@/server/http";
import { fileData } from "@/server/files/store";
import { FRAME_CSP, ownFile } from "@/server/files/served";
import { isHtml } from "@/lib/files";

type Ctx = { params: Promise<{ id: string }> };

// Before the page's own scripts. Opened as a page of its own rather than in a
// frame, the page stops: the rest of it becomes inert text, so none of its
// scripts or markup runs (see GET). WebRTC is the one way out that the content
// policy does not close, so the page does not get it.
const GUARD = `<script>(()=>{if(window.top===window){document.write('<p style="font:14px sans-serif">This page only opens in the chat.</p><plaintext hidden>');return}for(const n of ["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","RTCDtlsTransport","RTCIceTransport","RTCSctpTransport","RTCCertificate","RTCEncodedAudioFrame","RTCEncodedVideoFrame","MediaStreamTrackProcessor"])try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false})}catch{}for(const p of ["contentWindow","contentDocument"])Object.defineProperty(HTMLIFrameElement.prototype,p,{get(){return null},configurable:false})})();</script>`;

/** The page with the guard first: after its doctype, so that it keeps its rendering mode. */
function guarded(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + GUARD + html.slice(doctype[0].length) : GUARD + html;
}

// GET /api/attachments/:id/frame -> an HTML file of the chat's sandbox, as a
// page for a sandboxed frame (the chat, the sandbox panel and the full size
// view put it in one). Its scripts run in an origin of its own, and it can
// load or send nothing (see FRAME_CSP). Only for the user whose conversation
// it belongs to, and only as a frame: opened as a page of its own, a script in
// it could navigate away and carry what the page holds. Browsers send
// Sec-Fetch-Dest only to secure origins (https, localhost), so over plain
// http the header is missing: then the guard in the page stops it when it is
// not in a frame.
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  const dest = req.headers.get("sec-fetch-dest");
  if (dest && dest !== "iframe") return jsonError("This page only opens in a frame.", 403);

  const file = await ownFile(id, user.id);
  if (!file || !isHtml(file.mimeType)) return jsonError("Not found", 404);
  const html = (await fileData(file.id)).toString("utf8");
  return new Response(guarded(html), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "X-DNS-Prefetch-Control": "off",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": FRAME_CSP,
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), bluetooth=()",
    },
  });
}
