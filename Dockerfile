# Ward — Bun app + the Python process Sibyl Memory actually is.
#
# The awkward part of deploying this: `sibyl-memory-mcp` is not a JS dependency. It
# is a pip package (`sibyl-memory-cli[mcp]`) that `memory/backends/sibyl-mcp.ts`
# spawns over stdio, so a plain Bun image cannot run the judged memory path at all —
# every read would fail with "Could not start the Sibyl Memory MCP server".
#
# Hence one image with both runtimes. Sibyl's SQLite database lives on a Railway
# volume (`SIBYL_MEMORY_DB=/data/memory.db`), because a container filesystem is
# ephemeral and the authorization record is the whole point of the project — losing
# it on every redeploy would quietly make the deletion gate meaningless.

FROM oven/bun:1-debian

# Python, only for Sibyl Memory. A venv rather than a system pip install, so
# Debian's PEP 668 "externally managed environment" guard stays intact.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/sibyl
RUN python3 -m venv "$VIRTUAL_ENV"
# On PATH so the backend's default command name (`sibyl-memory-mcp`) resolves. It
# forwards only PATH and HOME to the child process, so this has to be the real PATH.
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
RUN pip install --no-cache-dir 'sibyl-memory-cli[mcp]'

WORKDIR /app

# Dependencies first, so a code-only change doesn't reinstall them.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Defaults; Railway variables override anything set here.
ENV NODE_ENV=production \
  SIBYL_MEMORY_MODE=sibyl-mcp \
  SIBYL_MEMORY_DB=/data/memory.db

# Ward is a long-polling worker (Telegram) plus a Discord gateway socket. It serves
# HTTP only when Discord one-click linking is configured (Phase 15.2:
# DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET + WARD_PUBLIC_URL), and then only the
# OAuth2 callback — no API. Railway injects PORT and routes to it; nothing is
# EXPOSEd here because the port is not fixed and the server is optional.
CMD ["bun", "run", "src/index.ts"]
