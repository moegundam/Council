import http from "node:http";
import { assertDisposableGatewayConfiguration } from "./disposable-target.js";

const configuration = assertDisposableGatewayConfiguration(process.env);

function reject(response: http.ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

const server = http.createServer((request, response) => {
  if (request.headers.host !== configuration.webUrl.host) {
    reject(response, 421, "Disposable gateway rejected an unexpected Host header.");
    return;
  }

  let incomingUrl: URL;
  try {
    incomingUrl = new URL(request.url ?? "/", configuration.webUrl);
  } catch {
    reject(response, 400, "Disposable gateway rejected an invalid request target.");
    return;
  }
  if (incomingUrl.origin !== configuration.webUrl.origin) {
    reject(response, 421, "Disposable gateway rejected a non-loopback request target.");
    return;
  }
  if (incomingUrl.pathname === "/__e2e_ready") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ deploymentClass: "disposable", status: "ready" }));
    return;
  }

  const upstream = incomingUrl.pathname === "/api" || incomingUrl.pathname.startsWith("/api/")
    ? configuration.apiUrl
    : configuration.appUrl;
  const proxyRequest = http.request({
    hostname: upstream.hostname,
    port: upstream.port,
    method: request.method,
    path: `${incomingUrl.pathname}${incomingUrl.search}`,
    headers: { ...request.headers, host: upstream.host }
  }, (proxyResponse) => {
    response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
    proxyResponse.pipe(response);
  });
  proxyRequest.on("error", (error) => {
    if (!response.headersSent) reject(response, 502, `Disposable upstream unavailable: ${error.message}`);
    else response.destroy(error);
  });
  request.pipe(proxyRequest);
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

function close(): void {
  server.close(() => process.exit(0));
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
server.listen(Number(configuration.webUrl.port), configuration.webUrl.hostname, () => {
  process.stdout.write(`Disposable E2E gateway listening on ${configuration.webUrl.origin}\n`);
});
