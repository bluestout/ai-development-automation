#!/bin/sh
# Runs as root at container start. The Railway volume is mounted at /data only at
# runtime (owned by root), so we fix its ownership here — after the mount exists —
# then drop to the non-root `node` user to run the app. The Claude Agent SDK
# refuses to run as root, so this drop is required, not optional.
set -e

mkdir -p /data
chown -R node:node /data

# Drop to the non-root `node` user and exec the given command (CMD) as-is.
# gosu preserves argv and forwards signals correctly (unlike `su -c`).
exec gosu node "$@"
