import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

function permitted(address: string, allowPrivate: boolean) {
  const ip = ipaddr.process(address);
  const range = ip.range();
  return (
    range === "unicast" ||
    (allowPrivate && ["private", "loopback", "uniqueLocal"].includes(range))
  );
}
export async function providerTarget(
  raw: string,
  allowPrivate = false,
  signal = AbortSignal.timeout(5000),
) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid provider URL");
  if (url.protocol === "http:" && !allowPrivate)
    throw new Error("HTTPS required");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    /(^|\.)(metadata|metadata\.google\.internal)$/.test(hostname) ||
    hostname === "instance-data.ec2.internal"
  )
    throw new Error("Metadata host prohibited");
  signal.throwIfAborted();
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<{ address: string; family: number }[]>(
        (resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          lookup(hostname, { all: true })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        },
      );
  if (
    !addresses.length ||
    addresses.some((a) => !permitted(a.address, allowPrivate))
  )
    throw new Error("Provider address prohibited");
  return { url, addresses };
}
export async function providerDispatcher(
  raw: string,
  allowPrivate = false,
  signal = AbortSignal.timeout(5000),
) {
  const { addresses } = await providerTarget(raw, allowPrivate, signal);
  // Pin the validated DNS result. No second lookup, preventing DNS rebinding.
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    const selected =
      addresses.find((a) => !options.family || a.family === options.family) ??
      addresses[0];
    if (options.all) (callback as any)(null, addresses);
    else callback(null, selected.address, selected.family);
  };
  return new Agent({ connect: { lookup: pinnedLookup, timeout: 10000 } });
}
