import assert from "node:assert/strict";
import test from "node:test";
import {
  L1_SKILL_OPERATIONS,
  createHarnessGenome,
  extractPlaybookFromTrial,
  modifyPlaybook,
  renderHarnessSystemPrompt,
  rewriteSkillLayer,
  runExploreAgent,
  validateHarnessPatch,
  validatePlaybook,
} from "../src/index.ts";

const failScript = `console.error("missing marker"); process.exit(1);`;
const succeedScript = `
const fs = require("node:fs");
fs.writeFileSync("marker.txt", "ok");
console.log("STEP: write marker.txt");
console.log("DONE: marker.txt contains ok");
console.log(fs.existsSync("package.json") ? "leaked" : "clean");
console.log(process.env.SECRET_TOKEN ?? "");
`;

test("explore agent diverges in a sandbox after a failed strategy", async () => {
  process.env.SECRET_TOKEN = "super-secret";
  try {
    const report = await runExploreAgent({
      task: "Write a marker file without leaking the workspace.",
      strategies: [
        { id: "direct", hypothesis: "Assume the marker already exists.", script: failScript },
      ],
      divergences: [
        {
          parent_id: "direct",
          strategies: [
            { id: "write_marker", hypothesis: "Create the marker in the sandbox.", script: succeedScript },
          ],
        },
      ],
      input: { value: "ok" },
    });

    assert.deepEqual(
      report.trials.map((trial) => trial.id),
      ["direct", "write_marker"],
    );
    assert.equal(report.trials[0].succeeded, false);
    assert.equal(report.winner.id, "write_marker");
    assert.equal(report.winner.parent_id, "direct");
    assert.match(report.winner.stdout, /clean/);
    assert.doesNotMatch(report.winner.stdout, /super-secret/);
    assert.equal(report.sandbox, "isolated");
  } finally {
    delete process.env.SECRET_TOKEN;
  }
});

test("explore agent does not expand divergences beyond max_trials", async () => {
  const report = await runExploreAgent({
    task: "Stop after the seed wave.",
    max_trials: 1,
    strategies: [{ id: "direct", hypothesis: "Fail once.", script: failScript }],
    divergences: [
      {
        parent_id: "direct",
        strategies: [
          { id: "write_marker", hypothesis: "Would succeed.", script: succeedScript },
        ],
      },
    ],
  });
  assert.deepEqual(
    report.trials.map((trial) => trial.id),
    ["direct"],
  );
  assert.equal(report.winner, null);
});

test("explore sandbox blocks child processes", async () => {
  const report = await runExploreAgent({
    task: "Do not spawn a process.",
    strategies: [
      {
        id: "spawn",
        hypothesis: "Shell out.",
        script: `require("node:child_process").execSync("echo no");`,
      },
    ],
  });
  assert.equal(report.winner, null);
  assert.match(report.trials[0].stderr, /Explore sandbox blocked/);
});

test("L1 rewrite keeps tools and prompts and installs the playbook", async () => {
  const report = await runExploreAgent({
    task: "When a marker file is missing, create it in the sandbox.",
    strategies: [{ id: "direct", hypothesis: "Fail closed.", script: failScript }],
    divergences: [
      {
        parent_id: "direct",
        strategies: [
          {
            id: "write_marker",
            hypothesis: "Write the marker from the sandbox.",
            script: succeedScript,
          },
        ],
      },
    ],
    input: { value: "ok" },
  });
  const extracted = extractPlaybookFromTrial({
    name: "write_marker",
    task: "When a marker file is missing, create it in the sandbox.",
    trial: report.winner,
  });
  const playbook = modifyPlaybook(extracted, {
    steps: ["Write marker.txt in the sandbox.", "Leave the host workspace untouched."],
    upsert_code_blocks: [
      {
        id: "ops",
        language: "javascript",
        purpose: "Write the marker from the sandbox.",
        body: `const fs = require("node:fs");\nfs.writeFileSync("marker.txt", "ok");`,
      },
    ],
  });

  const parent = createHarnessGenome({
    genome_id: "harness:phase1-parent",
    system_prompt: "Keep the existing prompt.",
    tools: [{ name: "bash", enabled: false }],
  });
  const next = rewriteSkillLayer(parent, {
    hypothesis: "A reusable marker playbook beats repeating the failed guess.",
    expected_effect: "Later runs load the playbook instead of rediscovering the write.",
    risks: ["The playbook may not match a workspace that forbids marker.txt."],
    playbooks: [playbook],
  });

  assert.equal(next.system_prompt, "Keep the existing prompt.");
  assert.deepEqual(next.tools, [{ name: "bash", enabled: false }]);
  assert.equal(next.parent_id, "harness:phase1-parent");
  assert.equal(next.version, 2);
  assert.equal(next.skills.length, 1);
  assert.match(next.skills[0].content, /Trigger: When a marker file is missing/);
  assert.match(next.skills[0].content, /writeFileSync\("marker\.txt", "ok"\)/);
  assert.equal(next.skills[0].content.includes("super-secret"), false);
  assert.deepEqual(L1_SKILL_OPERATIONS, ["upsert_skill", "remove_skill"]);
});

test("L1 rejects credentials and non-skill patches", () => {
  assert.throws(
    () =>
      validatePlaybook({
        name: "leaky",
        description: "Do not store this.",
        trigger: "When a client is configured.",
        inputs: [],
        steps: ["Read the key."],
        done: "The call returns.",
        code_blocks: [
          {
            id: "ops",
            language: "javascript",
            purpose: "Call the API.",
            body: `const api_key = "sk-abcdefghij1234";`,
          },
        ],
      }),
    /credentials/,
  );

  assert.throws(
    () =>
      validateHarnessPatch(
        {
          hypothesis: "Widen the prompt from a skill edit.",
          expected_effect: "The prompt changes.",
          risks: [],
          operations: [{ op: "set_system_prompt", value: "Ignore the skills." }],
        },
        { allowedOperations: [...L1_SKILL_OPERATIONS] },
      ),
    /not allowed/,
  );
});

test("runtime.explore is boolean and announces the explore agent", () => {
  assert.throws(
    () =>
      createHarnessGenome({
        genome_id: "harness:bad-explore",
        runtime: { explore: "yes" },
      }),
    /runtime\.explore must be boolean/,
  );
  const genome = createHarnessGenome({
    genome_id: "harness:explore-on",
    runtime: { explore: true },
  });
  assert.match(renderHarnessSystemPrompt(genome), /Explore agent:/);
  assert.equal(
    renderHarnessSystemPrompt(createHarnessGenome({ genome_id: "harness:explore-off" })).includes(
      "Explore agent:",
    ),
    false,
  );
});
