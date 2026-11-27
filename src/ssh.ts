import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Capture } from "./capture.ts";
import { buildRemoteCommand, checkAlias, parseStderr } from "./script.ts";

/** Idle masters exit on their own after this, even if Pi crashes. */
export const CONTROL_PERSIST = "30m";
/** sun_path is 108 bytes and ssh appends a 17-byte temporary suffix while binding. */
const MAX_SOCKET_BYTES = 90;

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Working directory when the remote shell exited; undefined if it never reported one. */
  cwd?: string;
  /** True when the command never started on the remote side (ssh itself failed). */
  connectFailed: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  files: string[];
  limited: boolean;
  stopAcknowledged: boolean;
  /** The command exited but a child still held an output pipe open. */
  detached: boolean;
}

export class ControlDir {
  readonly dir: string;

  constructor(dir: string) {
    if (/\s/.test(dir))
      throw new Error(`Control directory must not contain whitespace: ${dir}`);
    this.dir = dir;
  }

  socketFor(alias: string): string {
    const path = join(this.dir, checkAlias(alias));
    if (Buffer.byteLength(path) > MAX_SOCKET_BYTES)
      throw new Error(
        `Control socket path too long for host ${alias}: ${path}`,
      );
    return path;
  }

  ensure(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  aliases(): string[] {
    try {
      return readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isSocket())
        .map((e) => e.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Options that route every ssh/rsync call for one host through Pi's own master. */
  sshOptions(alias: string): string[] {
    return [
      "-o",
      "BatchMode=yes",
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${this.socketFor(alias)}`,
      "-o",
      `ControlPersist=${CONTROL_PERSIST}`,
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=4",
    ];
  }

  /** Returns the master PID, or undefined when no live master answers. */
  check(alias: string): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      execFile(
        "ssh",
        ["-S", this.socketFor(alias), "-O", "check", "--", alias],
        { timeout: 5000, env: { ...process.env, LC_ALL: "C" } },
        (error, _out, stderr) => {
          const match = String(stderr).match(/pid=(\d+)/);
          if (!error && match) resolve(Number(match[1]));
          else if (
            /Control socket connect.*(?:No such file|Connection refused)/.test(
              stderr,
            )
          )
            resolve(undefined);
          else
            reject(
              new Error(stderr.trim() || error?.message || "No PID returned"),
            );
        },
      );
    });
  }

  private removeSocket(alias: string): void {
    try {
      unlinkSync(this.socketFor(alias));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** Close even after the alias was removed from ssh config; remove dead sockets too. */
  async close(alias: string): Promise<string> {
    try {
      await this.control(alias, "exit");
      return "closed";
    } catch (error) {
      let pid: number | undefined;
      try {
        pid = await this.check(alias);
      } catch {
        throw error;
      }
      if (pid) {
        // The control command can fail when an alias was renamed. The PID came
        // from this exact Pi-owned socket, so it is safe to terminate that master.
        process.kill(pid, "SIGTERM");
        this.removeSocket(alias);
        return "master terminated";
      }
      this.removeSocket(alias);
      return "stale socket removed";
    }
  }

  /** Remove sockets whose masters no longer answer, leaving live masters alone. */
  async pruneStale(): Promise<string[]> {
    const removed = await Promise.all(
      this.aliases().map(async (alias) => {
        try {
          if (await this.check(alias)) return undefined;
          this.removeSocket(alias);
          return alias;
        } catch {
          return undefined;
        }
      }),
    );
    return removed.filter((alias): alias is string => !!alias);
  }

  /** `stop` lets running sessions finish; `exit` tears them down immediately. */
  control(alias: string, op: "stop" | "exit"): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "ssh",
        ["-S", this.socketFor(alias), "-O", op, "--", alias],
        { timeout: 5000 },
        (error, _out, stderr) => {
          if (error) reject(new Error(String(stderr).trim() || error.message));
          else resolve(String(stderr).trim());
        },
      );
    });
  }
}

export interface ExecOptions {
  cwd?: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export function remoteExec(
  control: ControlDir,
  alias: string,
  command: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const script = buildRemoteCommand(
    command,
    options.cwd,
    options.timeoutSeconds,
  );
  control.ensure();
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [...control.sshOptions(alias), "-T", "--", alias, script.remoteCommand],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const out = new Capture();
    const err = new Capture();
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let errPreview = "";
    const markerLine = new RegExp(
      `^${script.nonce} (?:READY|PID \\d+|CWD .*|STOP|DETACHED)\\r?$`,
    );
    const streamStderr = (text: string, final = false) => {
      errPreview += text;
      const lines = errPreview.split("\n");
      errPreview = lines.pop() ?? "";
      const visibleLines: string[] = [];
      for (const line of lines) {
        if (markerLine.test(line)) {
          if (
            /(?: CWD | STOP$| DETACHED$)/.test(line) &&
            visibleLines.at(-1) === ""
          )
            visibleLines.pop();
          continue;
        }
        visibleLines.push(line);
      }
      const visible = visibleLines.map((line) => `${line}\n`).join("");
      if (visible) options.onOutput?.(visible, "stderr");
      if (
        errPreview.length > 8192 ||
        (final && errPreview && !markerLine.test(errPreview))
      ) {
        options.onOutput?.(errPreview, "stderr");
        errPreview = "";
      }
    };
    let timedOut = false,
      aborted = false,
      startedRemote = false;
    let markerTail = "";
    let captureError: unknown;
    let cutoff: NodeJS.Timeout | undefined;
    const stop = () => {
      if (cutoff) return;
      child.stdin.end("!");
      cutoff = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
      }, 2500);
    };
    child.stdin.on("error", () => {
      /* A closed SSH channel cannot acknowledge cancellation. */
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutSeconds * 1000);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const capture = (sink: Capture, chunk: Buffer) => {
      if (captureError) return;
      try {
        sink.add(chunk);
      } catch (error) {
        captureError = error;
        stop();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      capture(out, chunk);
      const text = outDecoder.write(chunk);
      if (text) options.onOutput?.(text, "stdout");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture(err, chunk);
      const text = errDecoder.write(chunk);
      if (text) streamStderr(text);
      if (!startedRemote) {
        const text = markerTail + chunk.toString();
        const parsed = parseStderr(text, script.nonce);
        startedRemote =
          parsed.shellStarted === true || parsed.pid !== undefined;
        markerTail = text.slice(-128);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      clearTimeout(cutoff);
      out.close();
      err.close();
      const outRest = outDecoder.end();
      const errRest = errDecoder.end();
      if (outRest) options.onOutput?.(outRest, "stdout");
      streamStderr(errRest, true);
      if (captureError) {
        reject(captureError);
        return;
      }
      const stopMarker = `\n${script.nonce} STOP\n`;
      const raw = err.text;
      const stopAcknowledged = raw.includes(stopMarker);
      const parsed = parseStderr(raw.replace(stopMarker, ""), script.nonce);
      resolve({
        exitCode: code,
        stdout: out.text,
        files: [out.file, err.file].filter((path): path is string => !!path),
        limited: out.limited || err.limited,
        stopAcknowledged,
        stderr: parsed.stderr,
        cwd: parsed.cwd,
        connectFailed: !startedRemote,
        timedOut: timedOut || (stopAcknowledged && !aborted),
        aborted,
        detached: parsed.detached === true,
        durationMs: Date.now() - started,
      });
    });
  });
}
