import { CacheFile } from "./cache.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

/** Keep small output in memory. Once either limit is crossed, spool every byte. */
export class Capture {
  constructor(privateDir?: string) {
    this.dir = privateDir;
  }
  private dir?: string;
  tail = Buffer.alloc(0);
  private cache?: CacheFile;
  get file() {
    return this.cache?.path;
  }
  get limited() {
    return this.cache?.limited ?? false;
  }
  private lines = 1;

  /** Decode the bounded tail without starting in the middle of a UTF-8 sequence. */
  get text(): string {
    let start = 0;
    while (
      start < Math.min(4, this.tail.length) &&
      (this.tail[start] & 0xc0) === 0x80
    )
      start++;
    return this.tail.subarray(start).toString("utf8");
  }

  add(chunk: Buffer) {
    if (!this.cache) {
      for (const byte of chunk) if (byte === 10) this.lines++;
      if (
        this.tail.length + chunk.length > DEFAULT_MAX_BYTES ||
        this.lines > DEFAULT_MAX_LINES
      ) {
        this.cache = new CacheFile(this.dir);
        this.cache.write(this.tail);
      }
    }
    this.cache?.write(chunk);
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-DEFAULT_MAX_BYTES);
  }

  close() {
    this.cache?.close();
  }
}
