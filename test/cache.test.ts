import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CacheFile, pruneCache } from "../src/cache.ts";

test("pruneCache reclaims old crash orphans but preserves fresh slots and live cache files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cache-prune-test-"));
  try {
    const orphan = join(dir, "slot-63");
    closeSync(openSync(orphan, "wx", 0o600));
    const old = new Date(Date.now() - 2 * 3600000);
    utimesSync(orphan, old, old);
    const fresh = join(dir, "slot-62");
    closeSync(openSync(fresh, "wx", 0o600));
    const cache = new CacheFile(dir);
    cache.write(Buffer.from("output"));
    cache.close();

    pruneCache(dir);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(fresh), true);
    assert.ok(cache.path && existsSync(cache.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
