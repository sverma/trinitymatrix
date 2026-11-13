import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { aiProtocolRevisionSchema, aiRequestCompletionSchema, aiRequestContextSchema,
  type AiProtocolRevision, type AiRequestCompletion, type AiRequestContext } from "./ai-protocol-provenance";
import { AI_GAME_PROTOCOL_DESCRIPTOR, AI_GAME_PROTOCOL_IDENTITY_VERSION, AI_LEGACY_V1_PROTOCOL_DESCRIPTOR } from "./ai-game-protocol";
export type { AiProtocolRevision, AiRequestCompletion, AiRequestContext } from "./ai-protocol-provenance";

export const AI_PROMPT_VERSION = "trinity-v1";
export const AI_CURRENT_IDENTITY_VERSION = AI_GAME_PROTOCOL_IDENTITY_VERSION;
export const AI_REQUEST_RESERVATION_USD = 0.05;
export const INITIAL_AI_ROSTER = [
  { modelId: "anthropic/claude-haiku-5.5", modelName: "Claude Haiku 5.5", displayName: "Haiku AI" },
  { modelId: "google/gemini-3.8-flash", modelName: "Gemini 3.8 Flash", displayName: "Gemini AI" },
  { modelId: "deepseek/deepseek-v3.2", modelName: "DeepSeek V3.2", displayName: "DeepSeek AI" },
  { modelId: "qwen/qwen3.8-flash", modelName: "Qwen3.8 Flash", displayName: "Qwen AI" },
  { modelId: "mistralai/mistral-small-2603", modelName: "Mistral Small 4", displayName: "Mistral AI" },
  { modelId: "openai/gpt-6-luna", modelName: "GPT-6 Luna", displayName: "Luna AI" },
  { modelId: "meta-llama/llama-4-maverick", modelName: "Llama 4 Maverick", displayName: "Llama AI" },
  { modelId: "deepseek/deepseek-v4.1-flash", modelName: "DeepSeek V4.1 Flash", displayName: "DeepSeek Flash AI" }
] as const;

export type AiIdentity = {
  id: string; displayName: string; modelId: string; modelName: string; memory: string; enabled: boolean;
  rating: number; gamesPlayed: number; wins: number;
  protocolId?: string; identityVersion?: string; selectable?: boolean;
};
export interface AiStore {
  listAgents(): Promise<AiIdentity[]>;
  reserveRequest(userId: string, modelId: string, dailyBudgetUsd: number, context?: AiRequestContext): Promise<string | null>;
  finishRequest(id: string, actualUsd: number | null, success: boolean, context?: AiRequestCompletion): Promise<void>;
  recordRequestOutcome?(id: string, context: AiRequestCompletion): Promise<void>;
  registerProtocol?(revision: AiProtocolRevision): Promise<void>;
  budgetAvailable(dailyBudgetUsd: number): Promise<boolean>;
  saveMemory(userId: string, memory: string): Promise<void>;
}

export function aiIdentityId(modelId: string, identityVersion = AI_PROMPT_VERSION): string {
  const bytes = createHash("sha256").update(`trinitymatrix:ai:${identityVersion}:${modelId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Durable identity and conservative, globally serialized UTC-day spend ledger. */
export class PostgresAiStore implements AiStore {
  constructor(private readonly pool: Pool) {}

  async registerProtocol(input: AiProtocolRevision): Promise<void> {
    const revision = aiProtocolRevisionSchema.parse(input);
    await this.pool.query(
      `INSERT INTO ai_protocol_revisions(id,policy_hash,semver,rules_revision,manifest) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(id) DO NOTHING`, [revision.id, revision.policyHash, revision.semver, revision.rulesRevision, revision.manifest]
    );
    const stored = (await this.pool.query<{ policy_hash: string; semver: string; rules_revision: string; manifest: unknown }>(
      "SELECT policy_hash,semver,rules_revision,manifest FROM ai_protocol_revisions WHERE id=$1", [revision.id]
    )).rows[0];
    if (!stored || stored.policy_hash !== revision.policyHash || stored.semver !== revision.semver
      || stored.rules_revision !== revision.rulesRevision || !isDeepStrictEqual(stored.manifest, revision.manifest)) {
      throw new Error("An AI protocol revision cannot be redefined.");
    }
  }

  async provision(): Promise<void> {
    await this.registerProtocol(AI_LEGACY_V1_PROTOCOL_DESCRIPTOR);
    await this.registerProtocol(AI_GAME_PROTOCOL_DESCRIPTOR);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const agent of INITIAL_AI_ROSTER) {
        const id = aiIdentityId(agent.modelId, AI_CURRENT_IDENTITY_VERSION);
        await client.query(
          `INSERT INTO app_users (id, email, actor_kind) VALUES ($1, $2, 'ai') ON CONFLICT (id) DO NOTHING`,
          [id, `agent-${id}@ai.trinitymatrix.invalid`]
        );
        await client.query(
          `INSERT INTO player_profiles (user_id, display_name, badge_id) VALUES ($1, $2, 'strategist') ON CONFLICT (user_id) DO NOTHING`,
          [id, `${agent.displayName} · v2`]
        );
        await client.query(
          `INSERT INTO ai_agents (user_id,model_id,model_name,prompt_version,enabled)
           VALUES ($1,$2,$3,$4,COALESCE((SELECT a.enabled AND u.suspended_at IS NULL FROM ai_agents a JOIN app_users u ON u.id=a.user_id
             WHERE a.model_id=$2 ORDER BY a.created_at DESC,a.user_id DESC LIMIT 1),true))
           ON CONFLICT (user_id) DO NOTHING`,
          [id, agent.modelId, agent.modelName, AI_CURRENT_IDENTITY_VERSION]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async listAgents(): Promise<AiIdentity[]> {
    const result = await this.pool.query<{
      user_id: string; display_name: string; model_id: string; model_name: string; memory: string; enabled: boolean;
      rating: number; games_played: number; wins: number;
      identity_version: string; selectable: boolean;
    }>(`SELECT a.user_id, p.display_name, a.model_id, a.model_name, a.memory,
        (a.enabled AND u.suspended_at IS NULL) AS enabled,
        COALESCE(r.rating,1000)::integer AS rating, COALESCE(r.games_played,0)::integer AS games_played,
        COALESCE(r.wins,0)::integer AS wins,
        a.prompt_version AS identity_version,(a.prompt_version=$1 AND a.model_id=ANY($2::text[])) AS selectable
      FROM ai_agents a JOIN player_profiles p ON p.user_id=a.user_id JOIN app_users u ON u.id=a.user_id
      LEFT JOIN player_rankings_by_composition r ON r.user_id=a.user_id AND r.composition='mixed'
      WHERE (a.prompt_version=$1 AND a.model_id=ANY($2::text[]))
        OR (a.prompt_version=$3 AND EXISTS (SELECT 1 FROM match_participants mp JOIN ranking_matches m ON m.id=mp.match_id
          WHERE mp.user_id=a.user_id AND m.status='active'))
      ORDER BY p.display_name,a.user_id`,
    [AI_CURRENT_IDENTITY_VERSION, INITIAL_AI_ROSTER.map(({ modelId }) => modelId), AI_PROMPT_VERSION]);
    return result.rows.map((r) => ({ id: r.user_id, displayName: r.display_name, modelId: r.model_id,
      modelName: r.model_name, memory: r.memory, enabled: r.enabled, rating: r.rating, gamesPlayed: r.games_played, wins: r.wins,
      protocolId: r.identity_version, identityVersion: r.identity_version, selectable: r.selectable }));
  }

  async budgetAvailable(dailyBudgetUsd: number): Promise<boolean> {
    const result = await this.pool.query<{ spent: string }>(
      `SELECT COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0)::text AS spent FROM ai_model_requests
       WHERE budget_day=(statement_timestamp() AT TIME ZONE 'UTC')::date`
    );
    return Number(result.rows[0]?.spent ?? dailyBudgetUsd) + AI_REQUEST_RESERVATION_USD <= dailyBudgetUsd + 1e-8;
  }

  async reserveRequest(userId: string, modelId: string, dailyBudgetUsd: number, context?: AiRequestContext): Promise<string | null> {
    const audit = aiRequestContextSchema.parse(context ?? {});
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One transaction-wide lock for all agents and server processes; no oversubscription race.
      await client.query("SELECT pg_advisory_xact_lock(674132989104::bigint)");
      const result = await client.query<{ id: string }>(
        `INSERT INTO ai_model_requests (id,user_id,model_id,budget_day,reserved_usd,protocol_id,match_id,game_revision,tools_version,declaration_available,server_revision)
         SELECT $1,$2,$3,(statement_timestamp() AT TIME ZONE 'UTC')::date,$4,$6,$7,$8,$9,$10,$11
         WHERE EXISTS (SELECT 1 FROM ai_agents a JOIN app_users u ON u.id=a.user_id
                       WHERE a.user_id=$2 AND a.model_id=$3 AND a.enabled AND u.suspended_at IS NULL
                         AND ($6::text IS NULL OR a.prompt_version=$6))
         AND (SELECT COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0) FROM ai_model_requests
              WHERE budget_day=(statement_timestamp() AT TIME ZONE 'UTC')::date)+$4 <= $5
         RETURNING id`, [randomUUID(), userId, modelId, AI_REQUEST_RESERVATION_USD, dailyBudgetUsd,
          audit.protocolId ?? null, audit.matchId ?? null, audit.gameRevision ?? null, audit.toolsVersion ?? null, audit.declarationAvailable ?? null, audit.serverRevision ?? null]
      );
      await client.query("COMMIT");
      return result.rows[0]?.id ?? null;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async finishRequest(id: string, actualUsd: number | null, success: boolean, context?: AiRequestCompletion): Promise<void> {
    if (actualUsd !== null && (!Number.isFinite(actualUsd) || actualUsd < 0)) throw new Error("Invalid model usage cost.");
    const audit = aiRequestCompletionSchema.parse(context ?? {});
    // Unknown cost is charged at its reservation, including failed/aborted requests.
    await this.pool.query(
      `UPDATE ai_model_requests SET actual_usd=$2, status=$3, completed_at=clock_timestamp(),action=COALESCE(action,$4),outcome=COALESCE(outcome,$5)
       WHERE id=$1 AND status='reserved'`, [id, actualUsd === null ? null : Math.ceil(actualUsd * 1e6) / 1e6, success ? "completed" : "failed",
        audit.action ?? null, audit.outcome ?? null]
    );
  }

  async recordRequestOutcome(id: string, context: AiRequestCompletion): Promise<void> {
    const audit = aiRequestCompletionSchema.parse(context);
    if (audit.action === undefined && audit.outcome === undefined) return;
    const result = await this.pool.query(
      `UPDATE ai_model_requests SET action=COALESCE(action,$2),outcome=COALESCE(outcome,$3)
       WHERE id=$1 AND ($2::text IS NULL OR action IS NULL OR action=$2)
         AND ($3::text IS NULL OR outcome IS NULL OR outcome=$3) RETURNING id`, [id, audit.action ?? null, audit.outcome ?? null]
    );
    if (result.rowCount !== 1) throw new Error("The AI request outcome is missing or already recorded differently.");
  }

  async saveMemory(userId: string, memory: string): Promise<void> {
    if (memory.length > 4000) throw new Error("Agent memory is too long.");
    await this.pool.query("UPDATE ai_agents SET memory=$2, updated_at=clock_timestamp() WHERE user_id=$1", [userId, memory]);
  }
}
