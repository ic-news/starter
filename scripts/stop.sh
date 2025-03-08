#!/bin/bash

# Find and stop the running application process
PID=$(ps aux | grep "pnpm start --character ./characters/ic.news.character.json" | grep -v grep | awk '{print $2}')

if [ -z "$PID" ]; then
  echo "No running application found."
else
  echo "Stopping application with PID: $PID"
  kill $PID
  echo "Application stopped."
fi
