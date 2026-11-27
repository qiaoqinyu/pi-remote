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
const versionFile = join(installRoot, "current-version");

/** Provided by the host Pi; a registry copy here means tests run against the wrong build. */
const hostProvided = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "typebox",
];
/** A devDependency, so a real directory is the normal case. */
const dependencies = [...hostProvided, "@types/node"];

if (!existsSync(versionFile)) {
  // CI and fresh clones resolve the host packages from the registry instead.
  console.warn(
    `link-deps: no Pi install under ${installRoot}; leaving node_modules as it is.`,
  );
  process.exit(0);
}

const version = readFileSync(versionFile, "utf8").trim();
const releaseModules = join(installRoot, "releases", version, "node_modules");
const shadowed = [];

for (const dependency of dependencies) {
  const target = join(releaseModules, dependency);
  if (!existsSync(target))
    throw new Error(`Pi ${version} does not provide ${dependency}: ${target}`);
  const link = join(packageDir, "node_modules", dependency);
  mkdirSync(dirname(link), { recursive: true });
  if (existsSync(link)) {
    // Real packages win; only refresh the symlinks owned by this development setup.
    if (!lstatSync(link).isSymbolicLink()) {
      if (hostProvided.includes(dependency)) shadowed.push(dependency);
      continue;
    }
    unlinkSync(link);
  }
  symlinkSync(target, link, "dir");
}

if (shadowed.length)
  console.warn(
    `link-deps: ${shadowed.join(", ")} ${shadowed.length === 1 ? "is" : "are"} a real directory, ` +
      `so Pi ${version} is not linked and tests use the registry copy.`,
  );
