export function credentialIsExpired(expiresAt: unknown, now = Date.now()): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  if (typeof expiresAt !== "string") return true;
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}
