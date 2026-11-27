import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  buildRemoteCommand,
  checkAlias,
  parseStderr,
  remotePath,
} from "../src/script.ts";

/** Run the wrapped command through a local login-shell-like `sh -c`, as sshd would. */
function runLocally(
  command: string,
  cwd?: string,
): { stdout: string; stderr: string; code: number; nonce: string } {
  const script = buildRemoteCommand(command, cwd);
  try {
    const stdout = execFileSync("sh", ["-c", script.remoteCommand], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", code: 0, nonce: script.nonce };
  } catch (error) {
    const e = error as { stdout: string; stderr: string; status: number };
    return {
      stdout: e.stdout,
      stderr: e.stderr,
      code: e.status,
      nonce: script.nonce,
    };
  }
}

test("checkAlias accepts config aliases and rejects option or path injection", () => {
  for (const alias of [
    "cluster-node-19",
    "example-host",
    "测试跳板机-root",
    ".edge-root",
  ])
    assert.equal(checkAlias(alias), alias);
  for (const alias of [
    "-oProxyCommand=x",
    "a b",
    "a/b",
    "a:b",
    "",
    "x'y",
    "a%h",
  ])
    assert.throws(() => checkAlias(alias));
});

test("quoting, cwd and markers survive the wrapper", () => {
  const command = `cd /tmp\nprintf '%s|' "it's" '$HOME' "a\\"b"\necho err >&2\nexit 3`;
  const run = runLocally(command);
  assert.equal(run.code, 3);
  assert.equal(run.stdout, `it's|$HOME|a"b|`);
  const parsed = parseStderr(run.stderr, run.nonce);
  assert.equal(parsed.stderr, "err\n");
  assert.equal(parsed.cwd, "/tmp");
  assert.ok(parsed.pid && parsed.pid > 0);
});

test("cwd argument applies, ~ expands, and a missing directory fails with 97", () => {
  assert.equal(runLocally("pwd", "/usr").stdout.trim(), "/usr");
  assert.equal(runLocally("pwd", "~").stdout.trim(), process.env.HOME);
  assert.equal(remotePath("~/a b"), `"$HOME"'/a b'`);
  const missing = runLocally("pwd", "/nonexistent-pi-remote");
  assert.equal(missing.code, 97);
  assert.equal(parseStderr(missing.stderr, missing.nonce).cwd, undefined);
});

test("commands cannot read the script from stdin, and output lacking markers is left alone", () => {
  assert.equal(runLocally("cat; echo done").stdout, "done\n");
  assert.deepEqual(parseStderr("plain\n", "__PI_REMOTE_x__"), {
    stderr: "plain\n",
  });
});

test("oversized commands are rejected before reaching ssh", () => {
  assert.throws(() => buildRemoteCommand("x".repeat(70 * 1024)), /exceeds/);
});
