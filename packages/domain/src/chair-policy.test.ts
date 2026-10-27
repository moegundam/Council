import { describe, expect, it } from "vitest";
import { evaluateChairPolicy } from "./chair-policy.js";

describe("chair policy", () => {
  it("suggests intervention for repeated contributions", () => {
    const result = evaluateChairPolicy({
      agenda: "確認平台模型與工具權限",
      recentMessages: [
        "模型與工具權限需要白名單",
        "模型與工具權限需要白名單"
      ],
      remainingMinutes: 18
    });

    expect(result?.reason).toBe("repetition");
    expect(result?.suggestedMode).toBe("chaired");
  });

  it("suggests convergence when time is nearly exhausted", () => {
    const result = evaluateChairPolicy({
      agenda: "確認第一版架構",
      recentMessages: ["比較雲端與地端模型的取捨"],
      remainingMinutes: 2
    });

    expect(result?.reason).toBe("time_remaining");
    expect(result?.suggestedMode).toBe("fixed");
  });

  it("uses CJK segments to distinguish related and unrelated speech", () => {
    expect(evaluateChairPolicy({
      agenda: "確認平台模型與工具權限",
      recentMessages: ["模型與工具權限需要白名單"],
      remainingMinutes: 20
    })).toBeNull();
    expect(evaluateChairPolicy({
      agenda: "確認平台模型與工具權限",
      recentMessages: ["今天午餐想吃義大利麵"],
      remainingMinutes: 20
    })?.reason).toBe("off_topic");
  });
});
