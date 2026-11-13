import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { AI_VALIDATION_IDENTITY_VERSION } from "./ai-game-protocol-v3";

const boundedVersion = z.string().min(1).max(100);
export const aiPracticeBindingSchema = z.object({
  agentId: z.string().uuid(), modelId: z.string().min(3).max(200), protocolId: boundedVersion,
  curriculumId: boundedVersion, curriculumHash: z.string().regex(/^[0-9a-f]{64}$/), rulesRevision: boundedVersion
}).strict();
export type AiPracticeBinding = z.infer<typeof aiPracticeBindingSchema>;

const summaryNumber = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
export const aiPracticeMetricsSchema = z.object({
  requestedRounds: summaryNumber, completedRounds: summaryNumber, trainingEpisodes: summaryNumber,
  evaluationEpisodes: summaryNumber, completedEpisodes: summaryNumber, requests: summaryNumber,
  retries: summaryNumber, validDeclarations: summaryNumber, invalidActions: summaryNumber,
  providerErrors: summaryNumber, winningDecisionsMissed: summaryNumber, knownCostUsd: summaryNumber,
  unknownCostRequests: summaryNumber, maxLatencyMs: summaryNumber, maxTurnDurationMs: summaryNumber
}).strict();
export type AiPracticeMetrics = z.infer<typeof aiPracticeMetricsSchema>;
export const aiPracticeCompletionSchema = z.object({
  runId: z.string().uuid(), notes: z.string().max(512), metrics: aiPracticeMetricsSchema, promote: z.boolean()
}).strict();
export type AiPracticeRunInput = z.infer<typeof aiPracticeCompletionSchema>;
export type AiPracticePromotionReason = "promotion-disabled" | "no-notes" | "not-current-protocol" | "active-match" | "live-memory-changed";
export type AiPracticeRunResult = { notesPromoted: boolean; reason?: AiPracticePromotionReason };
export interface AiPracticeStore {
  beginRun(binding: AiPracticeBinding): Promise<{ runId: string; practiceMemory: string; liveMemory: string }>;
  completeRun(input: AiPracticeRunInput): Promise<AiPracticeRunResult>;
  failRun(runId: string): Promise<void>;
}

type LockedAgent = { model_id: string; prompt_version: string; memory: string };
type PracticeRun = {
  id: string; agent_id: string; model_id: string; protocol_id: string; curriculum_id: string;
  curriculum_hash: string; rules_revision: string; baseline_live_memory: string; baseline_practice_revision: string;
  status: "running" | "completed" | "failed" | "expired"; notes: string | null; metrics: AiPracticeMetrics | null;
  promotion_requested: boolean; notes_promoted: boolean; promotion_reason: AiPracticePromotionReason | null;
};

/** Private, leased practice records. Only model-produced notes may be supplied. */
export class PostgresAiPracticeStore implements AiPracticeStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async lockAgent(client: PoolClient, agentId: string): Promise<LockedAgent | undefined> {
    // The user lock also serializes participant FK insertion with promotion, so
    // a concurrently starting match cannot cross the idle check unnoticed.
    return (await client.query<LockedAgent>(
      `SELECT a.model_id,a.prompt_version,a.memory FROM ai_agents a JOIN app_users u ON u.id=a.user_id
       WHERE a.user_id=$1 FOR UPDATE OF a,u`, [agentId]
    )).rows[0];
  }

  async beginRun(input: AiPracticeBinding): Promise<{ runId: string; practiceMemory: string; liveMemory: string }> {
    const binding = aiPracticeBindingSchema.parse(input);
    return this.transaction(async (client) => {
      const agent = await this.lockAgent(client, binding.agentId);
      if (!agent || agent.model_id !== binding.modelId || agent.prompt_version !== binding.protocolId) {
        throw new Error("AI practice requires the exact agent, model and protocol binding.");
      }
      const protocol = (await client.query<{ rules_revision: string }>("SELECT rules_revision FROM ai_protocol_revisions WHERE id=$1", [binding.protocolId])).rows[0];
      if (!protocol || protocol.rules_revision !== binding.rulesRevision) throw new Error("AI practice rules must match the registered protocol.");
      await client.query(
        `INSERT INTO ai_practice_curricula(id,curriculum_hash,protocol_id,rules_revision) VALUES($1,$2,$3,$4)
         ON CONFLICT(id) DO NOTHING`, [binding.curriculumId, binding.curriculumHash, binding.protocolId, binding.rulesRevision]
      );
      const curriculum = (await client.query<{ curriculum_hash: string; protocol_id: string; rules_revision: string }>(
        "SELECT curriculum_hash,protocol_id,rules_revision FROM ai_practice_curricula WHERE id=$1", [binding.curriculumId]
      )).rows[0];
      if (!curriculum || curriculum.curriculum_hash !== binding.curriculumHash || curriculum.protocol_id !== binding.protocolId || curriculum.rules_revision !== binding.rulesRevision) {
        throw new Error("An AI practice curriculum binding cannot be redefined.");
      }
      await client.query(
        "UPDATE ai_practice_runs SET status='expired',completed_at=clock_timestamp() WHERE agent_id=$1 AND status='running' AND expires_at<=clock_timestamp()", [binding.agentId]
      );
      if ((await client.query("SELECT 1 FROM ai_practice_runs WHERE agent_id=$1 AND status='running'", [binding.agentId])).rowCount) {
        throw new Error("This AI agent already has a running practice session.");
      }
      await client.query(
        `INSERT INTO ai_practice_memory(agent_id,model_id,protocol_id,curriculum_id,curriculum_hash,rules_revision)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(agent_id,curriculum_id) DO NOTHING`,
        [binding.agentId, binding.modelId, binding.protocolId, binding.curriculumId, binding.curriculumHash, binding.rulesRevision]
      );
      const memory = (await client.query<{ notes: string; revision: string }>(
        "SELECT notes,revision FROM ai_practice_memory WHERE agent_id=$1 AND curriculum_id=$2", [binding.agentId, binding.curriculumId]
      )).rows[0]!;
      const runId = randomUUID();
      await client.query(
        `INSERT INTO ai_practice_runs(id,agent_id,model_id,protocol_id,curriculum_id,curriculum_hash,rules_revision,baseline_live_memory,baseline_practice_revision)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [runId, binding.agentId, binding.modelId, binding.protocolId, binding.curriculumId, binding.curriculumHash, binding.rulesRevision, agent.memory, memory.revision]
      );
      return { runId, practiceMemory: memory.notes, liveMemory: agent.memory };
    });
  }

  async completeRun(input: AiPracticeRunInput): Promise<AiPracticeRunResult> {
    const completion = aiPracticeCompletionSchema.parse(input);
    const result = await this.transaction(async (client): Promise<AiPracticeRunResult | "expired"> => {
      // Always lock the agent first: begin, completion and stale recovery share
      // the same lock order and cannot deadlock each other.
      const runAgent = (await client.query<{ agent_id: string }>("SELECT agent_id FROM ai_practice_runs WHERE id=$1", [completion.runId])).rows[0];
      if (!runAgent) throw new Error("The AI practice run does not exist.");
      const agent = await this.lockAgent(client, runAgent.agent_id);
      const run = (await client.query<PracticeRun>("SELECT * FROM ai_practice_runs WHERE id=$1 FOR UPDATE", [completion.runId])).rows[0]!;
      if (run.status === "completed") {
        if (run.notes !== completion.notes || !isDeepStrictEqual(run.metrics, completion.metrics) || run.promotion_requested !== completion.promote) {
          throw new Error("The AI practice run was already completed differently.");
        }
        return { notesPromoted: run.notes_promoted, ...(run.promotion_reason ? { reason: run.promotion_reason } : {}) };
      }
      if (run.status !== "running") throw new Error("The AI practice run is no longer running.");
      if ((await client.query(
        "UPDATE ai_practice_runs SET status='expired',completed_at=clock_timestamp() WHERE id=$1 AND expires_at<=clock_timestamp() RETURNING id", [completion.runId]
      )).rowCount) return "expired";
      if (!agent || agent.model_id !== run.model_id || agent.prompt_version !== run.protocol_id) throw new Error("The AI practice agent binding no longer matches.");

      if (completion.notes.trim()) {
        const saved = await client.query(
          `UPDATE ai_practice_memory SET notes=$3,revision=revision+1,updated_at=clock_timestamp()
           WHERE agent_id=$1 AND curriculum_id=$2 AND revision=$4 RETURNING agent_id`,
          [run.agent_id, run.curriculum_id, completion.notes, run.baseline_practice_revision]
        );
        if (saved.rowCount !== 1) throw new Error("The AI practice memory changed during this session.");
      }
      let reason: AiPracticePromotionReason | undefined;
      if (!completion.promote) reason = "promotion-disabled";
      else if (!completion.notes.trim()) reason = "no-notes";
      else if (run.protocol_id !== AI_VALIDATION_IDENTITY_VERSION) reason = "not-current-protocol";
      else if ((await client.query(
        `SELECT 1 FROM match_participants p JOIN ranking_matches m ON m.id=p.match_id
         WHERE p.user_id=$1 AND m.status='active' LIMIT 1`, [run.agent_id]
      )).rowCount) reason = "active-match";
      else if (agent.memory !== run.baseline_live_memory) reason = "live-memory-changed";

      if (!reason) {
        const promoted = await client.query(
          "UPDATE ai_agents SET memory=$2,updated_at=clock_timestamp() WHERE user_id=$1 AND model_id=$3 AND prompt_version=$4 AND memory=$5 RETURNING user_id",
          [run.agent_id, completion.notes, run.model_id, AI_VALIDATION_IDENTITY_VERSION, run.baseline_live_memory]
        );
        if (promoted.rowCount !== 1) reason = "live-memory-changed";
      }
      await client.query(
        `UPDATE ai_practice_runs SET status='completed',completed_at=clock_timestamp(),notes=$2,metrics=$3,
         promotion_requested=$4,notes_promoted=$5,promotion_reason=$6 WHERE id=$1`,
        [completion.runId, completion.notes, completion.metrics, completion.promote, !reason, reason ?? null]
      );
      return { notesPromoted: !reason, ...(reason ? { reason } : {}) };
    });
    if (result === "expired") throw new Error("The AI practice session expired; start a new session.");
    return result;
  }

  async failRun(runId: string): Promise<void> {
    z.string().uuid().parse(runId);
    await this.transaction(async (client) => {
      const agent = (await client.query<{ agent_id: string }>("SELECT agent_id FROM ai_practice_runs WHERE id=$1", [runId])).rows[0];
      if (!agent) throw new Error("The AI practice run does not exist.");
      await this.lockAgent(client, agent.agent_id);
      await client.query(
        `UPDATE ai_practice_runs SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'failed' END,
         completed_at=clock_timestamp() WHERE id=$1 AND status='running'`, [runId]
      );
    });
  }
}
