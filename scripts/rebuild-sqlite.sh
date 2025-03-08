#!/bin/bash

# Exit on error
set -e

echo "Rebuilding better-sqlite3 module..."

# Navigate to the project directory
cd "$(dirname "$0")/.."

# Ensure dependencies are installed
if [ ! -d "node_modules/better-sqlite3" ]; then
  echo "better-sqlite3 not found. Installing dependencies first..."
  pnpm install
fi

# Check if we want to hide warnings
HIDE_WARNINGS=1

# Set environment variables to suppress warnings
if [ "$HIDE_WARNINGS" -eq 1 ]; then
  echo "Suppressing compilation warnings..."
  export CFLAGS="-w"
  export CXXFLAGS="-w"
  
  # Redirect stderr to /dev/null to hide warnings
  cd node_modules/better-sqlite3
  npm run build 2>/dev/null || npm run build
  cd ../..
else
  # Normal build with warnings
  cd node_modules/better-sqlite3
  npm run build
  cd ../..
fi

echo "better-sqlite3 rebuilt successfully!"
