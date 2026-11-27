# pi-remote

Gives the model SSH command, file-sync, and durable-job tools for hosts in `~/.ssh/config`. The `/remote` command inspects and disconnects the Pi-owned connections they use.

## Tools

- `remote(host, command, cwd?, timeout?)` runs a bash script on the host with no extra SSH quoting. The final directory is remembered per host in the active session branch. `/tree` navigation restores that branch's directories. If a remembered directory no longer exists, the tool reports exit 97, clears it, and the next call starts in the remote home directory. An explicitly supplied invalid `cwd` does not clear remembered state.
- Both stdout and stderr stream to the tool preview. The final result keeps at most 2000 lines or 50 KB; oversized streams are spooled to private local cache files. UTF-8 output split across network chunks is decoded without replacement characters at chunk boundaries.
- On timeout (default 120 s) or Esc, a remote Python 3.8+ supervisor sends TERM then KILL to the command's process group. If SSH cannot deliver the acknowledgement, the result says the remote state is unknown; the supervisor also enforces its own deadline. A host without `python3` exits with code 96 and an explicit prerequisite error rather than `ssh failed`.
- If the main command exits but a background child keeps stdout or stderr open, the supervisor reports that condition after a short grace period instead of waiting for the deadline. Redirect detached processes or use `remote_job`.
- `remote_sync(host, direction, local, remote, exclude?, timeout?)` runs `rsync -az --partial` over the same connection. It never deletes files. A relative remote path resolves against the remembered directory. The default timeout is 600 s and can be changed per call. Timeout and cancellation messages explain that partial files are kept and retrying resumes the transfer.
- `remote_job` submits long work with an explicit `slurm` or `process` backend. Use the returned UUID for `status`, `logs`, or `cancel`. `forget` removes only local registration metadata; it does not cancel remote work.

## Connections

Each host gets its own ControlMaster socket in `~/.pi/agent/remote/<alias>`, separate from the `~/.ssh/ctrl-*` sockets used by terminals. A master exits after 30 minutes idle. Quitting one Pi session does not stop the shared master.

- `/remote` or `/remote list`: shows each host, master PID, stale socket or check error, and remembered cwd.
- `/remote refresh`: checks all sockets and removes stale ones without closing live connections.
- `/remote disconnect <host|all>`: closes the selected masters immediately and removes stale sockets. `/remote close` is an alias. Disconnecting ends commands running over that master but does not cancel submitted jobs.
- A host can be disconnected by its old alias after it is renamed or removed from SSH config. If the SSH control command cannot handle the old alias, Pi terminates the master PID obtained from that exact Pi-owned socket.

The footer shows `remote: <hosts>` while sockets exist and refreshes every 60 seconds. Tool calls and `/remote` commands refresh it immediately.

## Jobs and logs

Slurm uses the submitted script's resource directives. Job stdout/stderr go to private files under `$HOME/.local/state/pi-remote/jobs/<id>/` (HOME must be shared with compute nodes). The log action reads only the last 100 lines per file. Only registration metadata is stored locally in `remote-jobs/`.

Job status uses one SSH invocation per host, with different hosts queried in parallel. An unreachable host does not delay other hosts. Corrupt local records produce warnings instead of blocking the whole list. Use `remote_job(action="forget", id=...)` to remove finished registrations.

Large command output uses `remote-output-cache/` in the Pi agent directory. There are 64 shared slots of 16 MiB each (1 GiB total); stdout and stderr may each occupy one slot. Once full, previews still work, but the full stream is not saved. Entries older than seven days and orphan slots older than one hour are pruned. Remote logs and project files are never pruned.

## Limits

- No tty. Interactive programs such as `top`, `vim`, or password prompts do not work. Prefer `sbatch` for training.
- The command is limited to 64 KB. For larger scripts, copy them with `remote_sync` first.
- Only cwd persists between calls. Environment variables and `conda activate` do not, so put them in the same script.
- A command's own `trap ... EXIT` overrides the wrapper's cwd-reporting trap; the final cwd is then unavailable.
- The base64-encoded command travels in remote process arguments and can be visible to other users through `ps`, especially on shared login nodes. Do not put secrets in commands.
- Processes that deliberately leave the supervisor's process group are outside the cancellation guarantee.

## Development

```sh
npm install --legacy-peer-deps
npm test
npm run typecheck
npm run format:check
```

`test/link-deps.mjs` links peer dependencies from the currently installed Pi release before tests and type checks. No manual re-pointing is needed after a Pi upgrade.
