export const DISPOSABLE_E2E_MARKER = "council-agent-meeting-platform-disposable-e2e-v1";

type DisposableEnvironment = Readonly<Record<string, string | undefined>>;

export interface DisposableE2eConfiguration {
  webUrl: URL;
  apiUrl: URL;
}

export interface DisposableGatewayConfiguration extends DisposableE2eConfiguration {
  appUrl: URL;
}

export function assertLoopbackHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (url.hostname !== "127.0.0.1") throw new Error(`${label} must use the literal loopback host 127.0.0.1.`);
  if (url.protocol !== "http:") throw new Error(`${label} must use plain HTTP.`);
  if (!url.port) throw new Error(`${label} must declare an explicit port.`);
  if (url.username || url.password) throw new Error(`${label} cannot contain credentials.`);
  return url;
}

function assertRootUrl(url: URL, label: string): void {
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must identify a loopback origin without a path, query, or fragment.`);
  }
}

export function assertDisposableE2eConfiguration(environment: DisposableEnvironment): DisposableE2eConfiguration {
  if (environment.E2E_DEPLOYMENT_CLASS !== "disposable") {
    throw new Error("Playwright E2E deployment class must be exactly disposable.");
  }
  if (environment.E2E_DISPOSABLE_MARKER !== DISPOSABLE_E2E_MARKER) {
    throw new Error("Playwright E2E disposable marker is missing or invalid.");
  }

  const webUrl = assertLoopbackHttpUrl(environment.E2E_WEB_URL ?? "http://127.0.0.1:3000", "E2E web URL");
  const apiUrl = assertLoopbackHttpUrl(environment.E2E_API_URL ?? "http://127.0.0.1:4000", "E2E API URL");
  assertRootUrl(webUrl, "E2E web URL");
  assertRootUrl(apiUrl, "E2E API URL");
  if (webUrl.origin === apiUrl.origin) throw new Error("E2E web and API origins must be distinct.");

  return { webUrl, apiUrl };
}

export function assertDisposableGatewayConfiguration(environment: DisposableEnvironment): DisposableGatewayConfiguration {
  const configuration = assertDisposableE2eConfiguration(environment);
  const appUrl = assertLoopbackHttpUrl(
    environment.E2E_APP_UPSTREAM_URL ?? "http://127.0.0.1:3001",
    "E2E app upstream URL"
  );
  assertRootUrl(appUrl, "E2E app upstream URL");
  if (appUrl.origin === configuration.webUrl.origin || appUrl.origin === configuration.apiUrl.origin) {
    throw new Error("E2E app upstream, web, and API origins must be distinct.");
  }
  return { ...configuration, appUrl };
}
