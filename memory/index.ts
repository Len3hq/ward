/**
 * Sibyl Memory — public surface.
 *
 * The agent, the router, and the execution gate import from here. See
 * `memory/README.md` for the field → function map and `SIBYL-MEMORY.md` for
 * backend setup.
 */

export * from "./schema.ts";
export { computeTrustScore, NEUTRAL_PRIOR, ALPHA } from "./trust.ts";
export {
  backend,
  resetBackend,
  resolveMode,
  type MemoryBackend,
  type MemoryMode,
} from "./backend.ts";
export {
  read,
  initialize,
  appendSpend,
  appendRevocation,
  isRevoked,
  appendAcpJob,
  appendX402,
  trustScore,
  endpointTrust,
  spentToday,
  readWallet,
  writeWallet,
  readConversation,
  writeConversation,
  type ConversationMemory,
} from "./store.ts";
