#!/bin/bash

# Check if the application is running
PID=$(ps aux | grep "pnpm start --character ./characters/ic.news.character.json" | grep -v grep | awk '{print $2}')

if [ -z "$PID" ]; then
  echo "Application is not running."
else
  echo "Application is running with PID: $PID"
  echo "To view logs: tail -f logs/app.log"
fi
