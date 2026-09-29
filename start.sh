#!/usr/bin/env bash
set -e

# Antigravity Dashboard - Unified Startup Script
# Usage:
#   ./start.sh         # Start production server (builds if needed, port 3456)
#   ./start.sh --dev   # Start development mode (hot reload backend + Vite frontend)

MODE="prod"
if [ "$1" = "--dev" ] || [ "$1" = "-d" ] || [ "$1" = "dev" ]; then
  MODE="dev"
fi

# Ensure working directory is project root
cd "$(dirname "$0")"

# Check for pnpm
if ! command -v pnpm &> /dev/null; then
  echo "Error: pnpm is required but not installed."
  echo "Please install pnpm via: npm install -g pnpm"
  exit 1
fi

# Ensure dependencies are installed
if [ ! -d "node_modules" ] || [ ! -d "apps/backend/node_modules" ] || [ ! -d "apps/web/node_modules" ]; then
  echo "Installing workspace dependencies..."
  pnpm install
fi

if [ "$MODE" = "dev" ]; then
  echo "=========================================================="
  echo "  🚀 Starting Antigravity Dashboard in DEVELOPMENT mode   "
  echo "  - Backend (TS watch + auto-restart) : http://localhost:3456"
  echo "  - Frontend (Vite with HMR)          : http://localhost:5173"
  echo "=========================================================="
  exec pnpm dev
else
  echo "=========================================================="
  echo "  🚀 Starting Antigravity Dashboard in PRODUCTION mode    "
  echo "  - Unified Dashboard & API           : http://localhost:3456"
  echo "=========================================================="
  exec pnpm start
fi
