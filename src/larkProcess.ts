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
 *
 * Uses `npx --prefer-offline` so it picks up the globally pre-installed
 * package without re-downloading it — avoids the OOM crash from a cold npx.
 */
export function startLarkMcp(config: LarkMcpConfig): ChildProcess {
  const args: string[] = [
    "--prefer-offline",
    "-y",
    "@larksuiteoapi/lark-mcp",
    "mcp",
    "-a", config.appId,
    "-s", config.appSecret,
    "--mode", "streamable",
    "--host", config.host,
    "-p",    config.port,
  ];

  if (config.domain) args.push("--domain", config.domain);
  if (config.tools)  args.push("-t", config.tools);

  console.log(`[bridge] Starting lark-mcp internally on ${config.host}:${config.port}`);

  const proc = spawn("npx", args, {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      // Cap lark-mcp heap to avoid container OOM
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
 * Any HTTP response (even 405) means the server is up and accepting connections.
 * Rejects immediately if the lark-mcp process exits before becoming ready.
 */
export function waitForLarkMcp(
  proc: ChildProcess,
  host: string,
  port: number,
  timeoutMs = 60_000,
  intervalMs = 500
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = Date.now() + timeoutMs;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    // Fail fast if the process dies before the probe succeeds
    proc.once("exit", (code, signal) => {
      done(new Error(`lark-mcp exited before becoming ready — code=${code ?? "null"} signal=${signal ?? "null"}`));
    });

    let attempt = 0;
    const probe = () => {
      if (settled) return;
      attempt++;

      const req = http.request(
        { hostname: host, port, path: "/mcp", method: "GET", timeout: 2000 },
        (res) => {
          res.resume();
          console.log(`[bridge] lark-mcp ready after ${attempt} probe(s) (HTTP ${res.statusCode})`);
          done();
        }
      );

      req.on("error", (err) => {
        if (settled) return;
        if (Date.now() >= deadline) {
          done(new Error(`lark-mcp did not become ready within ${timeoutMs}ms (${attempt} probes)`));
        } else {
          if (attempt % 10 === 0) {
            console.log(`[bridge] Still waiting for lark-mcp... (${attempt} probes, ${Math.round((deadline - Date.now()) / 1000)}s left)`);
          }
          setTimeout(probe, intervalMs);
        }
      });

      req.end();
    };

    probe();
  });
}
