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
    console.error(`[bridge] Missing required environment variable: ${name}`);
    console.error(`[bridge] Copy .env.example to .env and fill in the values.`);
    process.exit(1);
  }
  return value;
}

const LARK_APP_ID     = requireEnv("LARK_APP_ID");
const LARK_APP_SECRET = requireEnv("LARK_APP_SECRET");
const BRIDGE_HOST     = process.env.BRIDGE_HOST  ?? "0.0.0.0";
const BRIDGE_PORT     = process.env.BRIDGE_PORT  ?? "3000";
const HEALTH_PORT     = parseInt(process.env.HEALTH_PORT ?? "3001", 10);
const LARK_DOMAIN     = process.env.LARK_DOMAIN;
const LARK_TOOLS      = process.env.LARK_TOOLS;

// ─── Start lark-mcp subprocess ──────────────────────────────────────────────
let larkProc: ChildProcess | null = startLarkMcp({
  appId:     LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  host:      BRIDGE_HOST,
  port:      BRIDGE_PORT,
  domain:    LARK_DOMAIN,
  tools:     LARK_TOOLS,
});

// ─── Health-check server ─────────────────────────────────────────────────────
const healthServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const payload = JSON.stringify({
      status: "ok",
      mcpEndpoint: `http://${BRIDGE_HOST === "0.0.0.0" ? "localhost" : BRIDGE_HOST}:${BRIDGE_PORT}/mcp`,
      larkDomain: LARK_DOMAIN ?? "https://open.feishu.cn (default)",
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found. Use GET /health" }));
});

healthServer.listen(HEALTH_PORT, () => {
  console.log(`[bridge] Health check  → http://localhost:${HEALTH_PORT}/health`);
  console.log(`[bridge] MCP endpoint  → http://localhost:${BRIDGE_PORT}/mcp`);
  console.log(`[bridge] Ready. Point your agent at http://localhost:${BRIDGE_PORT}/mcp`);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown(signal: string): void {
  console.log(`\n[bridge] Received ${signal} — shutting down...`);

  if (larkProc && !larkProc.killed) {
    larkProc.kill("SIGTERM");
    larkProc = null;
  }

  healthServer.close(() => {
    console.log("[bridge] Health server closed. Goodbye.");
    process.exit(0);
  });

  // Force exit if health server takes too long
  setTimeout(() => {
    console.error("[bridge] Forced exit after timeout.");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
