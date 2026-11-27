# Changelog

## 0.2.0

### Fixed

- Cached output files (`remote-output-cache/`) no longer contain the wrapper's
  `READY`, `PID`, `CD_FAILED`, `STOP`, `DETACHED` and `CWD` marker lines. Only the
  command's own output is stored, so reading a cached stream shows what the
  command printed.
- A remembered working directory is cleared only when the wrapper reports that it
  could not be entered. A command that exits 97 on its own, or resets traps, no
  longer discards the remembered directory.
- `remote_job` status keeps working when many jobs are registered. Status
  commands are batched per host instead of building one script that exceeded the
  64 KB command limit (123 Slurm jobs were enough to break the whole listing).
- `remote_sync` uses `--stats` instead of `--info=stats1,progress0`, which does
  not exist in rsync 3.0 and older.
- Slurm status and cancel build their `-M` arguments from positional parameters,
  so they also work on bash versions before 4.4 (RHEL/CentOS 7), where expanding
  an empty array under `set -u` is an error.
- A missing local `ssh` binary now reports "ssh is not installed on this machine"
  instead of a raw `spawn ssh ENOENT`.
- `remote_job` lists the newest registration first instead of sorting by random
  UUID.

### Changed

- Preview updates during `remote` are throttled to one per 100 ms.
- Timeout validation lives in one place (`validateTimeout`), and the default
  timeout has a single owner.
- `test/link-deps.mjs` skips linking when no Pi install is present (so CI works),
  and warns when a real `node_modules` copy shadows the linked Pi release.

### Meta

- Released under the MIT license.

### Documentation

- Added install instructions, the `/remote jobs` verb, and the rsync, stream
  ordering and cwd-reporting limits.
