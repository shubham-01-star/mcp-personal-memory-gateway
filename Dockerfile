# syntax=docker/dockerfile:1

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV INGEST_DIR=/data
ENV LANCE_DB_PATH=/data/lancedb
ENV HEALTH_HOST=0.0.0.0
ENV HEALTH_PORT=8081
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Create data dir for LanceDB + ingestion
RUN mkdir -p /data && chown -R node:node /app /data
USER node

CMD ["node", "dist/index.js"]
