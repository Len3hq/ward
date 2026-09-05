# The ACP counterparty — the seller side of the trust loop.
#
# A separate agent with its own Virtuals registration and its own wallet, deployed
# as its own Railway service. It shares no state with Ward: no Sibyl Memory, no
# Python layer, no volume. It listens for ACP jobs, scores a token, and submits.
#
# Run by the same team as Ward, which `ACP.md` requires be disclosed rather than
# presented as an independent third party.

FROM oven/bun:1-debian

WORKDIR /app

# No bun.lock here (this subproject was installed with npm), so a plain install —
# not --frozen-lockfile, which would fail without one.
COPY package.json ./
RUN bun install --production

COPY . .

ENV NODE_ENV=production

# Long-running listener on the ACP job stream. No HTTP port.
CMD ["bun", "run", "index.ts"]
