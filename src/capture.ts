import { CacheFile } from "./cache.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

export interface CaptureOptions {
  /**
   * Keep a complete line in the cached file only when this returns true.
   * The in-memory tail stays raw, because the wrapper's markers are parsed from it.
   */
  keepLine?: (line: string) => boolean;
}

/** Wrapper marker lines are short; anything longer is command output. */
const MAX_PENDING_LINE = 8192;

/** Keep small output in memory. Once either limit is crossed, spool every byte. */
export class Capture {
  constructor(privateDir?: string, options?: CaptureOptions) {
    this.dir = privateDir;
    this.keepLine = options?.keepLine;
  }
  private dir?: string;
  private keepLine?: (line: string) => boolean;
  tail = Buffer.alloc(0);
  private cache?: CacheFile;
  private pending: Buffer = Buffer.alloc(0);
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
        this.spool(this.tail);
      }
    }
    this.spool(chunk);
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-DEFAULT_MAX_BYTES);
  }

  /** Write to the cache, dropping marker lines when a filter is configured. */
  private spool(chunk: Buffer) {
    if (!this.cache) return;
    if (!this.keepLine) {
      this.cache.write(chunk);
      return;
    }
    const buffer = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : chunk;
    let start = 0;
    for (
      let end = buffer.indexOf(10);
      end !== -1;
      end = buffer.indexOf(10, start)
    ) {
      if (this.keepLine(buffer.subarray(start, end).toString("utf8")))
        this.cache.write(buffer.subarray(start, end + 1));
      start = end + 1;
    }
    this.pending = buffer.subarray(start);
    if (this.pending.length > MAX_PENDING_LINE) {
      this.cache.write(this.pending);
      this.pending = Buffer.alloc(0);
    }
  }

  close() {
    if (this.cache) {
      if (this.pending.length) this.cache.write(this.pending);
      this.pending = Buffer.alloc(0);
      this.cache.close();
    }
  }
}
