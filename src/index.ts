import * as http from "http";
import * as dotenv from "dotenv";
import { ChildProcess } from "child_process";
import { startLarkMcp } from "./larkProcess";

// ─── Load environment ────────────────────────────────────────────────────────
dotenv.config();

// ─── Validate required vars ─────────────────────────────────────────────────
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[bridge] Missing required env var: ${name}`);
    console.error(`[bridge] Copy .env.example to .env and fill in the values.`);
    process.exit(1);
  }
  return value;
}

const LARK_APP_ID       = requireEnv("LARK_APP_ID");
const LARK_APP_SECRET   = requireEnv("LARK_APP_SECRET");
const LARK_DOMAIN       = process.env.LARK_DOMAIN;
const LARK_TOOLS        = process.env.LARK_TOOLS;

// PaaS platforms (Tose, Heroku, Render…) inject PORT automatically.
// Fall back to BRIDGE_PORT or 3000 for local development.
const WEB_PORT          = parseInt(process.env.PORT ?? process.env.BRIDGE_PORT ?? "3000", 10);

// lark-mcp runs on a private internal port — never exposed publicly.
const LARK_INTERNAL_PORT = parseInt(process.env.LARK_INTERNAL_PORT ?? "13000", 10);
const LARK_INTERNAL_HOST = "127.0.0.1";

// ─── Start lark-mcp on internal port ────────────────────────────────────────
let larkProc: ChildProcess | null = startLarkMcp({
  appId:    LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  host:     LARK_INTERNAL_HOST,
  port:     String(LARK_INTERNAL_PORT),
  domain:   LARK_DOMAIN,
  tools:    LARK_TOOLS,
});

// ─── Single web server: health + MCP proxy ───────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  // Health check — served directly without hitting lark-mcp
  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      mcpEndpoint: `/mcp`,
      larkDomain: LARK_DOMAIN ?? "https://open.feishu.cn (default)",
    }));
    return;
  }

  // Proxy all other requests → lark-mcp internal port
  // Preserves headers so SSE (text/event-stream) streams through correctly.
  const proxyReq = http.request(
    {
      hostname: LARK_INTERNAL_HOST,
      port: LARK_INTERNAL_PORT,
      path: url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${LARK_INTERNAL_HOST}:${LARK_INTERNAL_PORT}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      // pipe() handles both regular JSON responses and SSE streams
      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on("error", (err) => {
    console.error("[bridge] Proxy error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "lark-mcp unavailable", message: err.message }));
    }
  });

  // Pipe request body (needed for POST /mcp calls)
  req.pipe(proxyReq, { end: true });
});

server.listen(WEB_PORT, "0.0.0.0", () => {
  console.log(`[bridge] Web server      → http://0.0.0.0:${WEB_PORT}`);
  console.log(`[bridge] Health check    → http://0.0.0.0:${WEB_PORT}/health`);
  console.log(`[bridge] MCP endpoint    → http://0.0.0.0:${WEB_PORT}/mcp`);
  console.log(`[bridge] lark-mcp (internal) → ${LARK_INTERNAL_HOST}:${LARK_INTERNAL_PORT}`);
  console.log(`[bridge] Ready.`);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown(signal: string): void {
  console.log(`\n[bridge] ${signal} received — shutting down...`);

  if (larkProc && !larkProc.killed) {
    larkProc.kill("SIGTERM");
    larkProc = null;
  }

  server.close(() => {
    console.log("[bridge] Server closed. Goodbye.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[bridge] Forced exit after timeout.");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
