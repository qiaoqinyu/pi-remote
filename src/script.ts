import { randomBytes } from "node:crypto";

/** sshd hands the remote command to the login shell as one argv string; Linux caps one string at 128 KiB. */
export const MAX_COMMAND_BYTES = 64 * 1024;

/**
 * Host aliases become socket file names and rsync `host:path` specs, and rsync splits `-e` on whitespace.
 * Reject characters that would break any of those, plus a leading `-` that ssh would read as an option.
 */
export function checkAlias(alias: string): string {
  if (
    alias === "." ||
    alias === ".." ||
    !/^[^\s\x00-\x1f\x7f%/\\'":-][^\s\x00-\x1f\x7f%/\\'":]{0,63}$/u.test(alias)
  ) {
    throw new Error(`Invalid SSH host alias: ${JSON.stringify(alias)}`);
  }
  return alias;
}

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Quote a remote path, keeping a leading `~` expandable. */
export function remotePath(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"${shQuote(path.slice(1))}`;
  return shQuote(path);
}

export interface RemoteScript {
  /** Argument for `ssh host <remoteCommand>`; safe for any POSIX login shell. */
  remoteCommand: string;
  nonce: string;
}

/**
 * Wrap a command so the remote side reports its process group and final working directory on stderr.
 * The script travels base64-encoded in argv, so commands that read stdin cannot consume it.
 */
export function buildRemoteCommand(
  command: string,
  cwd?: string,
  timeoutSeconds = 120,
): RemoteScript {
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds * 1000 > 2147483647
  )
    throw new Error("Invalid timeout");
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
    throw new Error(
      `Command exceeds ${MAX_COMMAND_BYTES} bytes; copy a script with remote_sync and run it instead.`,
    );
  }
  const nonce = `__PI_REMOTE_${randomBytes(8).toString("hex")}__`;
  const lines = [
    `printf '%s PID %s\\n' '${nonce}' "$$" >&2`,
    ...(cwd === undefined ? [] : [`cd -- ${remotePath(cwd)} || exit 97`]),
    `trap 'printf "\\n%s CWD %s\\n" "${nonce}" "$PWD" >&2' EXIT`,
    command,
    "",
  ];
  const encoded = Buffer.from(lines.join("\n")).toString("base64");
  // The supervisor owns a fresh process group. SSH stdin is a cancellation channel;
  // the remote deadline still applies when the network cannot deliver cancellation.
  const supervisor = `import base64, os, select, signal, subprocess, sys, threading, time
payload, nonce, seconds = sys.argv[1:]
p = subprocess.Popen(['bash', '-c', base64.b64decode(payload), 'pi-remote'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
def forward(source, target):
    try:
        while block := os.read(source.fileno(), 65536):
            while block:
                block = block[os.write(target, block):]
    except BrokenPipeError:
        pass
    finally:
        source.close()
streams = [threading.Thread(target=forward, args=(source, fd), daemon=True) for source, fd in [(p.stdout, 1), (p.stderr, 2)]]
for stream in streams: stream.start()
deadline = time.monotonic() + float(seconds)
exited_since = None
inputs = [0]
while True:
    remaining = deadline - time.monotonic()
    ready = select.select(inputs, [], [], max(0, min(0.05, remaining)))[0]
    cancel = os.read(0, 1) if ready else None
    if cancel == b'': inputs = []
    if remaining <= 0 or cancel:
        try:
            os.killpg(p.pid, signal.SIGTERM)
            time.sleep(0.5)
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        print('\\n' + nonce + ' STOP', file=sys.stderr, flush=True)
        sys.exit(124)
    rc = p.poll()
    if rc is not None:
        if not any(stream.is_alive() for stream in streams):
            sys.exit(rc if rc >= 0 else 128 - rc)
        # A background child can inherit the pipes after the main command exits.
        # Report that state instead of waiting for the deadline and calling it a timeout.
        if exited_since is None:
            exited_since = time.monotonic()
        elif time.monotonic() - exited_since >= 1:
            print('\\n' + nonce + ' DETACHED', file=sys.stderr, flush=True)
            sys.exit(rc if rc >= 0 else 128 - rc)`;
  const remoteCommand = [
    // Distinguish an SSH failure from a remote host that cannot run the supervisor.
    `printf '%s READY\\n' '${nonce}' >&2`,
    `command -v python3 >/dev/null 2>&1 || { printf '%s\\n' 'pi-remote: python3 3.8+ is required on the remote host' >&2; exit 96; }`,
    `exec python3 -c ${shQuote(supervisor)} ${encoded} ${nonce} ${timeoutSeconds}`,
  ].join("; ");
  return { nonce, remoteCommand };
}

export interface ParsedStderr {
  stderr: string;
  pid?: number;
  cwd?: string;
  shellStarted?: boolean;
  detached?: boolean;
}

/** Remove the wrapper's marker lines. A missing CWD marker means the shell was replaced or killed. */
export function parseStderr(raw: string, nonce: string): ParsedStderr {
  const result: ParsedStderr = { stderr: raw };
  const readyLine = `${nonce} READY\n`;
  if (result.stderr.includes(readyLine)) {
    result.shellStarted = true;
    result.stderr = result.stderr.replace(readyLine, "");
  }
  const detachedMarker = `\n${nonce} DETACHED`;
  if (result.stderr.includes(detachedMarker)) {
    result.detached = true;
    result.stderr = result.stderr.replace(detachedMarker, "");
  }
  const pidLine = new RegExp(`${nonce} PID (\\d+)\\n`);
  const pidMatch = result.stderr.match(pidLine);
  if (pidMatch) {
    result.pid = Number(pidMatch[1]);
    result.stderr = result.stderr.replace(pidLine, "");
  }
  const cwdStart = result.stderr.lastIndexOf(`\n${nonce} CWD `);
  if (cwdStart !== -1) {
    const tail = result.stderr.slice(cwdStart + nonce.length + 6);
    result.cwd = tail.endsWith("\n") ? tail.slice(0, -1) : tail;
    result.stderr = result.stderr.slice(0, cwdStart);
  }
  return result;
}
