// URL checks before a page is opened. The egress proxy is the real boundary
// (it refuses private addresses for every request, redirects included); these
// checks give the model a clear reason instead of a failed page load.

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** An error whose message is meant for the model. */
export class ToolError extends Error {}

// Same ranges as tools/egress/squid.conf
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

function isPrivate(address: string): boolean {
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return PRIVATE.check(mapped[1], "ipv4");
  return PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/** Returns the URL to open, or throws a ToolError saying why it cannot be opened. */
export async function checkUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ToolError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError("Only http and https URLs can be opened.");
  }
  if (url.username || url.password) throw new ToolError("URLs with a user name or password cannot be opened.");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new ToolError(`Could not find the server for ${url.hostname}.`);
  }
  if (addresses.some(isPrivate)) {
    throw new ToolError(`${url.hostname} is on a private network, which agents cannot open.`);
  }
  return url;
}
