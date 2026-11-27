import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlDir, remoteExec } from "../src/ssh.ts";

async function withFakeSsh<T>(
  mode: "passthrough" | "connect-fail" | "missing-python",
  run: () => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pi-fake-ssh-test-"));
  const fake = join(dir, "ssh");
  writeFileSync(
    fake,
    `#!/bin/bash
command="\${!#}"
case ${JSON.stringify(mode)} in
  connect-fail)
    printf '%s\\n' 'ssh: connect to host: Connection refused' >&2
    exit 255
    ;;
  missing-python)
    [[ "$command" =~ (__PI_REMOTE_[a-f0-9]+__) ]] && nonce="\${BASH_REMATCH[1]}"
    printf '%s READY\\n' "$nonce" >&2
    printf '%s\\n' 'pi-remote: python3 3.8+ is required on the remote host' >&2
    exit 96
    ;;
  *) exec sh -c "$command" ;;
esac
`,
  );
  chmodSync(fake, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    return await run();
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function controlDir(): { control: ControlDir; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-control-test-"));
  return {
    control: new ControlDir(join(dir, "ctl")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("remoteExec distinguishes SSH failure from a remote supervisor prerequisite failure", async () => {
  const t = controlDir();
  try {
    const failed = await withFakeSsh("connect-fail", () =>
      remoteExec(t.control, "host", "true", { timeoutSeconds: 5 }),
    );
    assert.equal(failed.connectFailed, true);
    assert.equal(failed.exitCode, 255);

    const missing = await withFakeSsh("missing-python", () =>
      remoteExec(t.control, "host", "true", { timeoutSeconds: 5 }),
    );
    assert.equal(missing.connectFailed, false);
    assert.equal(missing.exitCode, 96);
    assert.match(missing.stderr, /python3 3\.8\+ is required/);
    assert.doesNotMatch(missing.stderr, /READY/);
  } finally {
    t.cleanup();
  }
});

test("remoteExec streams stderr without protocol markers and preserves split UTF-8", async () => {
  const t = controlDir();
  try {
    const chunks: Array<{ text: string; stream: string }> = [];
    const result = await withFakeSsh("passthrough", () =>
      remoteExec(t.control, "host", "printf '错误\\n' >&2", {
        timeoutSeconds: 5,
        onOutput: (text, stream) => chunks.push({ text, stream }),
      }),
    );
    assert.equal(result.exitCode, 0);
    const stderr = chunks
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => chunk.text)
      .join("");
    assert.equal(stderr, "错误\n");
    assert.doesNotMatch(stderr, /__PI_REMOTE|READY|PID|CWD/);
  } finally {
    t.cleanup();
  }
});

test("cached stderr is the command's output, without wrapper markers", async () => {
  const t = controlDir();
  try {
    const lines = Array.from({ length: 2500 }, (_, i) => `e${i}`);
    const result = await withFakeSsh("passthrough", () =>
      remoteExec(t.control, "host", `printf '%s\\n' ${lines.join(" ")} >&2`, {
        timeoutSeconds: 20,
      }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.files.length, 1);
    const cached = readFileSync(result.files[0], "utf8");
    assert.doesNotMatch(cached, /__PI_REMOTE/);
    const kept = cached.split("\n").filter((line) => line !== "");
    assert.equal(kept.length, 2500);
    assert.equal(kept[0], "e0");
    assert.equal(kept.at(-1), "e2499");
  } finally {
    t.cleanup();
  }
});

test("remoteExec abort acknowledges remote process-group cancellation", async () => {
  const t = controlDir();
  try {
    const controller = new AbortController();
    const result = await withFakeSsh("passthrough", () =>
      remoteExec(t.control, "host", "trap '' TERM; echo ready; sleep 30", {
        timeoutSeconds: 30,
        signal: controller.signal,
        onOutput: (_text, stream) => {
          if (stream === "stdout") controller.abort();
        },
      }),
    );
    assert.equal(result.aborted, true);
    assert.equal(result.stopAcknowledged, true);
    assert.equal(result.exitCode, 124);
    assert.ok(result.durationMs < 5000);
  } finally {
    t.cleanup();
  }
});

test("the live preview never shows wrapper markers, including a cwd failure", async () => {
  const t = controlDir();
  try {
    const previews: string[] = [];
    const result = await withFakeSsh("passthrough", () =>
      remoteExec(t.control, "host", "pwd", {
        cwd: "/definitely/not/here",
        timeoutSeconds: 5,
        onOutput: (text) => previews.push(text),
      }),
    );
    assert.equal(result.cwdFailed, true);
    assert.equal(result.exitCode, 97);
    assert.match(previews.join(""), /No such file or directory/);
    assert.doesNotMatch(previews.join(""), /__PI_REMOTE/);
  } finally {
    t.cleanup();
  }
});
