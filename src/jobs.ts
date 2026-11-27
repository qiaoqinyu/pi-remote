import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ControlDir, remoteExec } from "./ssh.ts";
import { checkAlias, shQuote } from "./script.ts";

type Backend = "slurm" | "process";
interface Job {
  id: string;
  host: string;
  name: string;
  backend: Backend;
}
type Action = "status" | "logs" | "cancel";

const worker = `import os,signal,subprocess,sys,time
d, command = sys.argv[1:]
p = subprocess.Popen(['bash','-c',command],start_new_session=True)
cancelled = False
while p.poll() is None:
    if os.path.exists(d+'/cancel'):
        cancelled = True
        try:
            os.killpg(p.pid,signal.SIGTERM)
            time.sleep(1)
            os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        break
    time.sleep(0.5)
code=p.wait()
with open(d+'/result.tmp','w') as f: print('cancelled' if cancelled else ('completed' if code==0 else 'failed'),code,file=f)
os.replace(d+'/result.tmp',d+'/result')`;

export function jobCommand(job: Job, action: Action | "submit", input = "") {
  const pre = `set -euo pipefail\numask 077\nd="$HOME/.local/state/pi-remote/jobs/${job.id}"\n`;
  if (action === "submit") {
    const setup = 'mkdir -p -- "${d%/*}"; mkdir -- "$d"\n';
    if (job.backend === "process") {
      return (
        pre +
        setup +
        `nohup python3 -c ${shQuote(worker)} "$d" ${shQuote(input)} </dev/null >"$d/output.log" 2>&1 &\nprintf '%s\\n' "$!" >"$d/worker"`
      );
    }
    return (
      pre +
      setup +
      `sbatch --parsable --output="$d/output.log" --error="$d/error.log" -- ${shQuote(input)} >"$d/slurm"; cat "$d/slurm"`
    );
  }
  if (action === "logs") {
    return (
      pre +
      (job.backend === "slurm"
        ? 'for f in "$d/output.log" "$d/error.log"; do if test -f "$f"; then tail -n 100 -- "$f"; fi; done; test -f "$d/output.log" || test -f "$d/error.log"'
        : 'tail -n 100 -- "$d/output.log"')
    );
  }
  if (job.backend === "slurm") {
    // Positional parameters, not an array: `"${opts[@]}"` on an empty array is an
    // unbound-variable error under `set -u` in bash before 4.4 (RHEL/CentOS 7).
    const id = `IFS=';' read -r jid cluster <"$d/slurm"; [[ $jid =~ ^[0-9]+$ ]]; set --; if [[ -n $cluster ]]; then set -- -M "$cluster"; fi\n`;
    return (
      pre +
      id +
      (action === "cancel"
        ? 'scancel "$@" "$jid"; echo "cancel requested: $jid"'
        : 'state=$(squeue "$@" -h -j "$jid" -o %T 2>/dev/null) || state=\'\'; if [[ -z $state ]]; then state=$(sacct "$@" -Xnj "$jid" -o State -P); fi; printf \'%s %s\\n\' "$jid" "${state:-unknown}"')
    );
  }
  if (action === "cancel") {
    return (
      pre +
      'if test -f "$d/result"; then cat "$d/result"; else touch "$d/cancel"; echo "cancel requested"; fi'
    );
  }
  return (
    pre +
    `if test -f "$d/result"; then cat "$d/result"; elif test -r "$d/worker" && grep -Fzxq -- "$d" "/proc/$(cat "$d/worker")/cmdline" 2>/dev/null; then echo running; else echo unknown; fi`
  );
}

function marker(job: Job): string {
  return `__PI_REMOTE_JOB_${job.id}__`;
}

/** sshd rejects one argv string beyond 128 KiB, so keep batches well below it. */
const STATUS_BATCH_BYTES = 32 * 1024;

function statusCommand(jobs: Job[]): string {
  return jobs
    .map(
      (job) =>
        `printf '%s\\n' ${shQuote(marker(job))}\n( ${jobCommand(job, "status")} ) || printf 'unknown: status command exited %s\\n' "$?"`,
    )
    .join("\n");
}

/** Group jobs so one SSH call's script stays inside the command size limit. */
function statusBatches(jobs: Job[]): Job[][] {
  const batches: Job[][] = [];
  let current: Job[] = [];
  let bytes = 0;
  for (const job of jobs) {
    const size = statusCommand([job]).length + 1;
    if (current.length && bytes + size > STATUS_BATCH_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(job);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function parseStates(stdout: string, jobs: Job[]): Map<string, string> {
  const markers = new Map(jobs.map((job) => [marker(job), job.id]));
  const states = new Map<string, string[]>(jobs.map((job) => [job.id, []]));
  let current: string | undefined;
  for (const line of stdout.split("\n")) {
    const marked = markers.get(line.trim());
    if (marked) current = marked;
    else if (current) states.get(current)?.push(line);
  }
  return new Map(
    jobs.map((job) => [
      job.id,
      states.get(job.id)?.join("\n").trim() || "unknown",
    ]),
  );
}

export function registerJobs(
  pi: ExtensionAPI,
  control: ControlDir,
  dir: string,
  cwds: Map<string, string>,
) {
  function records(): { jobs: Job[]; warnings: string[] } {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const jobs: Job[] = [];
    const warnings: string[] = [];
    // Newest first: the job to look at is almost always the one just submitted.
    const names = readdirSync(dir)
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => {
        try {
          return { name, mtime: statSync(join(dir, name)).mtimeMs };
        } catch {
          return { name, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const { name } of names) {
      try {
        const job = JSON.parse(readFileSync(join(dir, name), "utf8")) as Job;
        if (
          job.id + ".json" !== name ||
          !["process", "slurm"].includes(job.backend) ||
          typeof job.name !== "string"
        ) {
          throw new Error("invalid fields");
        }
        checkAlias(job.host);
        jobs.push(job);
      } catch (error) {
        warnings.push(
          `${name}: ignored invalid job record (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    return { jobs, warnings };
  }

  async function run(
    job: Job,
    action: Action | "submit",
    input?: string,
    signal?: AbortSignal,
  ) {
    const result = await remoteExec(
      control,
      job.host,
      jobCommand(job, action, input),
      {
        timeoutSeconds: 30,
        signal,
        cwd: action === "submit" ? cwds.get(job.host) : undefined,
      },
    );
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.aborted ||
      result.connectFailed
    ) {
      throw new Error(
        result.stderr.trim() ||
          `Request failed (${result.exitCode}); remote state unknown`,
      );
    }
    return result.stdout.trim();
  }

  /** One SSH call per batch, so a long job list cannot overflow the command. */
  async function batchStatus(
    host: string,
    jobs: Job[],
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    for (const batch of statusBatches(jobs)) {
      const result = await remoteExec(control, host, statusCommand(batch), {
        timeoutSeconds: Math.min(300, 30 + batch.length * 10),
        signal,
      });
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.aborted ||
        result.connectFailed
      ) {
        throw new Error(
          result.stderr.trim() || `Status request failed (${result.exitCode})`,
        );
      }
      for (const [id, state] of parseStates(result.stdout, batch))
        states.set(id, state);
    }
    return states;
  }

  async function list(signal?: AbortSignal) {
    const { jobs, warnings } = records();
    const groups = new Map<string, Job[]>();
    for (const job of jobs) {
      const group = groups.get(job.host) ?? [];
      group.push(job);
      groups.set(job.host, group);
    }
    const states = new Map<string, string>();
    await Promise.all(
      [...groups].map(async ([host, hostJobs]) => {
        try {
          const hostStates = await batchStatus(host, hostJobs, signal);
          for (const [id, state] of hostStates) states.set(id, state);
        } catch (error) {
          for (const job of hostJobs)
            states.set(job.id, `unknown: ${String(error)}`);
        }
      }),
    );
    const lines = jobs.map(
      (job) =>
        `${job.id}  ${job.name}  ${job.host}  ${job.backend}  ${states.get(job.id) ?? "unknown"}`,
    );
    return (
      [...warnings.map((warning) => `[warning] ${warning}`), ...lines].join(
        "\n",
      ) || "No registered jobs."
    );
  }

  pi.registerTool({
    name: "remote_job",
    label: "Remote job",
    description:
      "Submit and track long-running jobs. Choose slurm explicitly for existing sbatch scripts " +
      "(stdout/stderr routed to private job logs); process for detached Linux shell commands. " +
      "No automatic fallback. Logs reads the remote tail only. Forget removes only the local registration and never cancels remote work.",
    promptSnippet: "Submit, list, inspect or cancel durable remote tasks by ID",
    parameters: Type.Object({
      action: StringEnum(
        ["submit", "list", "status", "logs", "cancel", "forget"] as const,
        {
          description:
            "Operation. forget deletes only the local job record; cancel remote work first if needed.",
        },
      ),
      host: Type.Optional(
        Type.String({
          description:
            "SSH host alias from ~/.ssh/config; required for submit.",
        }),
      ),
      backend: Type.Optional(
        StringEnum(["slurm", "process"] as const, {
          description: "Required for submit; no automatic fallback.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description: "Human-readable job name; required for submit.",
        }),
      ),
      input: Type.Optional(
        Type.String({
          description:
            "Remote sbatch script path or detached shell command; required for submit.",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Job UUID returned by submit; required for status, logs, cancel and forget.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      let text: string;
      if (params.action === "list") {
        text = await list(signal);
      } else if (params.action === "submit") {
        if (!params.host || !params.backend || !params.input || !params.name) {
          throw new Error("submit requires host, backend, name and input");
        }
        if (params.backend !== "slurm" && params.backend !== "process")
          throw new Error("Invalid backend");
        const job: Job = {
          id: randomUUID(),
          host: checkAlias(params.host),
          backend: params.backend,
          name: params.name,
        };
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, `${job.id}.json`), JSON.stringify(job), {
          mode: 0o600,
          flag: "wx",
        });
        try {
          text = `Submitted ${job.name}: ${job.id} ${await run(job, "submit", params.input, signal)}`;
        } catch (error) {
          throw new Error(
            `Submission not confirmed. Check ${job.id} before retrying: ${String(error)}`,
          );
        }
      } else {
        const { jobs } = records();
        const job = jobs.find((job) => job.id === params.id);
        if (!job) throw new Error("Unknown job ID");
        if (params.action === "forget") {
          unlinkSync(join(dir, `${job.id}.json`));
          text = `Forgot ${job.name}: ${job.id}. Remote work was not cancelled; local metadata only was removed.`;
        } else if (
          params.action === "status" ||
          params.action === "logs" ||
          params.action === "cancel"
        ) {
          text = await run(job, params.action, undefined, signal);
        } else {
          throw new Error("Unsupported job action");
        }
      }
      return { content: [{ type: "text", text }], details: {} };
    },
  });
  return list;
}
