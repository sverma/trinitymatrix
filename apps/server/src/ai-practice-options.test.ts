import { describe, expect, it } from "vitest";
import { parseAiPracticeOptions } from "./ai-practice-options";

describe("finite operator practice options", () => {
  it("defaults to one finite round with bounded concurrency and supports private practice", () => {
    expect(parseAiPracticeOptions([])).toEqual({ help: false, rounds: 1, concurrency: 2, promote: true, modelIds: [] });
    expect(parseAiPracticeOptions(["--rounds=3", "--concurrency", "1", "--no-promote", "provider/model", "provider/model"]))
      .toEqual({ help: false, rounds: 3, concurrency: 1, promote: false, modelIds: ["provider/model"] });
  });
  it.each([["--rounds", "0"], ["--rounds=4"], ["--rounds=1.5"], ["--rounds"], ["--concurrency=99"],
    ["--forever"], ["https://example.com"], ["model;command"]].map((args) => [args] as const))("rejects unbounded or unexpected inputs %j", (args) => {
    expect(() => parseAiPracticeOptions(args)).toThrow();
  });
});
