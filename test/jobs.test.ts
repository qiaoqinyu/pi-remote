import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isTerminalState, jobCommand } from "../src/jobs.ts";

test("detached task records exit code and limits the log query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-job-test-"));
  const job = {
    id: randomUUID(),
    host: "test",
    name: "example",
    backend: "process" as const,
  };
  const run = (action: "submit" | "logs" | "status") =>
    execFileSync("bash", ["-c", jobCommand(job, action, "seq 150; exit 7")], {
      env: { ...process.env, HOME: dir },
      encoding: "utf8",
    }).trim();
  try {
    run("submit");
    for (let i = 0; i < 30 && !run("status").startsWith("failed"); i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(run("status"), "failed 7");
    const lines = run("logs").split("\n");
    assert.equal(lines.length, 100);
    assert.equal(lines[0], "51");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

function withSlurmStubs<T>(
  dir: string,
  run: (run: (action: "status" | "cancel") => string) => T,
): T {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [
    ["squeue", 'printf "%s" "$*" >"$HOME/squeue.args"\nexit 1'],
    ["sacct", 'printf "%s" "$*" >"$HOME/sacct.args"\nprintf "COMPLETED\\n"'],
    ["scancel", 'printf "%s" "$*" >"$HOME/scancel.args"'],
  ] as const)
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  return run((action) =>
    execFileSync("bash", ["-c", jobCommand(SLURM_JOB, action)], {
      env: {
        ...process.env,
        HOME: dir,
        PATH: `${bin}:${process.env.PATH}`,
      },
      encoding: "utf8",
    }).trim(),
  );
}

const SLURM_JOB = {
  id: randomUUID(),
  host: "cluster",
  name: "train",
  backend: "slurm" as const,
};

test("slurm status and cancel read the job id and cluster from the record", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-slurm-test-"));
  const jobDir = join(
    dir,
    ".local",
    "state",
    "pi-remote",
    "jobs",
    SLURM_JOB.id,
  );
  try {
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "slurm"), "12345;clusterA\n");
    withSlurmStubs(dir, (run) => {
      assert.equal(run("status"), "12345 COMPLETED");
      assert.match(
        readFileSync(join(dir, "sacct.args"), "utf8"),
        /-M clusterA/,
      );
      assert.equal(run("cancel"), "cancel requested: 12345");
      const scancel = readFileSync(join(dir, "scancel.args"), "utf8");
      assert.match(scancel, /-M clusterA/);
      assert.match(scancel, /12345/);
    });

    // A single-cluster submission records no cluster field.
    writeFileSync(join(jobDir, "slurm"), "12345\n");
    withSlurmStubs(dir, (run) => {
      assert.equal(run("status"), "12345 COMPLETED");
      assert.doesNotMatch(readFileSync(join(dir, "sacct.args"), "utf8"), /-M/);
      assert.doesNotMatch(readFileSync(join(dir, "squeue.args"), "utf8"), /-M/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only confirmed terminal states count as finished", () => {
  for (const state of [
    "completed 0",
    "failed 7",
    "cancelled 0",
    "12345 COMPLETED",
    "12345 FAILED",
    "12345 CANCELLED by 1234",
    "12345 TIMEOUT",
    "12345 OUT_OF_MEMORY",
    "12345 NODE_FAIL",
  ])
    assert.equal(isTerminalState(state), true, state);
  for (const state of [
    "running",
    "12345 RUNNING",
    "12345 PENDING",
    "12345 COMPLETING",
    "12345 SUSPENDED",
    // A preempted job may be requeued, so its record stays.
    "12345 PREEMPTED",
    "12345 REQUEUED",
    "unknown",
    "unknown: Status request failed (255)",
    "unknown: status command exited 1",
    "",
  ])
    assert.equal(isTerminalState(state), false, state);
});
