import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

export type AddressResolver = (hostname: string) => Promise<string[]>;

export interface ConnectorConnectionPolicy {
  url: URL;
  lookup: LookupFunction;
}

export function assertConnectorUrlShapeAllowed(value: string, allowPrivate: boolean): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) connector URLs are allowed.");
  if (url.username || url.password) throw new Error("Connector URLs cannot contain credentials.");
  const hostname = normalizeHostname(url.hostname);
  if (["localhost", "localhost.localdomain", "::1"].includes(hostname) || hostname.endsWith(".localhost")) {
    throw new Error("Blocked connector host.");
  }
  if (isIP(hostname)) {
    const classification = classifyAddress(hostname);
    if (classification === "blocked") throw new Error("Blocked connector host.");
    if (!allowPrivate && classification === "private") {
      throw new Error("Private connector hosts require an explicit local/private connector.");
    }
  }
  return url;
}

const defaultResolver: AddressResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

const privateRanges = new Set(["private", "carrierGradeNat", "uniqueLocal"]);
const blockedRanges = new Set([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "reserved",
  "discard",
  "benchmarking",
  "amt"
]);

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLocaleLowerCase();
}

function normalizedHostAllowlist(hosts: readonly string[]): Set<string> {
  return new Set(hosts.map((host) => normalizeHostname(host.trim())).filter(Boolean));
}

export function parseConnectorHostAllowlist(value: string | undefined): string[] {
  const hosts = (value ?? "")
    .split(",")
    .map((host) => normalizeHostname(host.trim()))
    .filter(Boolean);
  for (const host of hosts) {
    if (host.includes("://") || host.includes("/") || host.includes("@")) {
      throw new Error("Connector host allowlist entries must be hostnames or IP addresses without a scheme, path, or credentials.");
    }
  }
  return [...new Set(hosts)];
}

function normalizeAddress(address: string): string {
  return address.replace(/^\[|\]$/g, "").split("%")[0]!.toLocaleLowerCase();
}

function classifyAddress(address: string): "public" | "private" | "blocked" {
  const normalized = normalizeAddress(address);
  if (!ipaddr.isValid(normalized)) throw new Error("Connector hostname resolved to an invalid address.");
  const parsed = ipaddr.parse(normalized);
  const routable = parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
    ? parsed.toIPv4Address()
    : parsed;
  const range = routable.range();
  if (blockedRanges.has(range)) return "blocked";
  if (privateRanges.has(range)) return "private";
  return "public";
}

function lookupError(hostname: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "ENOTFOUND";
  error.path = hostname;
  return error;
}

function createPinnedLookup(hostname: string, addresses: string[]): LookupFunction {
  const approved = [...new Set(addresses.map(normalizeAddress))].map((address) => ({
    address,
    family: isIP(address) as 4 | 6
  }));

  return (requestedHostname, options, callback) => {
    queueMicrotask(() => {
      if (normalizeHostname(requestedHostname) !== hostname) {
        callback(lookupError(requestedHostname, "Connector socket lookup requested an unexpected host."), "", 0);
        return;
      }

      const requestedFamily = options.family === "IPv4"
        ? 4
        : options.family === "IPv6"
          ? 6
          : options.family ?? 0;
      const candidates = requestedFamily === 0
        ? approved
        : approved.filter(({ family }) => family === requestedFamily);
      if (candidates.length === 0) {
        callback(lookupError(requestedHostname, "Connector socket lookup has no approved address for the requested family."), "", 0);
        return;
      }

      if (options.all) callback(null, candidates);
      else callback(null, candidates[0]!.address, candidates[0]!.family);
    });
  };
}

export async function createConnectorConnectionPolicy(
  value: string,
  allowPrivate: boolean,
  resolver: AddressResolver = defaultResolver,
  allowedHosts?: readonly string[]
): Promise<ConnectorConnectionPolicy> {
  const url = assertConnectorUrlShapeAllowed(value, allowPrivate);
  const hostname = normalizeHostname(url.hostname);

  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch {
      throw new Error("Connector hostname could not be resolved.");
    }
  }
  if (addresses.length === 0) throw new Error("Connector hostname could not be resolved.");
  const classifications = addresses.map(classifyAddress);
  if (classifications.includes("blocked")) throw new Error("Blocked connector host.");
  if (!allowPrivate && classifications.includes("private")) throw new Error("Private connector hosts require an explicit local/private connector.");
  if (allowedHosts !== undefined && !normalizedHostAllowlist(allowedHosts).has(hostname)) {
    throw new Error("Connector host is not in the local host allowlist.");
  }

  return { url, lookup: createPinnedLookup(hostname, addresses) };
}

export async function assertConnectorUrlAllowed(
  value: string,
  allowPrivate: boolean,
  resolver: AddressResolver = defaultResolver,
  allowedHosts?: readonly string[]
): Promise<void> {
  await createConnectorConnectionPolicy(value, allowPrivate, resolver, allowedHosts);
}
