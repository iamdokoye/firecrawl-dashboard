#!/bin/sh
set -e

# Ensure /app/data is writable by the node user.
# When Docker creates a bind-mount directory on the host it is owned by root,
# which causes EACCES for the node user. This entrypoint runs as root, so we
# unconditionally chown rather than testing writability first — `[ -w ... ]`
# run as root bypasses normal permission checks and reports writable even
# when the unprivileged node user has no access, which silently skipped this
# fix and caused better-sqlite3 to fail with SQLITE_CANTOPEN. Then we drop to
# the node user via su-exec before exec-ing the application so PID 1 is the
# Node process (proper signal handling).
chown -R node:node /app/data

exec su-exec node "$@"
