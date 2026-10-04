import { describe, it, expect, vi, beforeEach } from "vitest";
import { withReasoningEffort, resetReasoningEffortCache } from "./reasoning-effort.js";

const rejection = Object.assign(new Error("Unrecognized request argument supplied: reasoning_effort"), {
  status: 400,
});

describe("withReasoningEffort", () => {
  beforeEach(() => resetReasoningEffortCache());

  it("sends nothing when no effort is configured", async () => {
    const send = vi.fn().mockResolvedValue("ok");
    await withReasoningEffort("m", undefined, send);
    expect(send).toHaveBeenCalledWith({});
  });

  it("retries without the parameter once a model rejects it, and remembers", async () => {
    const send = vi.fn().mockRejectedValueOnce(rejection).mockResolvedValue("ok");
    vi.spyOn(console, "info").mockImplementation(() => {});

    expect(await withReasoningEffort("gpt-4.1-mini", "low", send)).toBe("ok");
    expect(send.mock.calls).toEqual([[{ reasoning_effort: "low" }], [{}]]);

    await withReasoningEffort("gpt-4.1-mini", "low", send);
    expect(send.mock.calls[2]).toEqual([{}]);
  });

  it("does not swallow unrelated 400s", async () => {
    const other = Object.assign(new Error("bad tool schema"), { status: 400 });
    const send = vi.fn().mockRejectedValue(other);
    await expect(withReasoningEffort("m", "low", send)).rejects.toBe(other);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
