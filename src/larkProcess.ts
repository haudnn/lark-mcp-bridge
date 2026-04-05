import { spawn, ChildProcess } from "child_process";
import * as http from "http";

export interface LarkMcpConfig {
  appId: string;
  appSecret: string;
  /** Internal host — always 127.0.0.1, never exposed publicly */
  host: string;
  /** Internal port — web server proxies to this */
  port: string;
  domain?: string;
  tools?: string;
}

/**
 * Spawns lark-mcp in streamable-HTTP mode on an internal port.
 * Uses the globally installed binary to avoid npx download overhead and OOM.
 */
export function startLarkMcp(config: LarkMcpConfig): ChildProcess {
  const args: string[] = [
    "mcp",
    "-a", config.appId,
    "-s", config.appSecret,
    "--mode", "streamable",
    "--host", config.host,
    "-p", config.port,
  ];

  if (config.domain) args.push("--domain", config.domain);
  if (config.tools)  args.push("-t", config.tools);

  console.log(`[bridge] Starting lark-mcp internally on ${config.host}:${config.port}`);

  const proc = spawn("lark-mcp", args, {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      // Limit lark-mcp heap to avoid container OOM; adjust if needed
      NODE_OPTIONS: "--max-old-space-size=256",
    },
  });

  proc.on("error", (err) => {
    console.error("[bridge] Failed to start lark-mcp:", err.message);
  });

  proc.on("exit", (code, signal) => {
    if (code !== 0) {
      console.error(`[bridge] lark-mcp exited — code=${code ?? "null"} signal=${signal ?? "null"}`);
    } else {
      console.log("[bridge] lark-mcp exited cleanly.");
    }
  });

  return proc;
}

/**
 * Polls lark-mcp's internal HTTP endpoint until it responds (or times out).
 * Resolves when ready, rejects on timeout.
 */
export function waitForLarkMcp(
  host: string,
  port: number,
  timeoutMs = 30_000,
  intervalMs = 500
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const probe = () => {
      const req = http.request(
        { hostname: host, port, path: "/mcp", method: "GET", timeout: 1000 },
        (res) => {
          // Any HTTP response (including 405 Method Not Allowed) means it's up
          res.resume();
          console.log(`[bridge] lark-mcp ready (HTTP ${res.statusCode})`);
          resolve();
        }
      );

      req.on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error(`lark-mcp did not become ready within ${timeoutMs}ms`));
        } else {
          setTimeout(probe, intervalMs);
        }
      });

      req.end();
    };

    probe();
  });
}
