import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { Capture } from "../src/capture.ts";
import { buildRemoteCommand, parseStderr } from "../src/script.ts";

for (const background of [false, true])
  test(`supervisor cancels TERM-resistant job (background=${background})`, async () => {
    // Without cancellation the sentinel appears after 3 s; never leave an unbounded test job.
    const job = `bash -c 'trap "" TERM; echo ready; sleep 3; echo survived'${background ? " &" : ""}`;
    const script = buildRemoteCommand(job, undefined, background ? 0.6 : 8);
    const child = spawn("sh", ["-c", script.remoteCommand]);
    const closed = once(child, "close");
    let out = "",
      err = "";
    child.stdout.on("data", (data) => {
      out += data;
      if (!background && out.includes("ready")) child.stdin.end("!");
    });
    child.stderr.on("data", (data) => {
      err += data;
    });
    assert.equal((await closed)[0], 124);
    assert.equal(out, "ready\n");
    assert.ok(err.includes(`${script.nonce} STOP`));
    const pid = parseStderr("ssh banner\n" + err, script.nonce).pid;
    assert.ok(pid);
  });

test("supervisor reports a background child holding pipes instead of timing out", async () => {
  const script = buildRemoteCommand("sleep 2 & echo main", undefined, 8);
  const started = Date.now();
  const child = spawn("sh", ["-c", script.remoteCommand]);
  const closed = once(child, "close");
  let out = "",
    err = "";
  child.stdout.on("data", (data) => {
    out += data;
  });
  child.stderr.on("data", (data) => {
    err += data;
  });
  assert.equal((await closed)[0], 0);
  assert.equal(out, "main\n");
  assert.ok(parseStderr(err, script.nonce).detached);
  assert.ok(Date.now() - started < 1900);
});

test("capture text never starts on a partial UTF-8 sequence", () => {
  const capture = new Capture();
  capture.tail = Buffer.from("汉").subarray(1);
  assert.equal(capture.text, "");
});

test("capture saves complete output while retaining only a bounded tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cache-test-"));
  const capture = new Capture(dir);
  const chunk = Buffer.alloc(65536, 65);
  for (let i = 0; i < 32; i++) capture.add(chunk);
  capture.close();
  assert.ok(capture.file);
  try {
    assert.ok(capture.tail.length <= 51200);
    assert.deepEqual(
      readFileSync(capture.file),
      Buffer.alloc(32 * chunk.length, 65),
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
