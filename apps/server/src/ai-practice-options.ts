export type AiPracticeOptions = { help: boolean; rounds: number; concurrency: number; promote: boolean; modelIds: string[] };

/** Paid practice is finite and explicitly operator-triggered. */
export function parseAiPracticeOptions(args: readonly string[]): AiPracticeOptions {
  const options: AiPracticeOptions = { help: false, rounds: 1, concurrency: 2, promote: true, modelIds: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--help") options.help = true;
    else if (value === "--no-promote") options.promote = false;
    else if (value === "--rounds" || value.startsWith("--rounds=") || value === "--concurrency" || value.startsWith("--concurrency=")) {
      const key = value.startsWith("--rounds") ? "rounds" : "concurrency";
      const count = value.includes("=") ? value.slice(value.indexOf("=") + 1) : args[++index];
      if (!count || !/^[1-3]$/.test(count)) throw new Error("bounded-option-required");
      options[key] = Number(count);
    } else if (value.startsWith("--")) throw new Error("unknown-option");
    else {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/.test(value)) throw new Error("invalid-model-id");
      if (!options.modelIds.includes(value)) options.modelIds.push(value);
    }
  }
  return options;
}
