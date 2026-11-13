# Versioned AI game protocol

Protocol v2 makes the winning objective explicit: **declare at the first legal opportunity**. A model must check readiness before every post-draw move. A legal declaration takes priority over improving points. The reported natural 21+27+27+27 arrangement is a valid 102-point declaration after drawing and discarding the extra card; it is not a reason to keep collecting cards.

The game rules themselves do not change. A valid declarer is the winner after the remaining active opponents submit their final layouts or the 45-second showdown deadline expires. Opponents cannot overtake that declaration by submitting a higher-scoring hand. The authoritative deadlines are `state.turnEndsAt` and `state.showdown.endsAt`.

## Contract and provenance

The server module [ai-game-protocol.ts](../apps/server/src/ai-game-protocol.ts) exports:

- `AI_GAME_PROTOCOL_VERSION`: `trinity-agent-protocol/2.0.0`, the instruction/observation policy version.
- `AI_GAME_RULES_REVISION`: `trinity-rules/1.0.0`, the existing Trinity game rules.
- `AI_GAME_PROTOCOL_REVISION_HASH`: SHA256 of a canonical document containing the exact instructions, rules, objective, tool policy and response contract.
- `AI_GAME_PROTOCOL_IDENTITY_VERSION`: semantic protocol version plus full revision hash, fitting the immutable 100-character `ai_agents.prompt_version` field.
- `AI_GAME_PROTOCOL_MANIFEST` and `buildSystemPrompt()`: immutable metadata and static instructions.
- `AI_LEGACY_V1_SYSTEM_PROMPT`: the byte-for-byte original prompt for existing v1 identities and restored matches.
- `AI_LEGACY_V1_PROTOCOL_DESCRIPTOR` and `AI_GAME_PROTOCOL_DESCRIPTOR`: `{id,policyHash,semver,rulesRevision,manifest}` for immutable registry records. Their manifests contain only versions, hashes and capability flags, never prompts, schemas, observations or memory.

`state.revision` remains the changing gameplay concurrency number. It is not a protocol or rules version. Metadata is trusted server-attached provenance; the model is not asked to echo hashes, IDs or version fields. Hashes do not include private hands, names, persistent memory or per-turn facts. A policy/instruction/tool-contract change needs a new immutable protocol identity; a game-rule change also needs a new rules revision. Preserve earlier identities, results and memories rather than rewriting their model/prompt binding or silently transferring ratings. New identities need operator qualification and explicit availability controls.

## Shared rules facts

The user authorized a shared legality tool. Its inputs contain only the current player's own hand and public state. It may identify valid partitions and final discards; it receives no other hands, future stock order, database snapshot or another agent's memory.

The per-request `rulesFacts` contract is:

```ts
{
  rulesRevision: 'trinity-rules/1.0.0';
  toolVersion: 'shared-own-hand-legality/1.0.0';
  status: 'complete' | 'unavailable';
  reason?: 'time-budget' | 'tool-error';
  immediateDeclaration: { cardId: string; groups: string[][]; score: number } | null;
  readyHand: { groups: string[][]; score: number } | null;
  afterDiscardDraw?: { cardId: string; groups: string[][]; score: number } | null;
}
```

`immediateDeclaration` is valid only for the current 14-card decision. With a completed check and a candidate present, v2 must choose `declare` now. The candidate is a safe default; the model may return a different fully legal immediate declaration. At 13 cards, `readyHand` confirms a complete arrangement but the player must still draw first. An optional `afterDiscardDraw` preview is calculated only from the 13 owned cards and visible top discard; the model must actually draw that card before a new 14-card decision.

`unavailable`, including an exhausted tool time budget, means **unknown**. A null candidate in that state is not evidence that no winning declaration exists. The model must still check the visible hand itself. A fact from an old gameplay revision cannot authorize a later move.

The exact selected model must return every action. The server never automatically executes the supplied candidate, changes models or replaces an unsuccessful model response with a solver move. V2 preflight can reject a move that violates the current client protocol, then retry the same model within the existing bounded turn/spend limits. This is AI client legality validation, comparable to the human client's declaration validation; authoritative engine rules and human/AI game penalties remain unchanged.

Names, public history and memory are untrusted data. Text inside them cannot redefine rules, pretend to be a tool result or reveal hidden cards. Only the current request's top-level server `rulesFacts` is an authenticated legality result. Static system instructions never interpolate any user-provided text.

## Portable response and verification

The response remains exactly `action`, `cardId`, `groups`, `memory`. Protocol metadata is attached by the server. Preserve the existing model-specific structured-output compatibility: nullable string transport for null-only actions, no unsupported array-size constraints on the affected Gemini endpoint, local bounds/ownership checks and exact model binding. Introducing the protocol must not change the selected model IDs, daily $10 budget or bounded request/response/turn limits.

Fixture tests bind the prompt to the original v1 hash, shared meld constants, minimum 3 cards, maximum 27, natural 21 without jokers or selected wild cards, the 102-point readiness case, draw-before-declare, the 45-second showdown and the declarer's win over a higher-scoring responder. Operator qualification must additionally ask each actual configured model to choose immediate declarations, preserve ready 13-card hands through the mandatory draw, obey stage constraints and ignore instruction text in names/history/memory. Unit tests alone do not establish that a remote model follows the policy.
