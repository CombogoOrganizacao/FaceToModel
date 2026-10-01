#!/usr/bin/env bash
# =============================================================================
# FaceToModel — Project Setup Script
#
# Run once after cloning to install dependencies and download required assets.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}  🎭  FaceToModel — Setup${RESET}"
echo -e "${CYAN}  ─────────────────────────────────────────${RESET}"
echo ""

# ── Node.js check ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}  ✗  Node.js is required but not found.${RESET}"
  echo -e "     Download it from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node --version)
echo -e "  ${GREEN}✓${RESET}  Node.js ${NODE_VERSION}"

# ── npm install ───────────────────────────────────────────────────────────────
echo -e "\n  Installing server dependencies…"
cd "${SCRIPT_DIR}/server"
npm install
echo -e "  ${GREEN}✓${RESET}  npm install complete"

# ── facecap.glb download ──────────────────────────────────────────────────────
MODEL_DIR="${SCRIPT_DIR}/web/models"
MODEL_PATH="${MODEL_DIR}/facecap.glb"
MODEL_URL="https://threejs.org/examples/models/gltf/facecap.glb"

mkdir -p "${MODEL_DIR}"

if [ -f "${MODEL_PATH}" ]; then
  echo -e "\n  ${GREEN}✓${RESET}  facecap.glb already present — skipping download."
else
  echo -e "\n  Downloading facecap.glb from Three.js examples…"
  echo -e "  ${YELLOW}URL: ${MODEL_URL}${RESET}"

  if command -v curl &>/dev/null; then
    curl -L --progress-bar -o "${MODEL_PATH}" "${MODEL_URL}"
  elif command -v wget &>/dev/null; then
    wget -q --show-progress -O "${MODEL_PATH}" "${MODEL_URL}"
  else
    echo -e "  ${RED}✗  Neither curl nor wget found. Please install one and re-run setup.sh${RESET}"
    exit 1
  fi

  if [ -f "${MODEL_PATH}" ]; then
    SIZE=$(du -sh "${MODEL_PATH}" | cut -f1)
    echo -e "  ${GREEN}✓${RESET}  facecap.glb downloaded (${SIZE})"
  else
    echo -e "  ${RED}✗  Download failed. Please check your internet connection and try again.${RESET}"
    exit 1
  fi
fi

# ── Make start.sh executable ──────────────────────────────────────────────────
chmod +x "${SCRIPT_DIR}/server/start.sh"
echo -e "  ${GREEN}✓${RESET}  server/start.sh is executable"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}${GREEN}Setup complete!${RESET}"
echo ""
echo -e "  To start the server:"
echo -e "  ${CYAN}  cd server && ./start.sh${RESET}"
echo ""
echo -e "  Then open your browser at:"
echo -e "  ${CYAN}  http://localhost:3000${RESET}"
echo ""
echo -e "  ${CYAN}─────────────────────────────────────────${RESET}"
echo ""
