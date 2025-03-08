#!/bin/bash

# Exit on error
set -e

echo "Installing SQLite dependencies for better-sqlite3..."

# Check if running as root, if not use sudo
if [ "$(id -u)" != "0" ]; then
  SUDO="sudo"
else
  SUDO=""
fi

# Update package lists
$SUDO apt-get update

# Install SQLite development libraries and build tools
$SUDO apt-get install -y \
  python3 \
  make \
  g++ \
  libsqlite3-dev

echo "SQLite dependencies installed successfully!"
echo "You can now rebuild better-sqlite3 with: ./scripts/rebuild-sqlite.sh"
