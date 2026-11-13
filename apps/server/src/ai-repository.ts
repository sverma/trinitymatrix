import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export const AI_PROMPT_VERSION = "trinity-v1";
export const AI_REQUEST_RESERVATION_USD = 0.05;
export const INITIAL_AI_ROSTER = [
  { modelId: "anthropic/claude-haiku-5.5", modelName: "Claude Haiku 5.5", displayName: "Haiku AI" },
  { modelId: "google/gemini-3.8-flash", modelName: "Gemini 3.8 Flash", displayName: "Gemini AI" },
  { modelId: "deepseek/deepseek-v3.2", modelName: "DeepSeek V3.2", displayName: "DeepSeek AI" },
  { modelId: "qwen/qwen3.8-flash", modelName: "Qwen3.8 Flash", displayName: "Qwen AI" },
  { modelId: "mistralai/mistral-small-2603", modelName: "Mistral Small 4", displayName: "Mistral AI" }
] as const;

export type AiIdentity = {
  id: string; displayName: string; modelId: string; modelName: string; memory: string; enabled: boolean;
  rating: number; gamesPlayed: number; wins: number;
};
export interface AiStore {
  listAgents(): Promise<AiIdentity[]>;
  reserveRequest(userId: string, modelId: string, dailyBudgetUsd: number): Promise<string | null>;
  finishRequest(id: string, actualUsd: number | null, success: boolean): Promise<void>;
  budgetAvailable(dailyBudgetUsd: number): Promise<boolean>;
  saveMemory(userId: string, memory: string): Promise<void>;
}

export function aiIdentityId(modelId: string): string {
  const bytes = createHash("sha256").update(`trinitymatrix:ai:${AI_PROMPT_VERSION}:${modelId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Durable identity and conservative, globally serialized UTC-day spend ledger. */
export class PostgresAiStore implements AiStore {
  constructor(private readonly pool: Pool) {}

  async provision(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const agent of INITIAL_AI_ROSTER) {
        const id = aiIdentityId(agent.modelId);
        await client.query(
          `INSERT INTO app_users (id, email, actor_kind) VALUES ($1, $2, 'ai') ON CONFLICT (id) DO NOTHING`,
          [id, `agent-${id}@ai.trinitymatrix.invalid`]
        );
        await client.query(
          `INSERT INTO player_profiles (user_id, display_name, badge_id) VALUES ($1, $2, 'strategist') ON CONFLICT (user_id) DO NOTHING`,
          [id, agent.displayName]
        );
        await client.query(
          `INSERT INTO ai_agents (user_id, model_id, model_name, prompt_version) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING`,
          [id, agent.modelId, agent.modelName, AI_PROMPT_VERSION]
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
    }>(`SELECT a.user_id, p.display_name, a.model_id, a.model_name, a.memory,
        (a.enabled AND u.suspended_at IS NULL) AS enabled,
        COALESCE(r.rating,1000)::integer AS rating, COALESCE(r.games_played,0)::integer AS games_played,
        COALESCE(r.wins,0)::integer AS wins
      FROM ai_agents a JOIN player_profiles p ON p.user_id=a.user_id JOIN app_users u ON u.id=a.user_id
      LEFT JOIN player_rankings_by_composition r ON r.user_id=a.user_id AND r.composition='mixed'
      WHERE a.prompt_version=$1 AND a.model_id=ANY($2::text[]) ORDER BY p.display_name, a.user_id`,
    [AI_PROMPT_VERSION, INITIAL_AI_ROSTER.map(({ modelId }) => modelId)]);
    return result.rows.map((r) => ({ id: r.user_id, displayName: r.display_name, modelId: r.model_id,
      modelName: r.model_name, memory: r.memory, enabled: r.enabled, rating: r.rating, gamesPlayed: r.games_played, wins: r.wins }));
  }

  async budgetAvailable(dailyBudgetUsd: number): Promise<boolean> {
    const result = await this.pool.query<{ spent: string }>(
      `SELECT COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0)::text AS spent FROM ai_model_requests
       WHERE budget_day=(statement_timestamp() AT TIME ZONE 'UTC')::date`
    );
    return Number(result.rows[0]?.spent ?? dailyBudgetUsd) + AI_REQUEST_RESERVATION_USD <= dailyBudgetUsd + 1e-8;
  }

  async reserveRequest(userId: string, modelId: string, dailyBudgetUsd: number): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One transaction-wide lock for all agents and server processes; no oversubscription race.
      await client.query("SELECT pg_advisory_xact_lock(674132989104::bigint)");
      const result = await client.query<{ id: string }>(
        `INSERT INTO ai_model_requests (id,user_id,model_id,budget_day,reserved_usd)
         SELECT $1,$2,$3,(statement_timestamp() AT TIME ZONE 'UTC')::date,$4
         WHERE EXISTS (SELECT 1 FROM ai_agents a JOIN app_users u ON u.id=a.user_id
                       WHERE a.user_id=$2 AND a.model_id=$3 AND a.enabled AND u.suspended_at IS NULL)
         AND (SELECT COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0) FROM ai_model_requests
              WHERE budget_day=(statement_timestamp() AT TIME ZONE 'UTC')::date)+$4 <= $5
         RETURNING id`, [randomUUID(), userId, modelId, AI_REQUEST_RESERVATION_USD, dailyBudgetUsd]
      );
      await client.query("COMMIT");
      return result.rows[0]?.id ?? null;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async finishRequest(id: string, actualUsd: number | null, success: boolean): Promise<void> {
    if (actualUsd !== null && (!Number.isFinite(actualUsd) || actualUsd < 0)) throw new Error("Invalid model usage cost.");
    // Unknown cost is charged at its reservation, including failed/aborted requests.
    await this.pool.query(
      `UPDATE ai_model_requests SET actual_usd=$2, status=$3, completed_at=clock_timestamp()
       WHERE id=$1 AND status='reserved'`, [id, actualUsd === null ? null : Math.ceil(actualUsd * 1e6) / 1e6, success ? "completed" : "failed"]
    );
  }

  async saveMemory(userId: string, memory: string): Promise<void> {
    if (memory.length > 4000) throw new Error("Agent memory is too long.");
    await this.pool.query("UPDATE ai_agents SET memory=$2, updated_at=clock_timestamp() WHERE user_id=$1", [userId, memory]);
  }
}
