#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS from https://nodejs.org then run this again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
[ -d node_modules ] || { echo "Installing dependencies (one-time)..."; npm install; }
[ -f .env ] || cp .env.example .env
echo "Starting PlexurioMail... your browser will open at http://localhost:3000"
( sleep 2 && (open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null) ) &
npm start
