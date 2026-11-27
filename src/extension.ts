import { execFile } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  truncateTail,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CacheFile, pruneCache } from "./cache.ts";
import { registerJobs } from "./jobs.ts";
import {
  checkAlias,
  DEFAULT_TIMEOUT_SECONDS,
  validateTimeout,
} from "./script.ts";
import {
  CONTROL_PERSIST,
  ControlDir,
  remoteExec,
  type ExecResult,
} from "./ssh.ts";

const CWD_ENTRY = "remote-cwd";
const SYNC_TIMEOUT_SECONDS = 600;
const STATUS_REFRESH_MS = 60_000;
/** Chunks arrive far faster than a terminal can use them; one frame per 100 ms is enough. */
const PREVIEW_INTERVAL_MS = 100;

function spill(text: string): string {
  const cache = new CacheFile();
  try {
    cache.write(Buffer.from(text));
    return cache.path ?? "not cached (quota reached)";
  } finally {
    cache.close();
  }
}

function formatResult(host: string, result: ExecResult): string {
  let body = result.stdout;
  if (result.stderr.trim())
    body += `${body && !body.endsWith("\n") ? "\n" : ""}[stderr]\n${result.stderr}`;
  const truncation = truncateTail(body, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let text = truncation.content;
  if (result.files.length || result.limited) {
    text += `\n[Output truncated. ${result.limited ? "Cache limit reached; output not fully saved." : "Oversized streams cached."} ${result.files.join(", ")}]`;
  } else if (truncation.truncated) {
    text += `\n\n[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${spill(body)}]`;
  }
  if (result.detached) {
    text += `\n[Command exited while output streams were still open. A background process may still be running; redirect its stdin/stdout/stderr or use remote_job.]`;
  }
  const status = result.timedOut
    ? "timed out"
    : result.aborted
      ? "aborted"
      : result.connectFailed
        ? "ssh failed"
        : `exit ${result.exitCode}`;
  const where = result.cwd ? ` · cwd ${result.cwd}` : "";
  const cancellation =
    result.timedOut || result.aborted
      ? result.stopAcknowledged
        ? "; remote cancellation acknowledged"
        : "; remote state unknown"
      : "";
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}[${host}: ${status}${cancellation} · ${(result.durationMs / 1000).toFixed(1)}s${where}]`;
}

/** Resolve rsync paths without losing rsync's meaningful trailing slash or remote ~ expansion. */
export function resolveSyncPaths(
  host: string,
  localPath: string,
  remotePath: string,
  localCwd: string,
  remoteCwd?: string,
): { local: string; remoteSpec: string } {
  const resolved = isAbsolute(localPath)
    ? localPath
    : resolve(localCwd, localPath);
  const local =
    localPath.endsWith("/") && !resolved.endsWith("/")
      ? `${resolved}/`
      : resolved;
  const homeRelative = remotePath === "~" || remotePath.startsWith("~/");
  const remote =
    homeRelative || isAbsolute(remotePath) || !remoteCwd
      ? remotePath
      : `${remoteCwd}/${remotePath}`;
  // rsync -s passes paths verbatim, and remote rsync starts in $HOME, so ~/x becomes ./x.
  return {
    local,
    remoteSpec: `${host}:${homeRelative ? `.${remote.slice(1)}` : remote}`,
  };
}

export function registerRemote(
  pi: ExtensionAPI,
  options?: { controlDir?: string },
): void {
  const control = new ControlDir(
    options?.controlDir ?? join(getAgentDir(), "remote"),
  );
  const cwds = new Map<string, string>();
  const jobs = registerJobs(
    pi,
    control,
    join(control.dir, "..", "remote-jobs"),
    cwds,
  );
  let statusTimer: NodeJS.Timeout | undefined;

  const publish = (ctx: ExtensionContext) => {
    const hosts = control.aliases();
    ctx.ui.setStatus(
      "remote",
      hosts.length ? `remote: ${hosts.join(", ")}` : undefined,
    );
  };
  const remember = (host: string, cwd: string | undefined) => {
    if (!cwd || cwds.get(host) === cwd) return;
    cwds.set(host, cwd);
    pi.appendEntry(CWD_ENTRY, { host, cwd });
  };
  const restore = (ctx: ExtensionContext) => {
    cwds.clear();
    // Only the active session branch represents the current remote state.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CWD_ENTRY) continue;
      const data = entry.data as
        { host?: string; cwd?: string | null } | undefined;
      if (!data?.host) continue;
      if (data.cwd) cwds.set(data.host, data.cwd);
      else cwds.delete(data.host);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    pruneCache();
    restore(ctx);
    publish(ctx);
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(() => publish(ctx), STATUS_REFRESH_MS);
    statusTimer.unref();
  });
  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
    publish(ctx);
  });
  pi.on("session_shutdown", async () => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = undefined;
  });

  pi.registerTool({
    name: "remote",
    label: "Remote",
    description:
      "Run a shell command on an SSH host from ~/.ssh/config over a persistent connection. " +
      "The working directory is remembered per host between calls. " +
      `Returns stdout, then stderr, then exit code and final cwd. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; oversized output is cached subject to quota.`,
    promptSnippet:
      "Run a shell command on a remote SSH host with per-host persistent working directory",
    promptGuidelines: [
      "Use remote instead of running ssh through bash for any command on a host from ~/.ssh/config. Put the whole multi-line script in one remote call; no quoting for ssh is needed.",
      "Use remote_sync instead of scp or rsync through bash to copy files to or from a remote host.",
    ],
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias from ~/.ssh/config" }),
      command: Type.String({
        description:
          "Shell script to run with bash on the remote host. Written as-is; do not wrap it in ssh or extra quoting.",
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Directory to run in. Defaults to the directory the previous call on this host ended in. `~` is expanded on the remote.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: `Seconds before the remote process group is killed (default ${DEFAULT_TIMEOUT_SECONDS}).`,
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const host = checkAlias(params.host);
      const rememberedCwd =
        params.cwd === undefined ? cwds.get(host) : undefined;
      let streamed = "";
      let lastStream: "stdout" | "stderr" | undefined;
      let pendingPreview: string | undefined;
      let previewTimer: NodeJS.Timeout | undefined;
      let lastPreview = 0;
      const flushPreview = () => {
        previewTimer = undefined;
        if (pendingPreview === undefined) return;
        const text = pendingPreview;
        pendingPreview = undefined;
        lastPreview = Date.now();
        onUpdate?.({ content: [{ type: "text", text }], details: {} });
      };
      const schedulePreview = () => {
        pendingPreview = streamed;
        if (previewTimer) return;
        const wait = PREVIEW_INTERVAL_MS - (Date.now() - lastPreview);
        if (wait <= 0) flushPreview();
        else previewTimer = setTimeout(flushPreview, wait);
      };
      const result = await remoteExec(control, host, params.command, {
        cwd: params.cwd ?? rememberedCwd,
        timeoutSeconds: params.timeout ?? DEFAULT_TIMEOUT_SECONDS,
        signal,
        onOutput: (chunk, stream) => {
          if (stream !== lastStream) {
            if (streamed && !streamed.endsWith("\n")) streamed += "\n";
            streamed += `[${stream}]\n`;
            lastStream = stream;
          }
          streamed = (streamed + chunk).slice(-8192);
          schedulePreview();
        },
      });
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
      }
      let clearedCwd = false;
      if (rememberedCwd && result.cwdFailed) {
        cwds.delete(host);
        pi.appendEntry(CWD_ENTRY, { host, cwd: null });
        clearedCwd = true;
      } else {
        remember(host, result.cwd);
      }
      publish(ctx);
      let text = formatResult(host, result);
      if (clearedCwd)
        text += `\n[Remembered cwd was unavailable and has been cleared: ${rememberedCwd}]`;
      const failed =
        result.connectFailed ||
        result.timedOut ||
        result.aborted ||
        result.exitCode !== 0;
      return {
        content: [{ type: "text", text }],
        details: {
          host,
          exitCode: result.exitCode,
          cwd: result.cwd,
          detached: result.detached,
        },
        ...(failed ? { isError: true } : {}),
      };
    },
  });

  pi.registerTool({
    name: "remote_sync",
    label: "Remote sync",
    description:
      "Copy files between this machine and an SSH host with rsync over the same persistent connection. " +
      "Never deletes files on the destination. A relative remote path is resolved against the host's remembered working directory.",
    parameters: Type.Object({
      host: Type.String({ description: "SSH host alias from ~/.ssh/config" }),
      direction: StringEnum(["push", "pull"] as const, {
        description: "push: local to remote. pull: remote to local.",
      }),
      local: Type.String({
        description:
          "Local path, relative to the Pi working directory. A trailing / copies directory contents, as in rsync.",
      }),
      remote: Type.String({
        description: "Remote path. `~` is expanded on the remote.",
      }),
      exclude: Type.Optional(
        Type.Array(Type.String(), { description: "rsync --exclude patterns" }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: `Seconds before rsync is stopped (default ${SYNC_TIMEOUT_SECONDS}). Partial transfers can be resumed by retrying.`,
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const host = checkAlias(params.host);
      const timeout = validateTimeout(params.timeout ?? SYNC_TIMEOUT_SECONDS);
      control.ensure();
      const { local, remoteSpec } = resolveSyncPaths(
        host,
        params.local,
        params.remote,
        ctx.cwd,
        cwds.get(host),
      );
      const args = [
        "-az",
        "--partial",
        "--stats",
        // rsync 3.0+: without it the remote shell would word-split every path.
        "-s",
        "-e",
        ["ssh", ...control.sshOptions(host)].join(" "),
        ...(params.exclude ?? []).flatMap((pattern) => ["--exclude", pattern]),
        "--",
        ...(params.direction === "push"
          ? [local, remoteSpec]
          : [remoteSpec, local]),
      ];
      const output = await new Promise<{
        code: number | null;
        text: string;
        timedOut: boolean;
        aborted: boolean;
      }>((resolveRun, reject) => {
        const child = execFile(
          "rsync",
          args,
          { timeout: timeout * 1000, signal, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const text = `${stdout}${stderr}`.trim();
            if (!error) {
              resolveRun({ code: 0, text, timedOut: false, aborted: false });
            } else if ("code" in error && typeof error.code === "number") {
              resolveRun({
                code: error.code,
                text,
                timedOut: false,
                aborted: false,
              });
            } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              reject(new Error("rsync is not installed on this machine"));
            } else {
              resolveRun({
                code: null,
                text: `${text}${text ? "\n" : ""}${error.message}`,
                timedOut: Boolean(error.killed) && !signal?.aborted,
                aborted: signal?.aborted ?? false,
              });
            }
          },
        );
        child.stdin?.end();
      });
      publish(ctx);
      const preview = truncateTail(output.text);
      const syncText = preview.truncated
        ? `${preview.content}\n[Full output: ${spill(output.text)}]`
        : output.text;
      const status =
        output.code === 0
          ? "ok"
          : output.aborted
            ? "aborted; partial files kept, retry to resume"
            : output.timedOut
              ? `timed out after ${timeout}s; partial files kept, retry to resume`
              : `exit ${output.code ?? "unknown"}`;
      return {
        content: [
          {
            type: "text",
            text: `${syncText}\n[rsync ${params.direction} ${host}: ${status}]`.trim(),
          },
        ],
        details: {
          host,
          exitCode: output.code,
          timedOut: output.timedOut,
          aborted: output.aborted,
        },
        ...(output.code === 0 ? {} : { isError: true }),
      };
    },
  });

  pi.registerCommand("remote", {
    description:
      "List connections or jobs, refresh, or disconnect SSH connections that Pi opened for the remote tools",
    getArgumentCompletions: (prefix) => {
      const [verb = "", arg] = prefix.split(" ");
      if (arg === undefined) {
        const matches = [
          "list",
          "jobs",
          "refresh",
          "close",
          "close all",
          "disconnect",
          "disconnect all",
        ].filter((v) => v.startsWith(prefix));
        return matches.length
          ? matches.map((value) => ({ value, label: value }))
          : null;
      }
      if (verb !== "close" && verb !== "disconnect") return null;
      const matches = control.aliases().filter((a) => a.startsWith(arg));
      return matches.length
        ? matches.map((a) => ({ value: `${verb} ${a}`, label: a }))
        : null;
    },
    handler: async (args, ctx) => {
      const [verb = "list", target] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (verb === "jobs") {
          ctx.ui.notify(await jobs(), "info");
          return;
        }
        if (verb === "refresh") {
          const removed = await control.pruneStale();
          publish(ctx);
          ctx.ui.notify(
            removed.length
              ? `Removed stale sockets: ${removed.join(", ")}`
              : "No stale sockets. Live connections left unchanged.",
            "info",
          );
          return;
        }
        if (verb === "close" || verb === "disconnect") {
          const targets =
            target === "all"
              ? control.aliases()
              : target
                ? [checkAlias(target)]
                : [];
          if (!targets.length) {
            ctx.ui.notify(
              target
                ? "Nothing to disconnect."
                : `Usage: /remote ${verb} <host|all>`,
              "info",
            );
            return;
          }
          const outcomes = await Promise.allSettled(
            targets.map((alias) => control.close(alias)),
          );
          const lines = outcomes.map(
            (outcome, index) =>
              `${targets[index]}: ${outcome.status === "fulfilled" ? outcome.value : (outcome.reason as Error).message}`,
          );
          publish(ctx);
          ctx.ui.notify(
            lines.join("\n"),
            outcomes.some((outcome) => outcome.status === "rejected")
              ? "warning"
              : "info",
          );
          return;
        }
        if (verb !== "list")
          throw new Error(
            "Usage: /remote [list] | /remote refresh | /remote jobs | /remote disconnect <host|all>",
          );
        const aliases = control.aliases();
        if (!aliases.length) {
          publish(ctx);
          ctx.ui.notify(
            `No connections opened by Pi.\nControl directory: ${control.dir}`,
            "info",
          );
          return;
        }
        const rows = await Promise.all(
          aliases.map(async (alias) => {
            let state: string;
            try {
              const pid = await control.check(alias);
              state = pid ? `● master pid ${pid}` : "○ stale socket";
            } catch (error) {
              state = `unknown: ${error instanceof Error ? error.message : String(error)}`;
            }
            const cwd = cwds.get(alias);
            return `${alias}  ${state}${cwd ? `  cwd ${cwd}` : ""}`;
          }),
        );
        publish(ctx);
        ctx.ui.notify(
          `${rows.join("\n")}\nIdle masters exit after ${CONTROL_PERSIST}. Use /remote disconnect <host|all> after renaming a host or to close it now. Control directory: ${control.dir}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
}
