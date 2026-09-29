#!/usr/bin/env bash
set -e

echo "Installing workspace dependencies..."
pnpm install

echo "Building project..."
pnpm run build

echo ""
echo "Setup complete!"
echo ""
echo "To start all services in production mode:"
echo "  pnpm start       (or ./start.sh)"
echo "  Dashboard will be available at: http://localhost:3456"
echo ""
echo "To start all services in development mode (hot reload):"
echo "  pnpm dev         (or ./start.sh --dev)"
echo "  Frontend: http://localhost:5173"
echo "  Backend:  http://localhost:3456"
echo ""

if [ "$1" = "--start" ] || [ "$1" = "-s" ]; then
  exec ./start.sh
elif [ "$1" = "--dev" ] || [ "$1" = "-d" ]; then
  exec ./start.sh --dev
fi
