import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDir =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const installRoot =
  process.env.PI_MANAGED_INSTALL_ROOT ?? join(agentDir, "install");
const version = readFileSync(
  join(installRoot, "current-version"),
  "utf8",
).trim();
const releaseModules = join(installRoot, "releases", version, "node_modules");
const dependencies = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@types/node",
  "typebox",
];

for (const dependency of dependencies) {
  const target = join(releaseModules, dependency);
  if (!existsSync(target))
    throw new Error(`Pi ${version} does not provide ${dependency}: ${target}`);
  const link = join(packageDir, "node_modules", dependency);
  mkdirSync(dirname(link), { recursive: true });
  if (existsSync(link)) {
    // Real packages win; only refresh the symlinks owned by this development setup.
    if (!lstatSync(link).isSymbolicLink()) continue;
    unlinkSync(link);
  }
  symlinkSync(target, link, "dir");
}
