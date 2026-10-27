export function rewriteVersionedApiUrl(url: string): string {
  if (url === "/api/v1") return "/api";
  if (url.startsWith("/api/v1/")) return `/api/${url.slice("/api/v1/".length)}`;
  return url;
}
