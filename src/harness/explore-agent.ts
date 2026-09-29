import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const STRATEGY_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_SCRIPT_CHARS = 16000;
const MAX_OUTPUT_CHARS = 8000;

/**
 * Preload for every explore trial. Blocks process spawning and network
 * primitives. The trial still has a filesystem, so this is a process sandbox,
 * not a virtual machine.
 */
const SANDBOX_PRELOAD = `
const Module = require("module");
const blocked = new Set([
  "child_process",
  "node:child_process",
  "cluster",
  "node:cluster",
  "dgram",
  "node:dgram",
  "dns",
  "node:dns",
  "http",
  "node:http",
  "https",
  "node:https",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "worker_threads",
  "node:worker_threads",
]);
const original = Module.prototype.require;
Module.prototype.require = function exploreSandboxRequire(id) {
  if (blocked.has(id)) {
    throw new Error("Explore sandbox blocked " + id);
  }
  return original.apply(this, arguments);
};
globalThis.fetch = function exploreSandboxFetch() {
  throw new Error("Explore sandbox blocked fetch");
};
`;

const ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
];

function assertStrategy(strategy, label) {
  if (!strategy || typeof strategy !== "object") {
    throw new Error(`${label} must be an object.`);
  }
  if (typeof strategy.id !== "string" || !STRATEGY_ID.test(strategy.id)) {
    throw new Error(`${label} requires a valid id.`);
  }
  if (typeof strategy.hypothesis !== "string" || strategy.hypothesis.trim() === "") {
    throw new Error(`Explore strategy "${strategy.id}" requires a hypothesis.`);
  }
  if (typeof strategy.script !== "string" || strategy.script.trim() === "") {
    throw new Error(`Explore strategy "${strategy.id}" requires a script.`);
  }
  if (strategy.script.length > MAX_SCRIPT_CHARS || strategy.script.includes("\0")) {
    throw new Error(`Explore strategy "${strategy.id}" script is not allowed.`);
  }
  return strategy;
}

function sandboxEnv({ task, strategyId, input }) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.EXPLORE_TASK = task;
  env.EXPLORE_STRATEGY_ID = strategyId;
  env.EXPLORE_INPUT = JSON.stringify(input ?? {});
  return env;
}

function clip(text) {
  const value = String(text ?? "");
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n…truncated`;
}

function failedTrial(strategy, parentId, error) {
  const timedOut = error?.killed === true || error?.code === "ETIMEDOUT";
  return {
    id: strategy.id,
    hypothesis: strategy.hypothesis,
    parent_id: parentId,
    script: strategy.script,
    exit_code: typeof error?.code === "number" ? error.code : null,
    timed_out: timedOut,
    stdout: clip(error?.stdout),
    stderr: clip(error?.stderr || error?.message || ""),
    succeeded: false,
  };
}

async function runTrial({ sandbox, task, input, strategy, parentId, timeoutMs }) {
  const scriptPath = join(sandbox, `${strategy.id}.js`);
  await writeFile(scriptPath, strategy.script, "utf8");
  try {
    const result = await execFileAsync(
      process.execPath,
      ["-r", join(sandbox, "preload.cjs"), scriptPath],
      {
        cwd: sandbox,
        env: sandboxEnv({ task, strategyId: strategy.id, input }),
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_CHARS,
        windowsHide: true,
      },
    );
    return {
      id: strategy.id,
      hypothesis: strategy.hypothesis,
      parent_id: parentId,
      script: strategy.script,
      input: input ?? {},
      exit_code: 0,
      timed_out: false,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
      succeeded: true,
    };
  } catch (error) {
    return {
      ...failedTrial(strategy, parentId, error),
      input: input ?? {},
    };
  }
}

/**
 * Phase-1 execution subject. Tries caller-supplied strategies in a fresh
 * sandbox. A failed strategy unlocks its declared divergences; a success does
 * not. Search is breadth-first and stops at max_trials. Model weights, tools,
 * and permissions are never written.
 */
export async function runExploreAgent({
  task,
  strategies,
  divergences = [],
  input,
  max_trials: maxTrials = 8,
  timeout_ms: timeoutMs = 5000,
} = {}) {
  if (typeof task !== "string" || task.trim() === "") {
    throw new Error("Explore agent requires a task.");
  }
  if (!Array.isArray(strategies) || strategies.length === 0) {
    throw new Error("Explore agent requires at least one strategy.");
  }
  if (!Number.isInteger(maxTrials) || maxTrials < 1 || maxTrials > 32) {
    throw new Error("Explore max_trials must be an integer from 1 to 32.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw new Error("Explore timeout_ms must be an integer from 100 to 30000.");
  }

  const roots = strategies.map((strategy) => assertStrategy(strategy, "Explore strategy"));
  const rootIds = new Set();
  for (const strategy of roots) {
    if (rootIds.has(strategy.id)) {
      throw new Error(`Duplicate explore strategy "${strategy.id}".`);
    }
    rootIds.add(strategy.id);
  }

  const children = new Map();
  for (const divergence of divergences) {
    if (!divergence || typeof divergence.parent_id !== "string") {
      throw new Error("Explore divergence requires parent_id.");
    }
    if (!Array.isArray(divergence.strategies) || divergence.strategies.length === 0) {
      throw new Error(`Explore divergence "${divergence.parent_id}" requires strategies.`);
    }
    const next = divergence.strategies.map((strategy) =>
      assertStrategy(strategy, "Explore divergence strategy"),
    );
    children.set(divergence.parent_id, [
      ...(children.get(divergence.parent_id) ?? []),
      ...next,
    ]);
  }

  const sandbox = await mkdtemp(join(tmpdir(), "rsih-explore-"));
  const trials = [];
  const seen = new Set();
  try {
    await writeFile(join(sandbox, "preload.cjs"), SANDBOX_PRELOAD, "utf8");
    let frontier = roots.map((strategy) => ({ strategy, parentId: null }));
    while (frontier.length > 0 && trials.length < maxTrials) {
      const wave = frontier;
      frontier = [];
      for (const { strategy, parentId } of wave) {
        if (trials.length >= maxTrials || seen.has(strategy.id)) continue;
        seen.add(strategy.id);
        const trial = await runTrial({
          sandbox,
          task,
          input,
          strategy,
          parentId,
          timeoutMs,
        });
        trials.push(trial);
        if (!trial.succeeded) {
          for (const child of children.get(strategy.id) ?? []) {
            frontier.push({ strategy: child, parentId: strategy.id });
          }
        }
      }
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }

  return {
    task,
    sandbox: "isolated",
    trials,
    winner: trials.find((trial) => trial.succeeded) ?? null,
  };
}
