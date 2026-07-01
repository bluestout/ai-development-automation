# Debian (not Alpine) so git + npx-spawned MCP servers run without musl issues.
FROM node:20-bookworm-slim

# git: clone/fetch client repos + worktrees. ca-certificates: HTTPS to GitHub.
# gosu: drop from root to the `node` user in the entrypoint (proper signal handling).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Railway mounts the volume at /data; clones live under /data/repos.
ENV VOLUME_DIR=/data/repos

# The Claude Agent SDK refuses to run as root (--dangerously-skip-permissions is
# blocked for root/sudo), so the app must run as the non-root `node` user. But the
# Railway volume is mounted at /data at RUNTIME (owned by root), so a build-time
# chown wouldn't stick. The entrypoint runs as root, fixes /data ownership after
# the mount exists, then drops to `node` (via gosu) to start the app.
RUN chown -R node:node /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
