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

# Pre-install lark-mcp globally to avoid npx download delay on first call
RUN npm install -g @larksuiteoapi/lark-mcp

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# MCP endpoint (lark-mcp)
EXPOSE 3000
# Health-check endpoint (this bridge)
EXPOSE 3001

# Tini for proper signal forwarding
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "dist/index.js"]
