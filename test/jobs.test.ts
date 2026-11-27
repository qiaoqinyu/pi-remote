import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { jobCommand } from "../src/jobs.ts";

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
