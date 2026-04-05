# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Pre-install lark-mcp globally to avoid npx download delay on first run
RUN npm install -g @larksuiteoapi/lark-mcp

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Tini for proper signal forwarding to Node.js subprocess
RUN apk add --no-cache tini libsecret

# Single public port — PaaS platforms inject PORT automatically.
# Default 3000 for local Docker runs.
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
