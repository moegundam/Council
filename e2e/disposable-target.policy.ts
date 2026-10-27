import assert from "node:assert/strict";
import {
  DISPOSABLE_E2E_MARKER,
  assertDisposableE2eConfiguration,
  assertDisposableGatewayConfiguration,
  assertLoopbackHttpUrl
} from "./disposable-target.js";
import { ownsDisposableWebServer } from "./disposable-global-teardown.js";

const validEnvironment = {
  E2E_DEPLOYMENT_CLASS: "disposable",
  E2E_DISPOSABLE_MARKER: DISPOSABLE_E2E_MARKER,
  E2E_WEB_URL: "http://127.0.0.1:3000",
  E2E_API_URL: "http://127.0.0.1:4000"
};

const configuration = assertDisposableE2eConfiguration(validEnvironment);
assert.equal(configuration.webUrl.origin, "http://127.0.0.1:3000");
assert.equal(configuration.apiUrl.origin, "http://127.0.0.1:4000");
assert.equal(
  assertDisposableGatewayConfiguration(validEnvironment).appUrl.origin,
  "http://127.0.0.1:3001"
);

assert.throws(
  () => assertDisposableE2eConfiguration({ ...validEnvironment, E2E_DISPOSABLE_MARKER: undefined }),
  /disposable marker/i
);
assert.throws(
  () => assertDisposableE2eConfiguration({ ...validEnvironment, E2E_DEPLOYMENT_CLASS: "production" }),
  /deployment class/i
);
assert.throws(
  () => assertDisposableE2eConfiguration({
    ...validEnvironment,
    E2E_WEB_URL: "https://council.example"
  }),
  /loopback/i
);
assert.throws(
  () => assertDisposableE2eConfiguration({ ...validEnvironment, E2E_API_URL: "http://192.168.1.50:4000" }),
  /loopback/i
);
assert.throws(() => assertLoopbackHttpUrl("https://127.0.0.1:3000", "test URL"), /plain HTTP/i);
assert.throws(() => assertLoopbackHttpUrl("http://owner:secret@127.0.0.1:3000", "test URL"), /credentials/i);
assert.throws(() => assertLoopbackHttpUrl("http://127.0.0.1", "test URL"), /explicit port/i);
assert.throws(
  () => assertDisposableGatewayConfiguration({
    ...validEnvironment,
    E2E_APP_UPSTREAM_URL: "http://council.example:3001"
  }),
  /loopback/i
);
assert.throws(
  () => assertDisposableGatewayConfiguration({
    ...validEnvironment,
    E2E_APP_UPSTREAM_URL: validEnvironment.E2E_WEB_URL
  }),
  /origins must be distinct/i
);
assert.equal(ownsDisposableWebServer({ E2E_REUSE_EXISTING_SERVERS: "true" }), false);
assert.equal(ownsDisposableWebServer({}), true);
assert.equal(ownsDisposableWebServer({ E2E_REUSE_EXISTING_SERVERS: "false" }), true);

process.stdout.write("disposable Playwright target policy tests passed\n");
