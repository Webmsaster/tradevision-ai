/**
 * Phase 86 (R51-S1): shared SSRF/loopback URL guard. Originally lived
 * in `src/hooks/useTradeStorage.ts` (Phase 41 R45-STO-H1) for the
 * webhook fire-path; the matching settings "Test webhook" handler
 * (`src/app/settings/page.tsx`) only checked `protocol === 'https:'`
 * — letting a curious user probe `https://10.0.0.1/admin`,
 * `https://192.168.1.1/`, or AWS metadata via DNS-rebinding. Both
 * sites now share this helper.
 */

// Round 54 (Finding #5): exported so the new server-side webhook-test
// route can re-validate DNS-resolved IPs against the same private-range
// rules used by the URL-string check (defends against DNS rebinding).
export function isPrivateHostname(host: string): boolean {
  // Round 54 audit fix: `new URL("https://[fe80::1]/").hostname` returns
  // "[fe80::1]" WITH brackets in Node, so the IPv6 startsWith() checks
  // below were silently dead. Strip brackets first; also lower-case for
  // the .local/.internal/.localhost suffix checks.
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
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
  // IPv6 literals — explicit forms.
  if (h === "::1" || h === "::") return true;
  // Round 58 (Warning Fix #4): defensive regex against uncompressed
  // IPv6 loopback. WHATWG URL canonicalizes `[0:0:0:0:0:0:0:1]` to
  // `::1` in both modern Node and browsers, but if a future runtime
  // (or polyfill, or hand-built input path) ever skips that
  // canonicalization, a literal `0:0:0:0:0:0:0:1` would slip past the
  // exact-string match above. Match any all-zeros prefix terminated by
  // `1` (with optional leading zeros): "0:0:...:1" or "0:0::1" forms.
  // Empty groups (the `::` shorthand) are pre-stripped in valid URL
  // input — but the canonical form for these always begins/ends with
  // a zero group followed by 1, so the regex is sufficient.
  if (/^(0+:)+0*1$/.test(h)) return true; // "0:0:0:0:0:0:0:1", "0:0:1", etc.
  // Mixed `::` shorthand expansion: `[0::1]` becomes "0::1" if not
  // canonicalized (string contains an empty group via "::"). Match
  // explicit "0::1", "0:0::1" etc.
  if (/^(0+:)+:0*1$/.test(h)) return true;
  // All-zeros wildcard: "0:0:0:0:0:0:0:0" or "0::" forms.
  if (/^(0+:)+0+$/.test(h)) return true;
  if (/^(0+:)+:$/.test(h)) return true;
  // IPv4-mapped IPv6: Node's URL constructor compresses dotted form into
  // hex, so "::ffff:127.0.0.1" arrives as "::ffff:7f00:1". Decode either
  // shape to a dotted IPv4 string and recurse.
  const v4Mapped = h.match(
    /^::ffff:(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/,
  );
  if (v4Mapped) {
    if (v4Mapped[1]) return isPrivateHostname(v4Mapped[1]);
    const hi = parseInt(v4Mapped[2]!, 16);
    const lo = parseInt(v4Mapped[3]!, 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateHostname(dotted);
  }
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
