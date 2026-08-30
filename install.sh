#!/usr/bin/env bash
#
# remote-access-mcp — one-liner installer for Ubuntu/Debian servers.
#
#   curl -fsSL https://raw.githubusercontent.com/amiralimanzar/remote-access-mcp/main/install.sh | bash
#
# What it does:
#   1. Checks for Node.js >= 18. Installs it via NodeSource if missing.
#   2. Installs remote-access-mcp globally via npm.
#   3. Prints next steps. Does NOT start anything — the user stays in control.
#
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

say()  { printf "${GREEN}✔${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
die()  { printf "${RED}✖ %s${NC}\n" "$1" >&2; exit 1; }

header() {
  printf "${BOLD}"
  cat <<'EOF'
  ___                        _____
 | _ \__ _ __ _ ___ _ _   |_   _|__ _ _ _ __ _ ___
 |   / _` / _` / -_) '_|    | |/ - \ '_| '_/ _` / -_)
 |_|_\__,_\__, \___|_|      |_|\___/_| |_| \__,_\___|
          |___/         remote-access-mcp installer
EOF
  printf "${NC}\n"
}

header

# ----------------------------------------------------------------Node.js
need_node_install=0

if ! command -v node >/dev/null 2>&1; then
  need_node_install=1
  warn "Node.js not found."
else
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "${NODE_MAJOR}" -lt 18 ]; then
    need_node_install=1
    warn "Node.js $(node --version) found, but >= 18 is required."
  else
    say "Node.js $(node --version) — OK"
  fi
fi

if [ "${need_node_install}" -eq 1 ]; then
  if [ "$(id -u)" -ne 0 ]; then
    die "Node.js install requires root. Re-run with sudo, or install Node >= 18 manually first."
  fi
  if ! command -v curl >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq curl
  fi
  say "Installing Node.js 22.x LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  say "Node.js $(node --version) installed"
fi

# ----------------------------------------------------------------npm package
say "Installing remote-access-mcp globally..."
npm install -g remote-access-mcp --silent

say "Installed: $(remote-access-mcp --version 2>/dev/null || ramcp --version 2>/dev/null || echo 'OK')"

printf '\n'
printf "${BOLD}Next steps:${NC}\n"
printf '  1. ramcp init               # generate config + token\n'
printf '  2. ramcp start              # run in foreground\n'
printf '  3. ramcp service install    # systemd + nginx vhost (production)\n'
printf '  4. ramcp url                # connector URL for your chatbot\n'
printf '\nDocs: https://github.com/amiralimanzar/remote-access-mcp\n'
