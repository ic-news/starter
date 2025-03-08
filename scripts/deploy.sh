#!/bin/bash

# Exit on error
set -e

echo "Deploying ic-news-starter..."

# Navigate to the project directory
cd "$(dirname "$0")/.."

# Install dependencies if needed
if [ "$1" = "--install" ]; then
  echo "Installing dependencies..."
  pnpm install
fi

# Install build dependencies if needed
if [ "$1" = "--setup" ] || [ "$2" = "--setup" ]; then
  echo "Installing build dependencies..."
  sudo apt-get update
  sudo apt-get install -y python3 make g++ libsqlite3-dev
fi

# Rebuild better-sqlite3 to ensure native bindings are correctly compiled
echo "Rebuilding better-sqlite3 without warnings..."
# Set environment variables to suppress warnings
export CFLAGS="-w"
export CXXFLAGS="-w"

# Rebuild with warnings suppressed
cd node_modules/better-sqlite3
npm run build 2>/dev/null || npm run build
cd ../..

# Build the project
echo "Building the project..."
pnpm build

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
  echo "PM2 is not installed. Installing PM2..."
  npm install -g pm2
fi

# Start the application with PM2
echo "Starting the application with PM2..."
pm2 delete ic-news-starter 2>/dev/null || true
pm2 start npm --name "ic-news-starter" -- start -- --character ./characters/ic.news.character.json
pm2 save

echo "Application started successfully with PM2"
echo "To monitor: pm2 monit"
echo "To view logs: pm2 logs ic-news-starter"
echo "To stop: pm2 stop ic-news-starter"
