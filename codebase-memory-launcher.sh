#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_ROOT=${RAMCP_CODEBASE_RUNTIME:-/var/lib/remote-access-mcp/codebase-memory}
HOME_DIR=${RAMCP_CODEBASE_HOME:-$RUNTIME_ROOT/home}
CACHE_DIR=${RAMCP_CODEBASE_CACHE:-$RUNTIME_ROOT/cache}
DATA_DIR=${RAMCP_CODEBASE_DATA:-$RUNTIME_ROOT/data}
ROOT_DIR=${RAMCP_CODEBASE_ROOT:-/home/ali/remote-access-mcp}
RUNTIME_DIR=${CBM_RUNTIME_DIR:-$RUNTIME_ROOT/runtime}
mkdir -p "$RUNTIME_DIR"
chown remote-access-mcp:remote-access-mcp "$RUNTIME_DIR" 2>/dev/null || true
exec /usr/sbin/runuser -u remote-access-mcp -- env \
    HOME="$HOME_DIR" \
    XDG_CACHE_HOME="$CACHE_DIR" \
    XDG_DATA_HOME="$DATA_DIR" \
    CBM_CACHE_DIR="$CACHE_DIR" \
    CBM_RUNTIME_DIR="$RUNTIME_DIR" \
    CBM_ALLOWED_ROOT="$ROOT_DIR" \
    RAMCP_CODEBASE_ROOT="$ROOT_DIR" \
    /usr/bin/node "$SCRIPT_DIR/node_modules/codebase-memory-mcp/bin/codebase-memory-mcp" "$@"
