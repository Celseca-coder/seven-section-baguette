import { canonicalJson, cloneJson } from "../core/json.ts";
import {
  applyHarnessPatch,
  validateHarnessGenome,
  validateHarnessPatch,
} from "./genome.ts";

/** L1 may change how a task is done. It may not change tools, rules, or weights. */
export const L1_SKILL_OPERATIONS = Object.freeze(["upsert_skill", "remove_skill"]);

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CODE_LANGUAGES = new Set(["javascript", "shell"]);
const CREDENTIAL =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-/+]{8,}|\bsk-[A-Za-z0-9]{10,}\b/i;

function assertName(name, label) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error(`${label} requires a valid name.`);
  }
}

function assertText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertStringList(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
}

function rejectCredentials(text, label) {
  if (CREDENTIAL.test(text)) {
    throw new Error(`${label} must not carry credentials.`);
  }
}

export function validatePlaybook(playbook) {
  if (!playbook || typeof playbook !== "object") {
    throw new Error("Playbook must be an object.");
  }
  assertName(playbook.name, "Playbook");
  for (const field of ["description", "trigger", "done"]) {
    assertText(playbook[field], `Playbook "${playbook.name}" ${field}`);
  }
  assertStringList(playbook.inputs, `Playbook "${playbook.name}" inputs`);
  assertStringList(playbook.steps, `Playbook "${playbook.name}" steps`);
  if (playbook.steps.length === 0 || playbook.steps.some((step) => step.trim() === "")) {
    throw new Error(`Playbook "${playbook.name}" requires steps.`);
  }
  if (!Array.isArray(playbook.code_blocks) || playbook.code_blocks.length === 0) {
    throw new Error(`Playbook "${playbook.name}" requires code blocks.`);
  }
  const ids = new Set();
  const codeBlocks = playbook.code_blocks.map((block) => {
    if (!block || typeof block !== "object") {
      throw new Error(`Playbook "${playbook.name}" code block must be an object.`);
    }
    assertName(block.id, `Playbook "${playbook.name}" code block`);
    if (ids.has(block.id)) {
      throw new Error(`Duplicate playbook code block "${block.id}".`);
    }
    ids.add(block.id);
    if (!CODE_LANGUAGES.has(block.language)) {
      throw new Error(`Playbook code block "${block.id}" language is invalid.`);
    }
    assertText(block.purpose, `Playbook code block "${block.id}" purpose`);
    assertText(block.body, `Playbook code block "${block.id}" body`);
    rejectCredentials(block.body, `Playbook code block "${block.id}"`);
    return {
      id: block.id,
      language: block.language,
      purpose: block.purpose.trim(),
      body: block.body.trim(),
    };
  });
  const normalized = {
    name: playbook.name,
    description: playbook.description.trim(),
    trigger: playbook.trigger.trim(),
    inputs: playbook.inputs.map((input) => input.trim()).filter(Boolean),
    steps: playbook.steps.map((step) => step.trim()),
    done: playbook.done.trim(),
    code_blocks: codeBlocks,
  };
  rejectCredentials(
    [normalized.description, normalized.trigger, normalized.done, ...normalized.steps].join("\n"),
    `Playbook "${playbook.name}"`,
  );
  return normalized;
}

export function renderPlaybook(playbook) {
  const valid = validatePlaybook(playbook);
  const inputs =
    valid.inputs.length > 0
      ? valid.inputs.map((input) => `- ${input}`).join("\n")
      : "- (none)";
  const blocks = valid.code_blocks
    .map((block) => {
      const fence = block.body.includes("```") ? "~~~" : "```";
      return [
        `### ${block.id}`,
        block.purpose,
        "",
        `${fence}${block.language}`,
        block.body,
        fence,
      ].join("\n");
    })
    .join("\n\n");
  return [
    `# ${valid.name}`,
    "",
    valid.description,
    "",
    `Trigger: ${valid.trigger}`,
    "",
    "Inputs:",
    inputs,
    "",
    "Steps:",
    ...valid.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    `Done: ${valid.done}`,
    "",
    "## Code blocks",
    "",
    blocks,
    "",
  ].join("\n");
}

/**
 * Lift a successful sandbox trial into a reusable playbook. STEP and DONE
 * lines in stdout become the procedure; the trial script becomes the code block.
 */
export function extractPlaybookFromTrial({ name, description, task, trial }) {
  if (!trial?.succeeded) {
    throw new Error("Playbook extraction requires a successful explore trial.");
  }
  if (typeof trial.script !== "string" || trial.script.trim() === "") {
    throw new Error("Playbook extraction requires the trial script.");
  }
  const steps = [];
  let done = "";
  for (const line of String(trial.stdout ?? "").split(/\r?\n/)) {
    if (line.startsWith("STEP:")) steps.push(line.slice("STEP:".length).trim());
    if (line.startsWith("DONE:")) done = line.slice("DONE:".length).trim();
  }
  const inputs =
    trial.input && typeof trial.input === "object" && !Array.isArray(trial.input)
      ? Object.keys(trial.input)
      : [];
  return validatePlaybook({
    name,
    description: description ?? trial.hypothesis,
    trigger: task,
    inputs,
    steps: steps.length > 0 ? steps : ["Run the operation block in the sandbox."],
    done: done || "The operation exits 0.",
    code_blocks: [
      {
        id: "ops",
        language: "javascript",
        purpose: trial.hypothesis,
        body: trial.script,
      },
    ],
  });
}

/** Replace procedure text and upsert or drop code blocks. The result stays a playbook. */
export function modifyPlaybook(playbook, change = {}) {
  const current = validatePlaybook(playbook);
  const blocks = new Map(current.code_blocks.map((block) => [block.id, { ...block }]));
  for (const id of change.remove_code_blocks ?? []) blocks.delete(id);
  for (const block of change.upsert_code_blocks ?? []) {
    blocks.set(block.id, block);
  }
  return validatePlaybook({
    ...current,
    description: change.description ?? current.description,
    trigger: change.trigger ?? current.trigger,
    inputs: change.inputs ?? current.inputs,
    steps: change.steps ?? current.steps,
    done: change.done ?? current.done,
    code_blocks: [...blocks.values()],
  });
}

/**
 * Apply an L1 rewrite. Only skill playbooks change. Tools, prompts, policies,
 * and every other genome field are copied from the parent unchanged.
 */
export function rewriteSkillLayer(genome, request = {}) {
  const playbooks = request.playbooks ?? [];
  const remove = request.remove ?? [];
  if (playbooks.length === 0 && remove.length === 0) {
    throw new Error("L1 skill rewrite requires a playbook change.");
  }
  const operations = [
    ...remove.map((name) => ({ op: "remove_skill", name })),
    ...playbooks.map((playbook) => {
      const valid = validatePlaybook(playbook);
      return {
        op: "upsert_skill",
        name: valid.name,
        value: {
          description: valid.description,
          content: renderPlaybook(valid),
        },
      };
    }),
  ];
  const patch = {
    hypothesis: request.hypothesis,
    expected_effect: request.expected_effect,
    risks: request.risks,
    operations,
  };
  validateHarnessPatch(patch, { allowedOperations: [...L1_SKILL_OPERATIONS] });
  const rewritten = applyHarnessPatch(genome, patch);
  const next = cloneJson(genome);
  next.skills = rewritten.skills;
  next.parent_id = rewritten.parent_id;
  next.version = rewritten.version;
  next.genome_id = rewritten.genome_id;
  const checked = validateHarnessGenome(next);
  const parentRest = { ...genome };
  const nextRest = { ...checked };
  for (const field of ["skills", "parent_id", "version", "genome_id"]) {
    delete parentRest[field];
    delete nextRest[field];
  }
  if (canonicalJson(parentRest) !== canonicalJson(nextRest)) {
    throw new Error("L1 skill rewrite changed a layer above skills.");
  }
  return checked;
}
