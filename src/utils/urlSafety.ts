/**
 * Phase 86 (R51-S1): shared SSRF/loopback URL guard. Originally lived
 * in `src/hooks/useTradeStorage.ts` (Phase 41 R45-STO-H1) for the
 * webhook fire-path; the matching settings "Test webhook" handler
 * (`src/app/settings/page.tsx`) only checked `protocol === 'https:'`
 * — letting a curious user probe `https://10.0.0.1/admin`,
 * `https://192.168.1.1/`, or AWS metadata via DNS-rebinding. Both
 * sites now share this helper.
 */

function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0") return true;
  if (
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".localhost")
  )
    return true;
  // IPv4 literals
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = parseInt(v4[1]!, 10);
    const b = parseInt(v4[2]!, 10);
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // 127/8 loopback
    if (a === 169 && b === 254) return true; // 169.254/16 link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a >= 224) return true; // multicast / reserved
  }
  // IPv6 literals
  if (h.startsWith("::") || h === "::1") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 ULA
  if (h.startsWith("fe80")) return true; // link-local
  return false;
}

export function isValidHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPrivateHostname(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}
