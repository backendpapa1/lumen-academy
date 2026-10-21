import dns, { type LookupAddress, type LookupOptions } from "node:dns";

// The Android app (ADR-012) runs this server on a stock linux-arm64 Node through
// a bundled glibc. Android has no /etc/resolv.conf, so glibc's getaddrinfo can't
// resolve a name: resolve with Node's own resolver (c-ares) instead, against the
// phone's DNS servers (LUMEN_DNS, from the app) and public ones after them.
// Active only with LUMEN_ANDROID=1.

const PUBLIC_DNS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];

type Resolve = (host: string, family: 4 | 6) => Promise<string[]>;
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** Names and literals the system can answer without DNS. */
const local = (host: string) =>
  host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");

/** A dns.lookup that asks `resolve` (A first, AAAA if there's none, or the other way round). */
export function makeLookup(resolve: Resolve, fallback: typeof dns.lookup) {
  return (
    host: string,
    options: LookupOptions | number | LookupCallback,
    callback?: LookupCallback,
  ): void => {
    let opts: LookupOptions = {};
    if (typeof options === "function") callback = options;
    else if (typeof options === "number") opts = { family: options };
    else opts = options ?? {};
    const cb = callback!;
    if (local(host)) return void (fallback as (...a: unknown[]) => void)(host, opts, cb);
    const first = opts.family === 6 ? 6 : 4;
    resolve(host, first)
      .catch(() => resolve(host, first === 4 ? 6 : 4))
      .then((addrs) => {
        if (!addrs.length)
          throw Object.assign(new Error(`no address for ${host}`), { code: "ENOTFOUND" });
        const family = addrs[0]!.includes(":") ? 6 : 4;
        if (opts.all)
          cb(
            null,
            addrs.map((address) => ({ address, family })),
          );
        else cb(null, addrs[0]!, family);
      })
      .catch((e: NodeJS.ErrnoException) => cb(e, ""));
  };
}

export function dnsServers(env: Record<string, string | undefined>): string[] {
  const phone = (env.LUMEN_DNS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[\d.]+$/.test(s) || s.includes(":"));
  return [...new Set([...phone, ...PUBLIC_DNS])];
}

export function setupAndroid(env: Record<string, string | undefined> = process.env): boolean {
  if (!env.LUMEN_ANDROID) return false;
  dns.setServers(dnsServers(env));
  // The callback API's resolver: setServers above set its servers (dns.promises has its own).
  const resolve: Resolve = (host, family) =>
    new Promise((ok, no) =>
      (family === 6 ? dns.resolve6 : dns.resolve4)(host, (err, addrs) =>
        err ? no(err) : ok(addrs),
      ),
    );
  (dns as { lookup: unknown }).lookup = makeLookup(resolve, dns.lookup);
  return true;
}

setupAndroid();
