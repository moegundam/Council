import { describe, expect, it } from "vitest";
import { LatestRequestGate } from "./latest-request.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("LatestRequestGate", () => {
  it("rejects an older Prompt load that completes after the latest selection", async () => {
    const gate = new LatestRequestGate();
    const promptA = deferred<string>();
    const promptB = deferred<string>();
    const applied: string[] = [];

    const load = async (request: Promise<string>) => {
      const token = gate.begin();
      const value = await request;
      if (gate.isCurrent(token)) applied.push(value);
    };
    const loadingA = load(promptA.promise);
    const loadingB = load(promptB.promise);

    promptB.resolve("Prompt B");
    await loadingB;
    promptA.resolve("Prompt A");
    await loadingA;

    expect(applied).toEqual(["Prompt B"]);
  });

  it("invalidates an outstanding request when its editor closes", () => {
    const gate = new LatestRequestGate();
    const token = gate.begin();

    gate.cancel();

    expect(gate.isCurrent(token)).toBe(false);
  });
});
