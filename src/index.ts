import * as http from "http";
import * as dotenv from "dotenv";
import { ChildProcess } from "child_process";
import { startLarkMcp, waitForLarkMcp } from "./larkProcess";

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

const LARK_APP_ID     = requireEnv("LARK_APP_ID");
const LARK_APP_SECRET = requireEnv("LARK_APP_SECRET");
const LARK_DOMAIN     = process.env.LARK_DOMAIN;
const LARK_TOOLS      = process.env.LARK_TOOLS;

// PaaS platforms (Tose, Heroku, Render…) inject PORT automatically.
const WEB_PORT = parseInt(process.env.PORT ?? process.env.BRIDGE_PORT ?? "3000", 10);

// lark-mcp runs on a private internal port — never exposed publicly.
const LARK_INTERNAL_PORT = parseInt(process.env.LARK_INTERNAL_PORT ?? "13000", 10);
const LARK_INTERNAL_HOST = "127.0.0.1";

// ─── State ────────────────────────────────────────────────────────────────────
let larkProc: ChildProcess | null = null;
let larkReady = false;

// ─── Single web server: health + MCP proxy ───────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  // Health check — always available, reflects lark-mcp readiness
  if (req.method === "GET" && url === "/health") {
    const status = larkReady ? 200 : 503;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: larkReady ? "ok" : "starting",
      larkMcp: larkReady ? "ready" : "not ready",
      larkDomain: LARK_DOMAIN ?? "https://open.feishu.cn (default)",
    }));
    return;
  }

  // Reject proxy requests until lark-mcp is ready
  if (!larkReady) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "lark-mcp is still starting, retry in a moment" }));
    return;
  }

  // Proxy all other requests → internal lark-mcp
  // Strip hop-by-hop headers that must not be forwarded by a proxy.
  const HOP_BY_HOP = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
  ]);

  const forwardHeaders: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) forwardHeaders[k] = v;
  }
  forwardHeaders["host"] = `${LARK_INTERNAL_HOST}:${LARK_INTERNAL_PORT}`;

  const proxyReq = http.request(
    {
      hostname: LARK_INTERNAL_HOST,
      port: LARK_INTERNAL_PORT,
      path: url,
      method: req.method,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      // Build clean response headers — strip hop-by-hop, add SSE hints.
      const resHeaders: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v;
      }
      const isSSE = String(proxyRes.headers["content-type"] ?? "").includes("text/event-stream");
      if (isSSE) {
        // Prevent nginx / PaaS reverse proxies from buffering the SSE stream.
        resHeaders["x-accel-buffering"] = "no";
        resHeaders["cache-control"] = "no-cache";
      }
      res.writeHead(proxyRes.statusCode ?? 200, resHeaders);
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

  req.pipe(proxyReq, { end: true });
});

// ─── Launch lark-mcp + wait for readiness (restarts on crash) ────────────────
async function launchLarkMcp(): Promise<void> {
  larkReady = false;

  larkProc = startLarkMcp({
    appId:     LARK_APP_ID,
    appSecret: LARK_APP_SECRET,
    host:      LARK_INTERNAL_HOST,
    port:      String(LARK_INTERNAL_PORT),
    domain:    LARK_DOMAIN,
    tools:     LARK_TOOLS,
  });

  // When lark-mcp exits after being ready, mark not-ready and schedule restart
  larkProc.once("exit", (code, signal) => {
    if (larkReady) {
      larkReady = false;
      console.error(`[bridge] lark-mcp crashed (code=${code ?? "null"} signal=${signal ?? "null"}) — restarting in 2s...`);
      setTimeout(() => {
        launchLarkMcp().catch((err) => {
          console.error("[bridge] lark-mcp restart failed:", err.message);
        });
      }, 2000);
    }
  });

  // 3. Wait for lark-mcp to accept connections (fail fast if process exits)
  await waitForLarkMcp(larkProc, LARK_INTERNAL_HOST, LARK_INTERNAL_PORT, 60_000);
  larkReady = true;
  console.log(`[bridge] lark-mcp ready — proxying /mcp → ${LARK_INTERNAL_HOST}:${LARK_INTERNAL_PORT}/mcp`);
}

// ─── Startup sequence ─────────────────────────────────────────────────────────
async function start(): Promise<void> {
  // 1. Start web server immediately (returns 503 while lark-mcp warms up)
  await new Promise<void>((resolve) => {
    server.listen(WEB_PORT, "0.0.0.0", () => {
      console.log(`[bridge] Web server       → http://0.0.0.0:${WEB_PORT}`);
      console.log(`[bridge] Health check     → http://0.0.0.0:${WEB_PORT}/health`);
      console.log(`[bridge] MCP endpoint     → http://0.0.0.0:${WEB_PORT}/mcp`);
      console.log(`[bridge] lark-mcp (int.)  → ${LARK_INTERNAL_HOST}:${LARK_INTERNAL_PORT}`);
      console.log(`[bridge] Waiting for lark-mcp to be ready...`);
      resolve();
    });
  });

  // 2. Launch lark-mcp and wait for it to be ready
  await launchLarkMcp();
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal: string): void {
  console.log(`\n[bridge] ${signal} — shutting down...`);
  larkReady = false;

  if (larkProc && !larkProc.killed) {
    larkProc.kill("SIGTERM");
    larkProc = null;
  }

  server.close(() => {
    console.log("[bridge] Shutdown complete.");
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ─── Run ──────────────────────────────────────────────────────────────────────
start().catch((err) => {
  console.error("[bridge] Startup failed:", err.message);
  process.exit(1);
});
