import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";

import { resetBackend } from "../memory/backend.ts";
import { initialize, readOwner, writeWallet } from "../memory/index.ts";
import { clearChannels } from "../src/gateway/channels.ts";
import { resolveExisting, resolveUser } from "../src/identity/index.ts";
import { mintLinkState } from "../src/identity/linking.ts";
import {
  challenge,
  ownersFor,
  redeemWalletSignature,
  revokeOwner,
} from "../src/identity/wallet.ts";

/**
 * Phase 14. What is proved here is control of an address the USER holds — Ward's own
 * smart account is CDP-managed, so a signature from it would prove nothing about the
 * human. The value is recovery: a link code needs a chat account you still control,
 * and a wallet does not.
 *
 * Real keys and real signatures throughout; `verifyMessage` is the thing under test,
 * so stubbing it would test nothing.
 */

const ALICE = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const MALLORY = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

const TG = "700100200";
const DISCORD = "1234567890123456789";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ward-wallet-"));
  process.env.WARD_MEMORY_DIR = dir;
  process.env.SIBYL_MEMORY_MODE = "fs";
  await resetBackend();
  clearChannels();
});

afterEach(async () => {
  await resetBackend();
  clearChannels();
  delete process.env.WARD_MEMORY_DIR;
  delete process.env.SIBYL_MEMORY_MODE;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function onboarded(channel: "telegram" | "discord", accountId: string): Promise<string> {
  const { userId } = await resolveUser(channel, accountId);
  await initialize(userId, {
    risk_label: "moderate",
    per_action_limit_usd: 50,
    daily_limit_usd: 100,
  });
  return userId;
}

async function sign(
  account: typeof ALICE,
  state: string,
): Promise<{ address: string; signature: string }> {
  return {
    address: account.address,
    signature: await account.signMessage({ message: challenge(state) }),
  };
}

describe("enrollment", () => {
  test("a valid signature records the address as an owner", async () => {
    const userId = await onboarded("telegram", TG);
    const { state } = await mintLinkState(userId, "telegram", new Date(), TG);
    const { address, signature } = await sign(ALICE, state);

    const result = await redeemWalletSignature(state, address, signature);

    expect(result).toMatchObject({ ok: true, enrolled: true, userId });
    expect(await ownersFor(userId)).toEqual([ALICE.address.toLowerCase()]);
    expect((await readOwner(ALICE.address))?.ward_user_id).toBe(userId);
  });

  test("the address is stored lowercased, so casing can't create a second owner", async () => {
    const userId = await onboarded("telegram", TG);
    const { state } = await mintLinkState(userId, "telegram", new Date(), TG);
    const { signature } = await sign(ALICE, state);

    await redeemWalletSignature(state, ALICE.address, signature);

    expect(await ownersFor(userId)).toEqual([ALICE.address.toLowerCase()]);
    expect(await readOwner(ALICE.address.toUpperCase().replace("0X", "0x"))).not.toBeNull();
  });

  test("a signature over the wrong challenge is refused", async () => {
    const userId = await onboarded("telegram", TG);
    const { state } = await mintLinkState(userId, "telegram", new Date(), TG);
    const signature = await ALICE.signMessage({ message: challenge("some-other-state-entirely") });

    const result = await redeemWalletSignature(state, ALICE.address, signature);

    expect(result).toMatchObject({ ok: false });
    expect(await ownersFor(userId)).toEqual([]);
  });

  test("a signature from a different key than the address claims is refused", async () => {
    const userId = await onboarded("telegram", TG);
    const { state } = await mintLinkState(userId, "telegram", new Date(), TG);
    const signature = await MALLORY.signMessage({ message: challenge(state) });

    const result = await redeemWalletSignature(state, ALICE.address, signature);

    expect(result).toMatchObject({ ok: false });
    expect(await ownersFor(userId)).toEqual([]);
  });

  test("garbage does not throw — it is refused like anything else", async () => {
    const userId = await onboarded("telegram", TG);
    const { state } = await mintLinkState(userId, "telegram", new Date(), TG);

    expect(await redeemWalletSignature(state, "not-an-address", "0xdead")).toMatchObject({
      ok: false,
    });
  });

  test("a second, unknown wallet cannot enroll itself on a Ward that already has one", async () => {
    const userId = await onboarded("telegram", TG);
    const first = await mintLinkState(userId, "telegram", new Date(), TG);
    const a = await sign(ALICE, first.state);
    await redeemWalletSignature(first.state, a.address, a.signature);

    const second = await mintLinkState(userId, "telegram", new Date(), TG);
    const m = await sign(MALLORY, second.state);
    const result = await redeemWalletSignature(second.state, m.address, m.signature);

    expect(result).toMatchObject({ ok: false });
    expect(await ownersFor(userId)).toEqual([ALICE.address.toLowerCase()]);
  });
});

describe("recovery — the reason this phase exists", () => {
  test("a known wallet attaches a brand-new account to the principal it owns", async () => {
    const original = await onboarded("telegram", TG);
    const enroll = await mintLinkState(original, "telegram", new Date(), TG);
    const a = await sign(ALICE, enroll.state);
    await redeemWalletSignature(enroll.state, a.address, a.signature);

    // A different app, a fresh empty principal, no access to the Telegram account.
    const { userId: shell } = await resolveUser("discord", DISCORD);
    expect(shell).not.toBe(original);
    const recovery = await mintLinkState(shell, "discord", new Date(), DISCORD);
    const again = await sign(ALICE, recovery.state);

    const result = await redeemWalletSignature(recovery.state, again.address, again.signature);

    expect(result).toMatchObject({ ok: true, userId: original, enrolled: false });
    expect(await resolveExisting("discord", DISCORD)).toBe(original);
  });

  test("it will not merge two funded Wards", async () => {
    const original = await onboarded("telegram", TG);
    const enroll = await mintLinkState(original, "telegram", new Date(), TG);
    const a = await sign(ALICE, enroll.state);
    await redeemWalletSignature(enroll.state, a.address, a.signature);

    // The Discord side is a real Ward with its own record — not an empty shell.
    const other = await onboarded("discord", DISCORD);
    await writeWallet(other, {
      account_key: other,
      smart_account: `0x${"1".repeat(40)}`,
      agent_spender: `0x${"2".repeat(40)}`,
      spend_permission: null,
    });

    const recovery = await mintLinkState(other, "discord", new Date(), DISCORD);
    const again = await sign(ALICE, recovery.state);
    const result = await redeemWalletSignature(recovery.state, again.address, again.signature);

    expect(result).toMatchObject({ ok: false });
    expect(await resolveExisting("discord", DISCORD)).toBe(other);
  });
});

describe("the state behaves like a link code", () => {
  test("it works exactly once", async () => {
    const userId = await onboarded("telegram", TG);
    const { state } = await mintLinkState(userId, "telegram", new Date(), TG);
    const a = await sign(ALICE, state);

    expect((await redeemWalletSignature(state, a.address, a.signature)).ok).toBe(true);
    expect(await redeemWalletSignature(state, a.address, a.signature)).toMatchObject({ ok: false });
  });

  test("a failed signature does NOT burn it — a fumbled prompt costs nothing", async () => {
    const userId = await onboarded("telegram", TG);
    const { state } = await mintLinkState(userId, "telegram", new Date(), TG);

    const bad = await MALLORY.signMessage({ message: challenge(state) });
    expect(await redeemWalletSignature(state, ALICE.address, bad)).toMatchObject({ ok: false });

    const good = await sign(ALICE, state);
    expect((await redeemWalletSignature(state, good.address, good.signature)).ok).toBe(true);
  });

  test("it expires", async () => {
    const userId = await onboarded("telegram", TG);
    const { state } = await mintLinkState(userId, "telegram", new Date(), TG);
    const a = await sign(ALICE, state);

    const later = new Date(Date.now() + 6 * 60 * 1000);
    expect(await redeemWalletSignature(state, a.address, a.signature, later)).toMatchObject({
      ok: false,
    });
  });
});

describe("revocation", () => {
  test("a revoked wallet no longer resolves to anyone", async () => {
    const userId = await onboarded("telegram", TG);
    const { state } = await mintLinkState(userId, "telegram", new Date(), TG);
    const a = await sign(ALICE, state);
    await redeemWalletSignature(state, a.address, a.signature);

    expect(await revokeOwner(userId, ALICE.address, "telegram")).toBe(true);

    expect(await ownersFor(userId)).toEqual([]);
    expect(await readOwner(ALICE.address)).toBeNull();
  });

  test("revoking a wallet leaves the authorization record alone", async () => {
    const userId = await onboarded("telegram", TG);
    const { state } = await mintLinkState(userId, "telegram", new Date(), TG);
    const a = await sign(ALICE, state);
    await redeemWalletSignature(state, a.address, a.signature);

    await revokeOwner(userId, ALICE.address, "telegram");

    const { read } = await import("../memory/index.ts");
    expect((await read(userId))?.standing_caps.daily_limit_usd).toBe(100);
  });

  test("revoking one that was never verified reports so rather than pretending", async () => {
    const userId = await onboarded("telegram", TG);
    expect(await revokeOwner(userId, MALLORY.address, "telegram")).toBe(false);
  });
});
