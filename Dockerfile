FROM node:22-slim
WORKDIR /app
COPY package.json ./
# better-sqlite3 is optional; if it can't build, the app falls back to Node's built-in SQLite.
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
# Persist the database on a mounted volume in the cloud:
ENV DB_PATH=/data/plexuriomail.db
EXPOSE 3000
CMD ["node", "src/server.js"]
