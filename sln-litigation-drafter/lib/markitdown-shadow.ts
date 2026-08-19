import { spawn } from "node:child_process";
import path from "node:path";

export const MARKITDOWN_VERSION = "0.1.7";
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

type FileClass = "docx" | "txt";
type WorkerRunner = (sourceBytes: Buffer, fileClass: FileClass, signal: AbortSignal) => Promise<string>;
type SpawnWorker = typeof spawn;

function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "PYTHONHOME", "PYTHONPATH"];
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    ...Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
  };
}

async function runWorker(
  sourceBytes: Buffer,
  fileClass: FileClass,
  signal: AbortSignal,
  spawnWorker: SpawnWorker,
): Promise<string> {
  const python = process.env.MARKITDOWN_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const script = path.join(process.cwd(), "scripts", "markitdown_shadow.py");

  return new Promise<string>((resolve, reject) => {
    const child = spawnWorker(python, ["-I", script, fileClass], {
      cwd: process.cwd(),
      env: workerEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let aborted = false;
    const abortWorker = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abortWorker, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        reject(new Error("markitdown_output_limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 64 * 1024) child.kill();
    });
    child.once("error", () => {
      signal.removeEventListener("abort", abortWorker);
      reject(new Error(aborted ? "markitdown_worker_aborted" : "markitdown_worker_unavailable"));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abortWorker);
      if (aborted) {
        reject(new Error("markitdown_worker_aborted"));
        return;
      }
      if (code !== 0) {
        reject(new Error("markitdown_conversion_failed"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(sourceBytes);
  });
}

export function createMarkItDownConverter(options: { run?: WorkerRunner; spawn?: SpawnWorker } = {}) {
  const run = options.run ?? ((sourceBytes, fileClass, signal) => (
    runWorker(sourceBytes, fileClass, signal, options.spawn ?? spawn)
  ));
  return (sourceBytes: Buffer, fileClass: FileClass, signal: AbortSignal) => run(sourceBytes, fileClass, signal);
}
