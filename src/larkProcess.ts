import { spawn, ChildProcess } from "child_process";

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
 * Spawns @larksuiteoapi/lark-mcp in streamable-HTTP mode on an internal port.
 * The web server (index.ts) proxies public traffic to this internal endpoint.
 */
export function startLarkMcp(config: LarkMcpConfig): ChildProcess {
  const args: string[] = [
    "-y",
    "@larksuiteoapi/lark-mcp",
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

  const proc = spawn("npx", args, {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env },
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
