import { validateDeclaration } from "@trinitymatrix/game-domain";
import type { AiAgentDecision, AiAgentObservation } from "./ai-openrouter";
import { AI_VALIDATION_TOOL_VERSION } from "./ai-game-protocol-v3";

export type AiProposalValidationFeedback = Readonly<{
  toolVersion: typeof AI_VALIDATION_TOOL_VERSION;
  code: "invalid-declaration" | "invalid-decision" | "invalid-card-reference";
  message: string;
}>;
export type AiProposalValidationResult = Readonly<{ valid: true }> | Readonly<{ valid: false; validation: AiProposalValidationFeedback }>;

/** Checks only the submitted move. It cannot search for, suggest, or replace a move. */
export function validateAiProposal(observation: AiAgentObservation, decision: AiAgentDecision): AiProposalValidationResult {
  const invalid = (code: AiProposalValidationFeedback["code"], message: string): AiProposalValidationResult => ({
    valid: false, validation: { toolVersion: AI_VALIDATION_TOOL_VERSION, code, message: message.slice(0, 320) }
  });
  if (!decision || !["draw-stock", "draw-discard", "discard", "declare", "submit-hand"].includes(decision.action)
    || (decision.cardId !== null && (typeof decision.cardId !== "string" || !decision.cardId.length || decision.cardId.length > 128))
    || !Array.isArray(decision.groups) || decision.groups.length > 14
    || decision.groups.some((group) => !Array.isArray(group) || group.length < 1 || group.length > 14
      || group.some((id) => typeof id !== "string" || !id.length || id.length > 128))) {
    return invalid("invalid-decision", "Return a correctly shaped action, cardId and groups using exact owned card IDs.");
  }
  const { state, playerId, hand } = observation;
  const showdown = state.phase === "showdown" && state.showdown?.pendingPlayerIds.includes(playerId);
  const playing = state.phase === "playing" && state.currentPlayerId === playerId
    && state.players.find(({ id }) => id === playerId)?.status === "playing";
  if ((!showdown && !playing) || (showdown && decision.action !== "submit-hand")
    || (playing && (hand.length === 13 ? !["draw-stock", "draw-discard"].includes(decision.action)
      : hand.length === 14 ? !["discard", "declare"].includes(decision.action) : true))) {
    return invalid("invalid-decision", "Use an action allowed by the current phase, turn and hand size.");
  }
  const ids = new Set(hand.map(({ id }) => id));
  const submitted = decision.groups.flat();
  if ((decision.cardId !== null && !ids.has(decision.cardId)) || submitted.some((id) => !ids.has(id))
    || new Set(submitted).size !== submitted.length) {
    return invalid("invalid-card-reference", "Use only exact card IDs from your hand, with no repeated card in the submitted groups.");
  }
  if (decision.action === "draw-stock" || decision.action === "draw-discard") {
    if (decision.cardId !== null || decision.groups.length) return invalid("invalid-decision", "A draw requires cardId:null and groups:[].");
    if (decision.action === "draw-discard" && !state.topDiscard) return invalid("invalid-decision", "A draw-discard action requires a visible top discard.");
  } else if (decision.action === "discard") {
    if (decision.cardId === null || decision.groups.length) return invalid("invalid-decision", "A discard requires one exact owned cardId and groups:[].");
  } else if (decision.action === "declare") {
    const validation = validateDeclaration(hand, decision.cardId ?? "", decision.groups, state.wildRank);
    if (!validation.valid) return invalid("invalid-declaration", validation.reason);
  } else if (decision.cardId !== null || submitted.length !== hand.length || hand.some(({ id }) => !submitted.includes(id))) {
    return invalid("invalid-decision", "A showdown submission requires cardId:null and every owned card exactly once across groups; unmatched groups are permitted.");
  }
  return { valid: true };
}
