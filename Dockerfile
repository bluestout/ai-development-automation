# Debian (not Alpine) so git + npx-spawned MCP servers run without musl issues.
FROM node:20-bookworm-slim

# git: clone/fetch client repos + worktrees. ca-certificates: HTTPS to GitHub.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Railway mounts the volume at /data; clones live under /data/repos.
ENV VOLUME_DIR=/data/repos

EXPOSE 3000
CMD ["node", "src/server.js"]
