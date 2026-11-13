import corePersistence from "../../migrations/0001_core_persistence.sql";
import postGameChat from "../../migrations/0002_post_game_chat.sql";
import privateMatches from "../../migrations/0003_private_matches.sql";
import distributedGameRuntime from "../../migrations/0004_distributed_game_runtime.sql";
import matchmakingTicketLiveness from "../../migrations/0005_matchmaking_ticket_liveness.sql";
import replayExports from "../../migrations/0006_replay_exports.sql";
import adminPasskeys from "../../migrations/0007_admin_passkeys.sql";
import modelBoundAiPlayers from "../../migrations/0008_model_bound_ai_players.sql";
import liveBroadcasts from "../../migrations/0009_live_broadcasts.sql";
import aiProtocolProvenance from "../../migrations/0010_ai_protocol_provenance.sql";
import type { SqlMigration } from "./migrate";

export const sqlMigrations: readonly SqlMigration[] = [
  { name: "0001_core_persistence.sql", sql: corePersistence },
  { name: "0002_post_game_chat.sql", sql: postGameChat },
  { name: "0003_private_matches.sql", sql: privateMatches },
  { name: "0004_distributed_game_runtime.sql", sql: distributedGameRuntime },
  { name: "0005_matchmaking_ticket_liveness.sql", sql: matchmakingTicketLiveness },
  { name: "0006_replay_exports.sql", sql: replayExports },
  { name: "0007_admin_passkeys.sql", sql: adminPasskeys },
  { name: "0008_model_bound_ai_players.sql", sql: modelBoundAiPlayers },
  { name: "0009_live_broadcasts.sql", sql: liveBroadcasts },
  { name: "0010_ai_protocol_provenance.sql", sql: aiProtocolProvenance }
];
