// Copyright (c) 2026 Flisk Landscape contributors
// SPDX-License-Identifier: MIT
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isDemoStackRunning,
  locateProjectTiltPids,
  stopDemoCompose,
  stopDemoStack,
} from "./demo-reset.js";

describe("stopDemoStack", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "demo-reset-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function project(withTiltfile: boolean) {
    mkdirSync(join(dir, ".flisk", ".flisk-out"), { recursive: true });
    writeFileSync(
      join(dir, ".flisk", "project.json"),
      JSON.stringify({ project: { name: "test-demo" } }),
    );
    if (withTiltfile) writeFileSync(join(dir, ".flisk", ".flisk-out", "Tiltfile"), "");
  }

  it("runs down for an existing Flisk project", async () => {
    project(true);
    const runDown = vi.fn();

    expect(await stopDemoStack(dir, runDown, async () => {})).toBe(true);
    expect(runDown).toHaveBeenCalledWith(dir);
  });

  it("stops the live Tilt before down, so the old stack cannot keep the ports", async () => {
    project(true);
    const order: string[] = [];
    await stopDemoStack(
      dir,
      () => order.push("down"),
      async () => {
        order.push("stop-tilt");
      },
    );
    expect(order).toEqual(["stop-tilt", "down"]);
  });

  it("still stops a Tilt whose Tiltfile is gone, and skips down because there is nothing to run it with", async () => {
    project(false);
    const stopTilt = vi.fn(async () => {});
    const runDown = vi.fn();

    expect(await stopDemoStack(dir, runDown, stopTilt)).toBe(true);
    expect(stopTilt).toHaveBeenCalledWith(join(dir, ".flisk", ".flisk-out", "Tiltfile"));
    expect(runDown).not.toHaveBeenCalled();
  });

  it("does nothing when the folder is not a Flisk project", async () => {
    const runDown = vi.fn();
    const stopTilt = vi.fn(async () => {});

    expect(await stopDemoStack(dir, runDown, stopTilt)).toBe(false);
    expect(runDown).not.toHaveBeenCalled();
    expect(stopTilt).not.toHaveBeenCalled();
  });

  it("defaults to stopDemoCompose which does not evaluate the Tiltfile", async () => {
    project(true);
    const executed: Array<{ cmd: string; args: string[] }> = [];
    const runner = (cmd: string, args: string[]) => {
      executed.push({ cmd, args });
      if (cmd === "docker" && args[0] === "ps") {
        return "";
      }
      return "";
    };

    const stopTilt = vi.fn(async () => {});
    await stopDemoStack(dir, (d) => stopDemoCompose(d, runner), stopTilt);
    expect(stopTilt).toHaveBeenCalled();
    // Tiltfile was never evaluated by running tilt down
    expect(executed.some((e) => e.cmd === "tilt" && e.args.includes("down"))).toBe(false);
  });
});

describe("isDemoStackRunning", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "demo-running-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when folder is not a Flisk project", () => {
    expect(isDemoStackRunning(dir)).toBe(false);
  });

  it("returns false when no Tilt process and no Compose containers are running", () => {
    mkdirSync(join(dir, ".flisk", ".flisk-out"), { recursive: true });
    writeFileSync(
      join(dir, ".flisk", "project.json"),
      JSON.stringify({ project: { name: "demo" } }),
    );
    writeFileSync(join(dir, ".flisk", ".flisk-out", "Tiltfile"), "");

    const runner = (cmd: string, _args: string[]) => {
      if (cmd === "ps") return "100 bash\n200 node";
      if (cmd === "docker") return "";
      return "";
    };

    expect(isDemoStackRunning(dir, "darwin", runner)).toBe(false);
  });

  it("returns true when a Tilt process is running for this Tiltfile", () => {
    mkdirSync(join(dir, ".flisk", ".flisk-out"), { recursive: true });
    writeFileSync(
      join(dir, ".flisk", "project.json"),
      JSON.stringify({ project: { name: "demo" } }),
    );
    const tiltfile = join(dir, ".flisk", ".flisk-out", "Tiltfile");
    writeFileSync(tiltfile, "");

    const runner = (cmd: string, _args: string[]) => {
      if (cmd === "ps") {
        return `100 /usr/local/bin/tilt up -f ${tiltfile}\n200 node`;
      }
      return "";
    };

    expect(isDemoStackRunning(dir, "darwin", runner)).toBe(true);
  });

  it("returns true when Compose containers are running for this project", () => {
    mkdirSync(join(dir, ".flisk", ".flisk-out"), { recursive: true });
    writeFileSync(
      join(dir, ".flisk", "project.json"),
      JSON.stringify({ project: { name: "demo" } }),
    );
    writeFileSync(join(dir, ".flisk", ".flisk-out", "Tiltfile"), "");

    const runner = (cmd: string, args: string[]) => {
      if (cmd === "ps") return "200 node";
      if (cmd === "docker" && args.includes("-a")) {
        return `demo-backend\t${dir}/.flisk/.flisk-out`;
      }
      return "";
    };

    expect(isDemoStackRunning(dir, "darwin", runner)).toBe(true);
  });
});

describe("stopDemoCompose", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "demo-compose-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stops only this project's Compose services with docker compose down", () => {
    mkdirSync(join(dir, ".flisk", ".flisk-out"), { recursive: true });
    writeFileSync(
      join(dir, ".flisk", "project.json"),
      JSON.stringify({ project: { name: "my-demo" } }),
    );

    const executed: Array<{ cmd: string; args: string[] }> = [];
    const runner = (cmd: string, args: string[]) => {
      executed.push({ cmd, args });
      if (cmd === "docker" && args[0] === "ps" && args.includes("-a")) {
        return `my-demo-backend\t${dir}/.flisk/.flisk-out\nother-app\t/some/other/path`;
      }
      return "";
    };

    stopDemoCompose(dir, runner);

    // Stops my-demo-backend, leaves other-app untouched
    expect(
      executed.some(
        (e) =>
          e.cmd === "docker" &&
          e.args.includes("compose") &&
          e.args.includes("my-demo-backend") &&
          e.args.includes("down"),
      ),
    ).toBe(true);
    expect(
      executed.some(
        (e) => e.cmd === "docker" && e.args.includes("compose") && e.args.includes("other-app"),
      ),
    ).toBe(false);
  });

  it("safely ignores docker failure when Docker is missing or down", () => {
    mkdirSync(join(dir, ".flisk"), { recursive: true });
    writeFileSync(join(dir, ".flisk", "project.json"), "{}");

    const runner = () => {
      throw new Error("Cannot connect to the Docker daemon");
    };

    expect(() => stopDemoCompose(dir, runner)).not.toThrow();
  });
});

describe("locateProjectTiltPids", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "demo-tilt-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds only PIDs matching this project's Tiltfile", () => {
    mkdirSync(join(dir, ".flisk", ".flisk-out"), { recursive: true });
    const tiltfile = join(dir, ".flisk", ".flisk-out", "Tiltfile");
    writeFileSync(tiltfile, "");

    const runner = (cmd: string) => {
      if (cmd === "ps") {
        return [
          `400 /bin/tilt up -f ${tiltfile}`,
          `500 /bin/tilt up -f /other/project/.flisk/.flisk-out/Tiltfile`,
          `600 /bin/tilt down`,
        ].join("\n");
      }
      return "";
    };

    const pids = locateProjectTiltPids(dir, tiltfile, "darwin", runner);
    expect(pids).toEqual([400]);
  });
});
