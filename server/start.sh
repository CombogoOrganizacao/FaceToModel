#!/usr/bin/env bash
# =============================================================================
# FaceToModel — Server Start Script
#
# Usage: ./start.sh [HTTP_PORT] [WS_PORT]
#   HTTP_PORT  default 3000
#   WS_PORT    default 8080
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTTP_PORT="${1:-3000}"
WS_PORT="${2:-8080}"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}  FaceToModel — Server${RESET}"
echo -e "${CYAN}  ─────────────────────────────────────────${RESET}"

# ── Node.js check ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}  ✗  Node.js not found. Install it from https://nodejs.org${RESET}"
  exit 1
fi

NODE_VERSION=$(node --version)
echo -e "  Node.js  ${GREEN}${NODE_VERSION}${RESET}"

# ── npm install if needed ─────────────────────────────────────────────────────
if [ ! -d "${SCRIPT_DIR}/node_modules" ]; then
  echo -e "\n  ${YELLOW}node_modules not found — running npm install…${RESET}"
  cd "${SCRIPT_DIR}" && npm install
  echo -e "  ${GREEN}✓  npm install complete${RESET}"
else
  echo -e "  ${GREEN}✓  node_modules present${RESET}"
fi

# ── Local IP addresses ────────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Local network addresses:${RESET}"

if command -v ifconfig &>/dev/null; then
  # macOS / BSD
  ifconfig | awk '
    /^[a-z]/ { iface=$1 }
    /inet / && !/127\.0\.0\.1/ {
      gsub("addr:", "", $2)
      printf "    %-10s %s\n", iface, $2
    }
  '
elif command -v ip &>/dev/null; then
  # Linux
  ip -4 addr show | awk '
    /^[0-9]+:/ { match($0, /: ([^:]+):/, arr); iface=arr[1] }
    /inet / && !/127\.0\.0\.1/ { printf "    %-10s %s\n", iface, $2 }
  '
else
  echo -e "    ${YELLOW}(could not determine IP — install ifconfig or iproute2)${RESET}"
fi

# ── Smartphone setup instructions ─────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Smartphone Setup (MediaPipe Web / P2P):${RESET}"
echo -e "  1. Connect your smartphone to the ${BOLD}same Wi-Fi network${RESET} as this machine (or scan QR code)."
echo -e "  2. Open the camera sensor at  ${CYAN}http://<IP>:${HTTP_PORT}/camera.html${RESET}"
echo ""
echo -e "  Open the Studio UI at:  ${CYAN}http://<IP>:${HTTP_PORT}${RESET}"
echo ""
echo -e "  ${BOLD}Press Ctrl+C to stop the server.${RESET}"
echo -e "  ${CYAN}─────────────────────────────────────────${RESET}"
echo ""

# ── Start server ──────────────────────────────────────────────────────────────
cd "${SCRIPT_DIR}"
export HTTP_PORT WS_PORT
exec node server.js
