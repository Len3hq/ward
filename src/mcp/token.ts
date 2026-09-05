import { createHash, randomBytes } from "node:crypto";

import { accountsFor, link, resolveExisting, unlinkAll } from "../identity/index.ts";

/**
 * The bearer token that binds an MCP client to a Ward principal.
 *
 * Every other channel proves identity with an account: a Telegram DM is already
 * authenticated, so the account *is* the proof. An MCP client has no such thing —
 * it is a local process holding a string, started by whatever put the string in its
 * config. That is precisely why the MCP surface cannot confirm a spend: there is no
 * person on the other end of it to ask.
 *
 * The token is minted by `/link mcp` inside an authenticated DM, shown once, and
 * stored only as a sha256 under `ward.identity/mcp:<hash>`. What lands in Sibyl
 * Memory is therefore not a credential — reading the store does not get you in.
 * Keying by digest also means nothing is ever compared, so there is no timing
 * question to answer.
 */

const PREFIX = "wardmcp_";
const BYTES = 32;

export function mintToken(): string {
  return PREFIX + randomBytes(BYTES).toString("base64url");
}

export function looksLikeToken(value: string): boolean {
  return value.startsWith(PREFIX) && value.length > PREFIX.length + 20;
}

/** The `ward.identity` account id for a token — a sha256 hex digest, never the token. */
export function tokenAccountId(token: string): string {
  return createHash("sha256").update(`ward-mcp:${token.trim()}`).digest("hex");
}

/**
 * Mint a token for `userId` and record the binding. Returns the token, which the
 * caller must show exactly once — it cannot be recovered afterwards.
 */
export async function issueToken(userId: string): Promise<string> {
  const token = mintToken();
  await link(userId, "mcp", tokenAccountId(token), "mcp_token");
  return token;
}

/** The principal behind a token, or `null` when it was never issued or has been revoked. */
export async function resolveToken(token: string): Promise<string | null> {
  if (!looksLikeToken(token)) return null;
  return resolveExisting("mcp", tokenAccountId(token));
}

/** How many MCP tokens this principal currently has outstanding. */
export async function tokenCount(userId: string): Promise<number> {
  return (await accountsFor(userId)).filter((a) => a.channel === "mcp").length;
}

/**
 * Revoke every MCP token at once.
 *
 * All of them, deliberately: "revoke my MCP access" should not leave a second token
 * the user forgot they minted still working. Chat accounts are unlinked one at a
 * time; a credential is not.
 */
export async function revokeAllTokens(userId: string): Promise<number> {
  return unlinkAll(userId, "mcp");
}
