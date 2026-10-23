import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const apiPort = 3397;

async function assertPortFree(): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolveReady, reject) => {
    probe.once("error", reject);
    probe.listen(apiPort, "127.0.0.1", resolveReady);
  });
  await new Promise<void>((resolveClosed) => probe.close(() => resolveClosed()));
}

export default async function setup(): Promise<() => Promise<void>> {
  const dataDir = process.env.RR_E2E_DATA_DIR;
  if (!dataDir) throw new Error("RR_E2E_DATA_DIR was not set by isolated config");
  const target = resolve(dataDir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !/^tkd-rr-e2e-[0-9a-f-]{36}$/.test(basename(target))
  ) {
    throw new Error(`Unsafe isolated data directory: ${target}`);
  }
  await assertPortFree();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(apiPort), DATA_DIR: target },
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Isolated API exited before bind: ${output}`);
      if (output.includes("TKD Scoring Server")) {
        const response = await fetch(`http://127.0.0.1:${apiPort}/api/ring/status`);
        if (response.ok) break;
      }
      if (attempt === 299) throw new Error(`Isolated API did not bind: ${output}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  } catch (error) {
    child.kill();
    throw error;
  }
  return async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolveStopped) =>
        child.once("exit", () => resolveStopped())
      );
      if (!child.kill()) throw new Error(`Could not stop isolated API PID ${child.pid}`);
      await Promise.race([
        stopped,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Isolated API PID ${child.pid} did not exit`)), 5_000)
        ),
      ]);
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  };
}
