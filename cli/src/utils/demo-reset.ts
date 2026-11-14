// Copyright (c) 2026 Flisk Landscape contributors
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliInvocation } from "./cli-invocation.js";
import {
  findProjectTiltUpPids,
  projectComposeProjects,
  waitForTiltUpExit,
} from "./down-cleanup.js";
import { readSavedTiltPort } from "./host-port-config.js";
import { projectNameAt, readProjectRecords } from "./project-registry.js";
import { findTiltPortOwner, isForeignTilt } from "./tilt-port-owner.js";

type CommandRunner = (command: string, args: string[]) => string;

const defaultRun: CommandRunner = (command, args) =>
  execFileSync(command, args, { encoding: "utf-8", stdio: "pipe", windowsHide: true });

/** Stops the `tilt up` processes that run this project's Tiltfile, and waits for them to exit. */
export type StopTilt = (tiltfile: string) => Promise<void>;

/**
 * PIDs of running `tilt up` processes belonging to this project, found via the Tiltfile path
 * and the saved Tilt UI port.
 */
export function locateProjectTiltPids(
  projectDir: string,
  tiltfile: string = join(projectDir, ".flisk", ".flisk-out", "Tiltfile"),
  platform = process.platform,
  commandRunner: CommandRunner = defaultRun,
): number[] {
  const pids = new Set<number>();
  try {
    for (const pid of findProjectTiltUpPids(tiltfile, platform, commandRunner)) {
      pids.add(pid);
    }
  } catch {
    // ps error or unsupported platform
  }

  try {
    const savedPort = readSavedTiltPort(projectDir);
    if (savedPort) {
      const owner = findTiltPortOwner(savedPort, platform, commandRunner);
      if (owner && !isForeignTilt(owner, projectDir)) {
        pids.add(owner.pid);
      }
    }
  } catch {
    // Port check error
  }

  return [...pids].sort((a, b) => a - b);
}

/**
 * The Compose projects belonging to this project that currently exist in Docker.
 * Combines container working directory matches with known projects from ~/.flisk/projects and project stacks.
 */
export function demoComposeProjects(
  projectDir: string,
  commandRunner: CommandRunner = defaultRun,
): string[] {
  let projectCompose: string[] = [];
  try {
    projectCompose = projectComposeProjects(projectDir, commandRunner);
  } catch {
    // Docker unavailable or command error
  }
  const names = new Set(projectCompose);
  const projectName = readProjectName(projectDir);
  if (projectName) {
    try {
      const records = readProjectRecords();
      const record = records.find((r) => r.name === projectName);
      const owned = ownedComposeProjects(projectName, record?.stacks ?? []);
      const output = commandRunner("docker", [
        "ps",
        "-a",
        "--format",
        '{{.Label "com.docker.compose.project"}}',
      ]);
      for (const line of output.split(/\r?\n/)) {
        const proj = line.trim();
        if (proj && owned.has(proj)) names.add(proj);
      }
    } catch {
      // Docker or project records unavailable
    }
  }
  return [...names].sort();
}

/**
 * Stops this demo's Docker Compose services directly with `docker compose -p <project> down --remove-orphans`.
 * Does not evaluate the Tiltfile and touches only this project's containers.
 */
export function stopDemoCompose(
  projectDir: string,
  commandRunner: CommandRunner = defaultRun,
): void {
  const projects = demoComposeProjects(projectDir, commandRunner);
  for (const name of projects) {
    try {
      commandRunner("docker", ["compose", "-p", name, "down", "--remove-orphans"]);
    } catch {
      // Best effort; continue stopping remaining projects
    }
  }
}

/**
 * True when this project currently has running processes or containers:
 * a live `tilt up` process or Docker Compose containers belonging to this project.
 */
export function isDemoStackRunning(
  projectDir: string,
  platform = process.platform,
  commandRunner: CommandRunner = defaultRun,
): boolean {
  if (!existsSync(join(projectDir, ".flisk", "project.json"))) return false;

  const tiltfile = join(projectDir, ".flisk", ".flisk-out", "Tiltfile");
  const pids = locateProjectTiltPids(projectDir, tiltfile, platform, commandRunner);
  if (pids.length > 0) return true;

  const composeProjects = demoComposeProjects(projectDir, commandRunner);
  if (composeProjects.length > 0) return true;

  return false;
}

/**
 * Stop the stack of an existing demo folder before the folder is deleted. Deleting the folder alone leaves its
 * containers running, and a standalone Traefik that stays up keeps port 80 for the next run.
 *
 * Stops the live `tilt up` directly, then stops this project's Docker Compose containers without evaluating the
 * Tiltfile (which previously cost ~2 minutes on reset). Returns true when a Flisk project was found.
 */
export async function stopDemoStack(
  projectDir: string,
  runDown: (dir: string) => void = stopDemoCompose,
  stopTilt: StopTilt = stopRunningTilt,
): Promise<boolean> {
  if (!existsSync(join(projectDir, ".flisk", "project.json"))) return false;
  const tiltfile = join(projectDir, ".flisk", ".flisk-out", "Tiltfile");
  await stopTilt(tiltfile);
  if (!existsSync(tiltfile)) return true;
  runDown(projectDir);
  return true;
}

export async function stopRunningTilt(
  tiltfile: string,
  platform = process.platform,
  commandRunner: CommandRunner = defaultRun,
): Promise<void> {
  const projectRoot = tiltfile.replace(/[\\/]\.flisk[\\/]\.flisk-out[\\/]Tiltfile$/i, "");
  const pids = locateProjectTiltPids(
    projectRoot || resolve(tiltfile, "../../.."),
    tiltfile,
    platform,
    commandRunner,
  );
  if (pids.length === 0) return;

  for (const pid of pids) {
    try {
      commandRunner("kill", ["-TERM", String(pid)]);
    } catch {
      // Already exited or permission
    }
  }

  await waitForTiltUpExit(tiltfile, 8000, (tf) =>
    findProjectTiltUpPids(tf, platform, commandRunner),
  );
}

export function runFliskDown(projectDir: string): void {
  const [command, ...prefix] = cliInvocation();
  execFileSync(command, [...prefix, "down", "--yes"], {
    cwd: projectDir,
    stdio: "inherit",
  });
}

/** Docker calls behind {@link removeStaleProjectVolumes}, injectable so the logic is testable without Docker. */
export interface VolumeRunner {
  /** One entry per volume: its name and the Compose project that created it (empty when it has none). */
  list: () => Array<{ name: string; composeProject: string }>;
  remove: (name: string) => void;
}

const dockerVolumes: VolumeRunner = {
  list: () =>
    execFileSync(
      "docker",
      ["volume", "ls", "--format", '{{.Name}}\t{{.Label "com.docker.compose.project"}}'],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", composeProject = ""] = line.split("\t");
        return { name, composeProject };
      }),
  remove: (name) => {
    execFileSync("docker", ["volume", "rm", name], { stdio: "ignore" });
  },
};

/** Shared platform stacks that get their own Compose project: `<project>-<infra>`. */
const INFRA_STACKS = [
  "database-management",
  "messaging",
  "infisical",
  "traefik",
  "proxy",
  "monitoring",
  "cdc",
  "elk",
];

/**
 * The exact Compose projects this checkout creates. A prefix match is not enough: project `flisk-demo` would also
 * claim the volumes of a checkout named `flisk-demo-2`, whose Compose projects start with `flisk-demo-`.
 */
export function ownedComposeProjects(projectName: string, stacks: string[]): Set<string> {
  return new Set([
    ...INFRA_STACKS.map((infra) => `${projectName}-${infra}`),
    ...stacks.map((stack) => `${projectName}-${stack.toLowerCase()}-autogenerated`),
  ]);
}

/**
 * The volumes of this checkout's own Compose projects, by name, or undefined when Docker cannot be listed. An empty list
 * (no volume of this project) and a failed listing are different answers: the demo's protection check must not read a
 * failure as "nothing to protect" and then clean up with a second listing (#3963).
 */
export function tryListStaleProjectVolumes(
  projectName: string,
  docker: VolumeRunner = dockerVolumes,
  stacks: string[] = [],
): string[] | undefined {
  const owned = ownedComposeProjects(projectName, stacks);
  try {
    return docker
      .list()
      .filter((volume) => owned.has(volume.composeProject))
      .map((volume) => volume.name);
  } catch {
    return undefined;
  }
}

/** Like {@link tryListStaleProjectVolumes}, but a failed listing is an empty list. */
export function listStaleProjectVolumes(
  projectName: string,
  docker: VolumeRunner = dockerVolumes,
  stacks: string[] = [],
): string[] {
  return tryListStaleProjectVolumes(projectName, docker, stacks) ?? [];
}

/** Removes exactly these volumes and nothing else; one still in use by a container is skipped. Returns the names removed. */
export function removeProjectVolumes(
  names: readonly string[],
  docker: VolumeRunner = dockerVolumes,
): string[] {
  const removed: string[] = [];
  for (const name of names) {
    try {
      docker.remove(name);
      removed.push(name);
    } catch {
      // In use by a container that is still up: leave it, the stack itself reports the problem.
    }
  }
  return removed;
}

/**
 * Remove the Docker volumes an earlier run of this project left behind. A fresh demo clone generates a new random
 * DB_PASSWORD, but Postgres keeps the password of the data directory it was first started with and ignores
 * POSTGRES_PASSWORD afterwards, so the second `flisk demo` failed at the migrator with Prisma P1000.
 * A volume still mounted by a running container cannot be removed and is skipped. Returns the names removed.
 *
 * A volume carries no folder, so this cannot tell the demo's leftovers from another project of the same name: check
 * {@link foldersSharingProjectName} against the same listing first, and remove that listing with {@link removeProjectVolumes}.
 */
export function removeStaleProjectVolumes(
  projectName: string,
  docker: VolumeRunner = dockerVolumes,
  stacks: string[] = [],
): string[] {
  return removeProjectVolumes(listStaleProjectVolumes(projectName, docker, stacks), docker);
}

function canonicalFolder(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * The other folders that still hold a project of this name, from the record in ~/.flisk/projects. The starters `demo` and
 * `restaurant` are one repository, so a copy made with `flisk project restaurant` has the demo's project name and its
 * database volume (#3963). A folder that is gone, or now holds another project, is not a sharer.
 */
export function foldersSharingProjectName(
  projectName: string,
  demoDir: string,
  readRecords: typeof readProjectRecords = readProjectRecords,
  nameAt: typeof projectNameAt = projectNameAt,
  isDemo: (dir: string) => boolean = isDemoFolder,
): string[] {
  const record = readRecords().find((candidate) => candidate.name === projectName);
  if (!record) return [];
  const own = canonicalFolder(demoDir);
  // An earlier demo folder is not a sharer: the demo is disposable and replaces its own leftovers on every run, which is
  // the first-run -> second-run path the demo suite checks. Only a folder the demo did not create can hold data worth keeping.
  return record.roots.filter(
    (root) => canonicalFolder(root) !== own && nameAt(root) === projectName && !isDemo(root),
  );
}

const DEMO_MARKER = join(".flisk", "demo-docker.json");

/**
 * Whether a one-command run creates a folder the demo may later replace. Only the demo starter qualifies: `flisk restaurant`
 * clones the same repository, with the same project name and database volume, but it is the user's own copy (#3963).
 * It has to depend on the starter and not on `--project`, because the demo journey runs `flisk demo --project <dir>`.
 */
export function shouldMarkDemoFolder(starter: string, reused: boolean): boolean {
  return starter === "demo" && !reused;
}

/** True when the Docker demo created the folder (see {@link markDemoFolder}). */
export function isDemoFolder(dir: string): boolean {
  return existsSync(join(dir, DEMO_MARKER));
}

/** Records that `flisk demo` created this folder, so a later demo may replace its database volume. Never throws. */
export function markDemoFolder(dir: string): void {
  try {
    mkdirSync(join(dir, ".flisk"), { recursive: true });
    writeFileSync(join(dir, DEMO_MARKER), `${JSON.stringify({ demo: "docker" }, null, 2)}\n`);
  } catch {
    // A read-only folder only loses the marker: the next demo then asks the user instead of deleting.
  }
}

/**
 * What the demo says when it would delete the database of another folder's project of the same name. `message` and
 * `hint` are short because the demo's frame cuts a line at the terminal width; `detail` goes to the log file.
 */
export function sharedNameRefusal(
  projectName: string,
  folders: readonly string[],
  volumes: readonly string[],
): { message: string; hint: string; detail: string } {
  const first = folders[0] ?? "";
  return {
    message: `Nothing deleted: ${first} has the demo's project name and database.`,
    hint: "Rename that project (project.name), or run flisk down --purge there. Details: log.",
    detail: `The demo's project name "${projectName}" is also used by ${folders.join(", ")}. Docker keeps one database volume per project name (${volumes.join(", ")}), and the demo has to delete it to start clean. Nothing was deleted. Rename that project (project.name in its .flisk/project.json), or remove its data with: cd ${first} && flisk down --purge. Then run flisk demo again.`,
  };
}

/** What the demo says when another folder holds the name and Docker cannot be read, so a deletion cannot be ruled out. */
export function sharedNameUnreadableRefusal(
  projectName: string,
  folders: readonly string[],
): { message: string; hint: string; detail: string } {
  const first = folders[0] ?? "";
  return {
    message: `Nothing deleted: ${first} has the demo's project name, and Docker volumes could not be read.`,
    hint: "Start Docker and run the demo again, or rename that project (project.name). Details: log.",
    detail: `The demo's project name "${projectName}" is also used by ${folders.join(", ")}, and "docker volume ls" failed, so the demo cannot tell whether a database would be deleted. Nothing was deleted.`,
  };
}

/** The `project.name` of a Flisk project folder, or undefined when it has none. */
export function readProjectName(projectDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, ".flisk", "project.json"), "utf8")) as {
      project?: { name?: unknown };
    };
    return typeof parsed.project?.name === "string" ? parsed.project.name.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
