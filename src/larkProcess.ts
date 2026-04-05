import { spawn, ChildProcess } from "child_process";

export interface LarkMcpConfig {
  appId: string;
  appSecret: string;
  host: string;
  port: string;
  domain?: string;
  tools?: string;
}

/**
 * Spawns @larksuiteoapi/lark-mcp in streamable-HTTP mode.
 * The MCP endpoint will be available at http://{host}:{port}/mcp
 *
 * NOTE: lark-mcp's CLI requires credentials as arguments — there is no
 * env-var alternative in the current SDK. The subprocess inherits
 * process.env so any variables set there will also be available.
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

  if (config.domain) {
    args.push("--domain", config.domain);
  }

  if (config.tools) {
    args.push("-t", config.tools);
  }

  console.log(
    `[bridge] Starting lark-mcp in streamable mode on ${config.host}:${config.port}`
  );

  const proc = spawn("npx", args, {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env },
  });

  proc.on("error", (err) => {
    console.error("[bridge] Failed to start lark-mcp process:", err.message);
  });

  proc.on("exit", (code, signal) => {
    if (code !== 0) {
      console.error(
        `[bridge] lark-mcp exited unexpectedly — code=${code ?? "null"} signal=${signal ?? "null"}`
      );
    } else {
      console.log("[bridge] lark-mcp process exited cleanly.");
    }
  });

  return proc;
}
