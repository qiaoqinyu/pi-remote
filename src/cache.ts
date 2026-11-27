import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  mkdirSync,
  openSync,
  writeSync,
  statSync,
  unlinkSync,
  readdirSync,
  linkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const root = () => join(getAgentDir(), "remote-output-cache");
const slots = 64;
const limit = 16 * 1024 * 1024;
// Unique output names never get reused. An exclusive hard link reserves one slot
// across Pi processes; both names point at the same bytes.
export function pruneCache(dir = root()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    const orphan = /^slot-\d+$/.exec(name);
    if (orphan) {
      // A crash between slot creation and the hard link leaves a one-link slot.
      // Only reclaim old ones so a live CacheFile constructor cannot race this.
      const slot = join(dir, name);
      try {
        const st = statSync(slot);
        if (st.nlink === 1 && Date.now() - st.mtimeMs > 3600000)
          unlinkSync(slot);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      continue;
    }
    const match = /^(\d+)-([a-f0-9-]{36})\.log$/.exec(name);
    if (!match) continue;
    const file = join(dir, name),
      slot = join(dir, `slot-${match[1]}`);
    try {
      const st = statSync(file);
      if (Date.now() - st.mtimeMs < 7 * 86400000) continue;
      // Only the process which removes this unique name may release its slot.
      unlinkSync(file);
      if (statSync(slot).ino === st.ino) unlinkSync(slot);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

export class CacheFile {
  path?: string;
  private fd?: number;
  private size = 0;
  limited = false;
  constructor(dir = root()) {
    pruneCache(dir);
    for (let i = 0; i < slots; i++) {
      const slot = join(dir, `slot-${i}`);
      try {
        this.fd = openSync(slot, "wx", 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      this.path = join(dir, `${i}-${randomUUID()}.log`);
      try {
        linkSync(slot, this.path);
      } catch (e) {
        closeSync(this.fd);
        unlinkSync(slot);
        throw e;
      }
      return;
    }
    this.limited = true;
  }
  write(chunk: Buffer) {
    const count = Math.min(chunk.length, limit - this.size);
    if (this.fd === undefined) return;
    if (count < chunk.length) this.limited = true;
    let offset = 0;
    while (offset < count)
      offset += writeSync(this.fd, chunk, offset, count - offset);
    this.size += count;
  }
  close() {
    if (this.fd !== undefined) closeSync(this.fd);
  }
}
