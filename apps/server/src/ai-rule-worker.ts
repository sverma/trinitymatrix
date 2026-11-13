import { parentPort } from "node:worker_threads";
import { checkAiRules, unavailableAiRules, type AiRulesInput } from "./ai-rule-tools";

if (!parentPort) throw new Error("The AI rules checker must run inside a worker thread.");
parentPort.on("message", (message: { id: number; input: AiRulesInput; timeoutMs: number }) => {
  try { parentPort!.postMessage({ id: message.id, facts: checkAiRules(message.input, { timeoutMs: message.timeoutMs }) }); }
  catch { parentPort!.postMessage({ id: message.id, facts: unavailableAiRules("tool-error") }); }
});
