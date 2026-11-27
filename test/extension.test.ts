import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { registerRemote, resolveSyncPaths } from "../src/extension.ts";

interface Tool {
  name: string;
  parameters: { required?: string[] };
  execute: (
    ...args: unknown[]
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}
interface Command {
  handler: (args: string, ctx: unknown) => Promise<void>;
  getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null;
}
type Entry = { type: string; customType: string; data: unknown };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-remote-test-"));
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const entries: Entry[] = [];
  let branch: Entry[] = entries;
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) =>
      commands.set(name, command),
    on: (event: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(event, handler),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
  };
  registerRemote(pi as never, { controlDir: join(dir, "ctl") });
  const notes: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const ctx = {
    cwd: dir,
    sessionManager: { getEntries: () => entries, getBranch: () => branch },
    ui: {
      notify: (message: string, level: string) =>
        notes.push({ message, level }),
      setStatus: (_key: string, text?: string) => statuses.push(text),
    },
  };
  return {
    dir,
    tools,
    commands,
    handlers,
    entries,
    notes,
    statuses,
    ctx,
    setBranch: (value: Entry[]) => {
      branch = value;
    },
    cleanup: () => {
      handlers.get("session_shutdown")?.({}, ctx);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("registers remote, remote_sync, remote_job and /remote", () => {
  const t = setup();
  try {
    assert.deepEqual([...t.tools.keys()].sort(), [
      "remote",
      "remote_job",
      "remote_sync",
    ]);
    assert.deepEqual(t.tools.get("remote")!.parameters.required?.sort(), [
      "command",
      "host",
    ]);
    assert.ok(t.commands.has("remote"));
    assert.deepEqual(
      t.commands
        .get("remote")!
        .getArgumentCompletions("dis")!
        .map((c) => c.value),
      ["disconnect", "disconnect all"],
    );
  } finally {
    t.cleanup();
  }
});

test("remote rejects an option-like host alias before spawning ssh", async () => {
  const t = setup();
  try {
    await assert.rejects(
      t.tools
        .get("remote")!
        .execute(
          "id",
          { host: "-oProxyCommand=touch /tmp/x", command: "true" },
          undefined,
          undefined,
          t.ctx,
        ),
      /Invalid SSH host alias/,
    );
  } finally {
    t.cleanup();
  }
});

test("/remote reports an empty control directory and refresh is a no-op", async () => {
  const t = setup();
  try {
    await t.commands.get("remote")!.handler("", t.ctx);
    assert.match(t.notes.at(-1)!.message, /No connections opened by Pi/);
    await t.commands.get("remote")!.handler("refresh", t.ctx);
    assert.match(t.notes.at(-1)!.message, /No stale sockets/);
  } finally {
    t.cleanup();
  }
});

test("/remote disconnect rejects bad aliases, reports missing hosts and removes stale sockets", async () => {
  const t = setup();
  try {
    await t.commands.get("remote")!.handler("disconnect -oFoo", t.ctx);
    assert.equal(t.notes.at(-1)!.level, "error");
    await t.commands.get("remote")!.handler("close all", t.ctx);
    assert.match(t.notes.at(-1)!.message, /Nothing to disconnect/);
    await t.commands.get("remote")!.handler("bogus", t.ctx);
    assert.match(t.notes.at(-1)!.message, /Usage/);

    mkdirSync(join(t.dir, "ctl"), { recursive: true });
    const socket = join(t.dir, "ctl", "renamed-old-host");
    execFileSync("python3", [
      "-c",
      `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(socket)})`,
    ]);
    await t.commands
      .get("remote")!
      .handler("disconnect renamed-old-host", t.ctx);
    assert.match(t.notes.at(-1)!.message, /stale socket removed/);
    assert.equal(existsSync(socket), false);
  } finally {
    t.cleanup();
  }
});

test("session_start and session_tree restore cwd only from the active branch", async () => {
  const t = setup();
  try {
    const old: Entry = {
      type: "custom",
      customType: "remote-cwd",
      data: { host: "h1", cwd: "/data/old" },
    };
    const current: Entry = {
      type: "custom",
      customType: "remote-cwd",
      data: { host: "h1", cwd: "/data/x" },
    };
    t.entries.push(old, current);
    t.setBranch([current]);
    await t.handlers.get("session_start")!({}, t.ctx);
    assert.equal(t.statuses.at(-1), undefined);
    // A leftover socket file makes h1 listable without a live master.
    mkdirSync(join(t.dir, "ctl"), { recursive: true });
    const server = createServer((socket) => socket.destroy()).listen(
      join(t.dir, "ctl", "h1"),
    );
    await once(server, "listening");
    try {
      await t.commands.get("remote")!.handler("list", t.ctx);
      assert.match(
        t.notes.at(-1)!.message,
        /h1 +unknown:[\s\S]*cwd \/data\/x\n/,
      );
      t.setBranch([old]);
      await t.handlers.get("session_tree")!({}, t.ctx);
      await t.commands.get("remote")!.handler("list", t.ctx);
      assert.match(t.notes.at(-1)!.message, /cwd \/data\/old\n/);
      t.setBranch([]);
      await t.handlers.get("session_tree")!({}, t.ctx);
      await t.commands.get("remote")!.handler("list", t.ctx);
      assert.doesNotMatch(t.notes.at(-1)!.message, /cwd \/data\//);
    } finally {
      server.close();
    }
  } finally {
    t.cleanup();
  }
});

test("remote_sync path mapping preserves trailing slash, ~ and remembered cwd", () => {
  assert.deepEqual(
    resolveSyncPaths("h", "src/", "~/a b", "/work", "/remote/base"),
    { local: "/work/src/", remoteSpec: "h:./a b" },
  );
  assert.deepEqual(
    resolveSyncPaths("h", "/tmp/x", "relative/file", "/work", "/remote/base"),
    { local: "/tmp/x", remoteSpec: "h:/remote/base/relative/file" },
  );
  assert.deepEqual(
    resolveSyncPaths("h", ".", "/absolute/file", "/work", "/remote/base"),
    { local: "/work", remoteSpec: "h:/absolute/file" },
  );
});

test("remote_sync reports its configured timeout and resume behavior", async () => {
  const t = setup();
  const oldPath = process.env.PATH;
  try {
    const bin = join(t.dir, "bin");
    mkdirSync(bin);
    const rsync = join(bin, "rsync");
    writeFileSync(rsync, "#!/bin/sh\nexec sleep 5\n", { mode: 0o700 });
    process.env.PATH = `${bin}:${oldPath}`;
    const remoteSync = t.tools.get("remote_sync")!;
    const result = await remoteSync.execute(
      "id",
      {
        host: "h1",
        direction: "push",
        local: "source",
        remote: "/tmp/dest",
        timeout: 0.05,
      },
      undefined,
      undefined,
      t.ctx,
    );
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /timed out after 0\.05s; partial files kept, retry to resume/,
    );
  } finally {
    process.env.PATH = oldPath;
    t.cleanup();
  }
});

test("remote_job list skips corrupt records and forget removes only valid local metadata", async () => {
  const t = setup();
  try {
    const jobsDir = join(t.dir, "remote-jobs");
    mkdirSync(jobsDir, { recursive: true });
    const corrupt = `${randomUUID()}.json`;
    writeFileSync(join(jobsDir, corrupt), "{broken");
    const execute = t.tools.get("remote_job")!.execute;
    const listed = await execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      t.ctx,
    );
    assert.match(listed.content[0].text, /ignored invalid job record/);

    const id = randomUUID();
    const record = join(jobsDir, `${id}.json`);
    writeFileSync(
      record,
      JSON.stringify({ id, host: "h1", name: "done", backend: "process" }),
    );
    const forgotten = await execute(
      "id",
      { action: "forget", id },
      undefined,
      undefined,
      t.ctx,
    );
    assert.match(forgotten.content[0].text, /Remote work was not cancelled/);
    assert.equal(existsSync(record), false);
    assert.equal(existsSync(join(jobsDir, corrupt)), true);
  } finally {
    t.cleanup();
  }
});

/** Route ssh through a local shell so the wrapper protocol runs end to end. */
async function withLocalSsh<T>(
  t: ReturnType<typeof setup>,
  run: () => Promise<T>,
): Promise<T> {
  const bin = join(t.dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ssh"), '#!/bin/bash\nexec sh -c "${!#}"\n', {
    mode: 0o700,
  });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    return await run();
  } finally {
    process.env.PATH = oldPath;
  }
}

test("remote clears a remembered cwd only when the wrapper reports it missing", async () => {
  const t = setup();
  try {
    const remote = t.tools.get("remote")!;
    const gone = join(t.dir, "gone");
    mkdirSync(gone);
    await withLocalSsh(t, () =>
      remote.execute(
        "id",
        { host: "h1", command: "pwd", cwd: gone },
        undefined,
        undefined,
        t.ctx,
      ),
    );
    rmSync(gone, { recursive: true, force: true });
    const afterMissing = await withLocalSsh(t, () =>
      remote.execute(
        "id",
        { host: "h1", command: "pwd" },
        undefined,
        undefined,
        t.ctx,
      ),
    );
    assert.match(
      afterMissing.content[0].text,
      /remembered cwd was unavailable and has been cleared: .*gone/i,
    );
    assert.deepEqual(
      t.entries.filter((entry) => entry.customType === "remote-cwd").at(-1)
        ?.data,
      { host: "h1", cwd: null },
    );
  } finally {
    t.cleanup();
  }
});

test("remote keeps a remembered cwd when a command resets traps and exits 97", async () => {
  const t = setup();
  try {
    const remote = t.tools.get("remote")!;
    await withLocalSsh(t, () =>
      remote.execute(
        "id",
        { host: "h1", command: "pwd", cwd: "/tmp" },
        undefined,
        undefined,
        t.ctx,
      ),
    );
    const own = await withLocalSsh(t, () =>
      remote.execute(
        "id",
        { host: "h1", command: "trap - EXIT; exit 97" },
        undefined,
        undefined,
        t.ctx,
      ),
    );
    assert.equal(own.isError, true);
    assert.match(own.content[0].text, /exit 97/);
    assert.doesNotMatch(own.content[0].text, /has been cleared/);
    const next = await withLocalSsh(t, () =>
      remote.execute(
        "id",
        { host: "h1", command: "pwd" },
        undefined,
        undefined,
        t.ctx,
      ),
    );
    assert.match(next.content[0].text, /cwd \/tmp/);
  } finally {
    t.cleanup();
  }
});

test("remote_sync works with an rsync that rejects modern options", async () => {
  const t = setup();
  const oldPath = process.env.PATH;
  try {
    const bin = join(t.dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "rsync"),
      `#!/bin/bash
for arg in "$@"; do
  case $arg in
    --info*|--protect-args*) echo "rsync: $arg: unknown option" >&2; exit 1 ;;
  esac
done
echo "sent"
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}:${oldPath}`;
    const result = await t.tools
      .get("remote_sync")!
      .execute(
        "id",
        { host: "h1", direction: "push", local: "source", remote: "/tmp/dest" },
        undefined,
        undefined,
        t.ctx,
      );
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /sent/);
  } finally {
    process.env.PATH = oldPath;
    t.cleanup();
  }
});

test("remote and remote_sync reject the same invalid timeouts", async () => {
  const t = setup();
  try {
    for (const timeout of [0, -1, Number.NaN, 3_000_000]) {
      await assert.rejects(
        t.tools
          .get("remote")!
          .execute(
            "id",
            { host: "h1", command: "true", timeout },
            undefined,
            undefined,
            t.ctx,
          ),
        /Invalid timeout/,
        `remote accepted timeout ${timeout}`,
      );
      await assert.rejects(
        t.tools.get("remote_sync")!.execute(
          "id",
          {
            host: "h1",
            direction: "push",
            local: "a",
            remote: "b",
            timeout,
          },
          undefined,
          undefined,
          t.ctx,
        ),
        /Invalid timeout/,
        `remote_sync accepted timeout ${timeout}`,
      );
    }
  } finally {
    t.cleanup();
  }
});

test("remote_job list still works when many jobs are registered", async () => {
  const t = setup();
  try {
    const jobsDir = join(t.dir, "remote-jobs");
    mkdirSync(jobsDir, { recursive: true });
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = randomUUID();
      ids.push(id);
      writeFileSync(
        join(jobsDir, `${id}.json`),
        JSON.stringify({ id, host: "h1", name: `job-${i}`, backend: "slurm" }),
      );
    }
    const listed = await withLocalSsh(t, () =>
      t.tools
        .get("remote_job")!
        .execute("id", { action: "list" }, undefined, undefined, t.ctx),
    );
    const text = listed.content[0].text;
    assert.doesNotMatch(text, /exceeds/);
    for (const id of ids) assert.match(text, new RegExp(id));
    // Every job reached the remote side; a batch that overflows the command
    // limit would instead report the encode error once per host.
    const queried = text
      .split("\n")
      .filter((line) => line.endsWith("unknown: status command exited 1"));
    assert.equal(queried.length, 200);
  } finally {
    t.cleanup();
  }
});

test("remote_job list shows the newest registration first", async () => {
  const t = setup();
  try {
    const jobsDir = join(t.dir, "remote-jobs");
    mkdirSync(jobsDir, { recursive: true });
    const older = randomUUID();
    const newer = randomUUID();
    for (const [id, name] of [
      [older, "older"],
      [newer, "newer"],
    ] as const)
      writeFileSync(
        join(jobsDir, `${id}.json`),
        JSON.stringify({ id, host: "h1", name, backend: "slurm" }),
      );
    const past = new Date(Date.now() - 60_000);
    execFileSync("touch", [
      "-m",
      "-d",
      past.toISOString(),
      join(jobsDir, `${older}.json`),
    ]);
    const listed = await withLocalSsh(t, () =>
      t.tools
        .get("remote_job")!
        .execute("id", { action: "list" }, undefined, undefined, t.ctx),
    );
    const order = listed.content[0].text
      .split("\n")
      .map((line) => line.split(/\s+/)[1]);
    assert.deepEqual(order, ["newer", "older"]);
  } finally {
    t.cleanup();
  }
});

test("remote explains a missing ssh binary instead of reporting a spawn error", async () => {
  const t = setup();
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    await assert.rejects(
      t.tools
        .get("remote")!
        .execute(
          "id",
          { host: "h1", command: "true" },
          undefined,
          undefined,
          t.ctx,
        ),
      /ssh is not installed on this machine/,
    );
  } finally {
    process.env.PATH = oldPath;
    t.cleanup();
  }
});

test("remote throttles preview updates and still shows the final output", async () => {
  const t = setup();
  try {
    const previews: string[] = [];
    const result = await withLocalSsh(t, () =>
      t.tools.get("remote")!.execute(
        "id",
        {
          host: "h1",
          command: "for i in $(seq 200); do echo line-$i; sleep 0.003; done",
        },
        undefined,
        (update: { content: Array<{ text: string }> }) =>
          previews.push(update.content[0].text),
        t.ctx,
      ),
    );
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /line-200/);
    assert.ok(previews.length > 0, "expected at least one preview update");
    assert.ok(
      previews.length < 50,
      `expected throttled updates, got ${previews.length}`,
    );
  } finally {
    t.cleanup();
  }
});
