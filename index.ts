import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATE_TYPE = "herdr-subagents-state";
const MAX_TASKS = 4;
const DEFAULT_WAIT_TIMEOUT_MS = 300000;
const DEFAULT_LINES = 30;
const MAX_MESSAGES = 200;
const MESSAGE_SOURCE = "pi-herdr-subagents";
const SESSION_DIR = join(getAgentDir(), "extensions", "herdr-subagents", "sessions");

type Role = "research" | "implement" | "review";
type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type MessageKind = "finding" | "question" | "status" | "ack";
type MessageDelivery = "reported" | "target_missing" | "report_failed";

type SpawnTask = {
  task: string;
  role?: Role;
  model?: string;
};

type SubagentPane = {
  paneId: string;
  role: Role;
  task: string;
  cwd: string;
  createdAt: number;
  batchId: string;
  supervisorPaneId: string;
  sessionPath?: string;
  jcodeSessionPath?: string;
  agentName?: string;
  model?: string;
  thinking?: Thinking;
  command?: string;
  agentKind?: SubagentAgentKind;
  promptMode?: "herdr-agent" | "raw-pane";
  jcodeFallbackReason?: string;
};

type NormalizedSpawnTask = {
  task: string;
  role: Role;
  model?: string;
};

type SubagentMessage = {
  messageId: string;
  fromPaneId: string;
  toPaneId: string;
  kind: MessageKind;
  body: string;
  createdAt: number;
  delivery: MessageDelivery;
  ttlMs?: number;
  error?: string;
};

type PersistedState = {
  agents: SubagentPane[];
  messages?: SubagentMessage[];
};

type PaneInfo = {
  pane_id: string;
  agent?: string;
  agent_status?: string;
  cwd?: string;
  foreground_cwd?: string;
  focused?: boolean;
  workspace_id?: string;
  tab_id?: string;
};

type HerdrPaneListResult = {
  result?: {
    panes?: PaneInfo[];
  };
};

type CollectSource = "session" | "pane-fallback" | "missing";

type CompletionPollOperations = {
  insideHerdr: () => boolean;
  getAgents: () => SubagentPane[];
  listPanes: () => Promise<PaneInfo[]>;
  notifyCompletion: (agent: SubagentPane, status: string) => Promise<void>;
};

function agentLifecycleKey(agent: SubagentPane): string {
  return `${agent.batchId}:${agent.createdAt}:${agent.paneId}`;
}

function createCompletionPollState(operations: CompletionPollOperations) {
  let polling = false;
  let generation = 0;
  let notificationEpoch = 0;
  const observedActive = new Set<string>();
  const notified = new Set<string>();

  const reset = (preserveNotifications = false, preserveObservedActive = false) => {
    generation += 1;
    if (!preserveObservedActive) observedActive.clear();
    if (!preserveNotifications) {
      notified.clear();
      notificationEpoch += 1;
    }
  };

  const markActive = (agents: SubagentPane[]) => {
    for (const agent of agents) observedActive.add(agentLifecycleKey(agent));
  };

  const poll = async (): Promise<boolean> => {
    if (polling) return false;
    polling = true;
    const pollGeneration = generation;
    const pollNotificationEpoch = notificationEpoch;
    try {
      const agents = operations.getAgents();
      if (!operations.insideHerdr() || agents.length === 0) return true;
      const panes = await operations.listPanes();
      if (pollGeneration !== generation) return true;
      const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));

      for (const agent of agents) {
        if (pollGeneration !== generation) break;
        const status = byId.get(agent.paneId)?.agent_status;
        if (!status) continue;
        const key = agentLifecycleKey(agent);
        const settled = status === "idle" || status === "done";
        if (!settled) {
          observedActive.add(key);
          continue;
        }
        if (!observedActive.has(key) || notified.has(key)) continue;
        try {
          await operations.notifyCompletion(agent, status);
          if (pollNotificationEpoch === notificationEpoch) notified.add(key);
        } catch {
          // Keep this completion eligible for a later poll; one notification error
          // must not stop polling or suppress the eventual notification.
        }
      }
      return true;
    } finally {
      polling = false;
    }
  };

  return {
    poll,
    reset,
    isPolling: () => polling,
    hasNotified: (agent: SubagentPane) => notified.has(agentLifecycleKey(agent)),
    markActive,
  };
}

const roleSchema = Type.Union([
  Type.Literal("research"),
  Type.Literal("implement"),
  Type.Literal("review"),
], { description: "Subagent role" });

const taskItemSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object({
    task: Type.String({ minLength: 1, description: "Task prompt" }),
    role: Type.Optional(roleSchema),
    model: Type.Optional(Type.String({ description: "Optional per-task model override" })),
  }),
]);

const spawnParams = Type.Object({
  tasks: Type.Array(taskItemSchema, { minItems: 1, maxItems: MAX_TASKS, description: `Tasks to run in parallel (max ${MAX_TASKS})` }),
  role: Type.Optional(roleSchema),
  model: Type.Optional(Type.String({ description: "Optional default pi model override" })),
  thinking: Type.Optional(Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
  ], { description: "Thinking level override" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for spawned panes" })),
});

const statusParams = Type.Object({
  includeDone: Type.Optional(Type.Boolean({ description: "Include done panes" })),
  latestOnly: Type.Optional(Type.Boolean({ description: "Show only the most recent spawned batch" })),
});

const collectParams = Type.Object({
  wait: Type.Optional(Type.Boolean({ description: "Wait until all spawned panes are idle or done" })),
  lines: Type.Optional(Type.Number({ minimum: 5, maximum: 200, description: "How many recent lines to read per pane" })),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 1800000, description: "Wait timeout in milliseconds" })),
  latestOnly: Type.Optional(Type.Boolean({ description: "Collect only the most recent spawned batch" })),
  closePanes: Type.Optional(Type.Boolean({ description: "Close collected idle/done panes and clear their tracking; defaults to true" })),
});

const clearParams = Type.Object({
  closePanes: Type.Optional(Type.Boolean({ description: "Close tracked panes before clearing them; defaults to true" })),
  latestOnly: Type.Optional(Type.Boolean({ description: "Clear only the most recent spawned batch" })),
});

const interruptParams = Type.Object({
  paneId: Type.Optional(Type.String({ description: "Interrupt one tracked pane by pane id" })),
  latestOnly: Type.Optional(Type.Boolean({ description: "Interrupt only the most recent spawned batch" })),
});

const globalStatusParams = Type.Object({
  lines: Type.Optional(Type.Number({ minimum: 10, maximum: 200, description: "How many recent lines to inspect per pane" })),
  includeAllPiPanes: Type.Optional(Type.Boolean({ description: "Include all pi panes even if they do not look like subagents" })),
});
const messageKindSchema = Type.Union([
  Type.Literal("finding"),
  Type.Literal("question"),
  Type.Literal("status"),
  Type.Literal("ack"),
], { description: "Structured subagent message kind" });

const messageParams = Type.Object({
  toPaneId: Type.String({ minLength: 1, description: "Target pane id" }),
  body: Type.String({ minLength: 1, description: "Message body" }),
  kind: Type.Optional(messageKindSchema),
  fromPaneId: Type.Optional(Type.String({ minLength: 1, description: "Logical sender pane id for relayed messages" })),
  messageId: Type.Optional(Type.String({ minLength: 1, description: "Optional caller-supplied message id" })),
  ttlMs: Type.Optional(Type.Number({ minimum: 1, maximum: 86400000, description: "Optional metadata TTL in milliseconds" })),
});

const messageLogParams = Type.Object({
  paneId: Type.Optional(Type.String({ minLength: 1, description: "Filter messages involving one pane id" })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Maximum messages to return" })),
});

function insideHerdr(): boolean {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
}

function requireHerdr() {
  if (!insideHerdr()) {
    throw new Error("This extension only works inside a herdr-managed pane (HERDR_ENV=1).");
  }
}

function normalizeSpawnTasks(tasks: Array<string | SpawnTask>, defaultRole: Role, defaultModel?: string): NormalizedSpawnTask[] {
  return tasks.map((item) => {
    if (typeof item === "string") {
      return { task: item, role: defaultRole, model: defaultModel };
    }
    return { task: item.task, role: item.role ?? defaultRole, model: item.model ?? defaultModel };
  });
}

function validateRequestedModels(
  tasks: NormalizedSpawnTask[],
  availableModelIds: string[],
): { requested: string[]; available: string[] } {
  const available = [...new Set(availableModelIds)].sort();
  const availableSet = new Set(available);
  const requested = [...new Set(tasks.flatMap((task) => task.model ? [task.model] : []))];
  const unavailable = requested.filter((model) => !availableSet.has(model));

  if (unavailable.length > 0) {
    throw new Error([
      `Unavailable subagent model(s): ${unavailable.join(", ")}.`,
      `Available models (${available.length}):`,
      ...available.map((model) => `- ${model}`),
    ].join("\n"));
  }

  return { requested, available };
}

function buildPrompt(role: Role, task: string): string {
  const shared = [
    "You are a subagent working under a supervisor in herdr.",
    "Stay narrowly scoped to the assigned task.",
    "Be concise and practical.",
  ];

  if (role === "implement") {
    return [
      ...shared,
      "Your role is implementation.",
      "Make only the minimum necessary changes.",
      "When finished, output exactly these headings:",
      "Changed files:",
      "Summary:",
      "Risks:",
      "",
      `Task: ${task}`,
    ].join("\n");
  }

  if (role === "review") {
    return [
      ...shared,
      "Your role is review.",
      "Focus on concrete issues, risk level, and actionable changes.",
      "Do not broaden scope beyond the assigned review angle.",
      "Stop as soon as you have enough evidence for a concise review.",
      "When finished, output exactly these headings:",
      "Findings:",
      "Severity:",
      "Recommended changes:",
      "",
      `Task: ${task}`,
    ].join("\n");
  }

  return [
    ...shared,
    "Your role is research.",
    "Do not implement changes unless explicitly asked.",
    "Keep the scope narrow and answer only the assigned question.",
    "Use the fastest sufficient path.",
    "Do not use codegraph_status as a research starting step.",
    "Prefer codegraph_explore, codegraph_search, or codegraph_files first when CodeGraph is useful.",
    "If your first tool choice fails or is unavailable, immediately fall back to another tool and continue.",
    "Do not spend time repeatedly retrying broken tooling.",
    "Do at most 5 meaningful tool actions before producing an answer.",
    "If one test/analyze run already passed, do not repeat it unless a specific failure requires it.",
    "If you already have one medium-risk finding or two low-risk findings with evidence, stop.",
    "Stop as soon as you have enough evidence for a concise answer.",
    "When finished, output exactly these headings:",
    "Conclusion:",
    "Evidence:",
    "Unknowns:",
    "",
    `Task: ${task}`,
  ].join("\n");
}

async function runHerdr(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("herdr", args, { maxBuffer: 1024 * 1024 * 4 });
  if (stderr?.trim()) {
    // herdr often writes useful json to stdout even when stderr is empty; ignore stderr noise here
  }
  return stdout;
}

async function listPanes(): Promise<PaneInfo[]> {
  const stdout = await runHerdr(["pane", "list"]);
  const parsed = JSON.parse(stdout) as HerdrPaneListResult;
  return parsed.result?.panes ?? [];
}

type SplitDirection = "right" | "down";

type SplitTarget = {
  paneId: string;
  depth: number;
};

class UnknownSplitOutcomeError extends Error {}

type SubagentAgentKind = "jcode" | "pi";

type SpawnedSubagentPane = SubagentPane & {
  sessionPath: string;
  agentName: string;
  command: string;
};

type StartedSubagentAgent = {
  kind: SubagentAgentKind;
  args: string[];
  command: string;
  promptMode: "herdr-agent" | "raw-pane";
  fallbackReason?: string;
  jcodeSessionPath?: string;
};

type SpawnTransactionOperations = {
  split: (sourcePaneId: string, direction: SplitDirection, cwd: string) => Promise<string>;
  prepare: (item: NormalizedSpawnTask, index: number) => Promise<Omit<SpawnedSubagentPane, "paneId">>;
  rename: (agent: SpawnedSubagentPane) => Promise<void>;
  start: (agent: SpawnedSubagentPane) => Promise<void>;
  prompt: (agent: SpawnedSubagentPane) => Promise<void>;
  close: (paneId: string) => Promise<void>;
  listPaneIds: () => Promise<Set<string>>;
  getTracked: () => SubagentPane[];
  setTracked: (agents: SubagentPane[]) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupCreatedPanes(
  created: SubagentPane[],
  operations: Pick<SpawnTransactionOperations, "close" | "listPaneIds">,
): Promise<SubagentPane[]> {
  const closeFailures: SubagentPane[] = [];
  for (const agent of created) {
    try {
      await operations.close(agent.paneId);
    } catch {
      closeFailures.push(agent);
    }
  }

  if (closeFailures.length === 0) return [];

  try {
    const livePaneIds = await operations.listPaneIds();
    return closeFailures.filter((agent) => livePaneIds.has(agent.paneId));
  } catch {
    // If liveness cannot be confirmed, retain ownership so a later clear can retry safely.
    return closeFailures;
  }
}

async function spawnSubagentsTransactional(
  tasks: NormalizedSpawnTask[],
  sourcePane: string,
  cwd: string,
  operations: SpawnTransactionOperations,
): Promise<SpawnedSubagentPane[]> {
  const created: SpawnedSubagentPane[] = [];
  const workerSplitTargets: SplitTarget[] = [];

  try {
    for (const [index, item] of tasks.entries()) {
      const target = index === 0 ? undefined : workerSplitTargets.shift();
      if (index > 0 && !target) {
        throw new Error("No worker pane available for the next subagent.");
      }

      const targetPaneId = target?.paneId ?? sourcePane;
      const direction: SplitDirection = !target
        ? "right"
        : target.depth % 2 === 0
          ? "down"
          : "right";
      const preparedAgent = await operations.prepare(item, index);
      const paneId = await operations.split(targetPaneId, direction, cwd);
      const agent: SpawnedSubagentPane = { ...preparedAgent, paneId };

      // Record ownership before any operation on the new pane can fail.
      created.push(agent);
      operations.setTracked([...operations.getTracked(), agent]);

      if (!target) {
        workerSplitTargets.push({ paneId, depth: 0 });
      } else {
        const childDepth = target.depth + 1;
        workerSplitTargets.push(
          { paneId: targetPaneId, depth: childDepth },
          { paneId, depth: childDepth },
        );
      }

      await operations.rename(agent);
      await operations.start(agent);
      await operations.prompt(agent);
    }

    return created;
  } catch (error) {
    const retained = await cleanupCreatedPanes(created, operations);
    const createdIds = new Set(created.map((agent) => agent.paneId));
    const nextTracked = [
      ...operations.getTracked().filter((agent) => !createdIds.has(agent.paneId)),
      ...retained,
    ];

    let persistenceFailure: unknown;
    try {
      operations.setTracked(nextTracked);
    } catch (persistError) {
      persistenceFailure = persistError;
    }

    const retainedText = retained.length > 0
      ? ` Cleanup could not close pane(s) that remain tracked: ${retained.map((agent) => agent.paneId).join(", ")}.`
      : error instanceof UnknownSplitOutcomeError
        ? " All panes created by this call with known IDs were cleaned up."
        : " All panes created by this call were cleaned up.";
    const unknownSplitText = error instanceof UnknownSplitOutcomeError
      ? " Unable to determine whether the failed split created an additional untracked pane; inspect Herdr."
      : "";
    const persistenceText = persistenceFailure
      ? ` Persisting cleanup state also failed: ${errorMessage(persistenceFailure)}.`
      : "";
    throw new Error(`Failed to spawn herdr subagents: ${errorMessage(error)}.${retainedText}${unknownSplitText}${persistenceText}`, { cause: error });
  }
}

function parseSplitPaneId(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as { result?: { pane?: { pane_id?: string } } };
    return parsed.result?.pane?.pane_id;
  } catch {
    return undefined;
  }
}

async function splitPane(
  sourcePaneId: string,
  direction: SplitDirection,
  cwd?: string,
  execute: (args: string[]) => Promise<string> = runHerdr,
): Promise<string> {
  const args = ["pane", "split", sourcePaneId, "--direction", direction, "--no-focus"];
  if (cwd) args.push("--cwd", cwd);

  let stdout: string;
  try {
    stdout = await execute(args);
  } catch (error) {
    const errorStdout = typeof error === "object" && error !== null && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "")
      : "";
    const recoveredPaneId = parseSplitPaneId(errorStdout);
    if (recoveredPaneId) return recoveredPaneId;
    throw new UnknownSplitOutcomeError(`Herdr split failed without a recoverable pane ID: ${errorMessage(error)}`, { cause: error });
  }

  const paneId = parseSplitPaneId(stdout);
  if (!paneId) throw new UnknownSplitOutcomeError("Failed to parse new pane id from herdr pane split output.");
  return paneId;
}

async function paneRename(paneId: string, title: string): Promise<void> {
  await runHerdr(["pane", "rename", paneId, title]);
}

function herdrErrorCode(error: unknown): string | undefined {
  const values: unknown[] = [];
  if (typeof error === "object" && error !== null) {
    values.push((error as { stdout?: unknown }).stdout, (error as { stderr?: unknown }).stderr);
  }
  if (error instanceof Error) values.push(error.message);

  for (const value of values) {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
    for (const line of text.split(/\r?\n/).reverse()) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) continue;
      try {
        const payload = JSON.parse(candidate) as { error?: { code?: string } };
        if (payload.error?.code) return payload.error.code;
      } catch {
        // Ignore command text and non-JSON diagnostics.
      }
    }
  }
  return undefined;
}

type AgentStartOperations = {
  run: (args: string[]) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  listPanes?: () => Promise<PaneInfo[]>;
  maxAttempts?: number;
};

const defaultAgentStartOperations: AgentStartOperations = {
  run: runHerdr,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  listPanes,
};

function buildJcodeArgs(cwd: string, model?: string): string[] {
  const args = ["--no-update", "-C", cwd];
  const modelParts = parseProviderModel(model);
  if (modelParts?.provider === "github-copilot") args.push("--provider", "copilot");
  if (modelParts?.model) args.push("--model", modelParts.model);
  return args;
}

function buildJcodeLaunchCommand(jcodeArgs: string[]): string[] {
  const provider = valueAfterArg(jcodeArgs, "--provider");
  const model = valueAfterArg(jcodeArgs, "--model");
  if (provider === "copilot" && model) {
    return ["env", `JCODE_COPILOT_MODEL=${model}`, "jcode", ...jcodeArgs];
  }
  return ["jcode", ...jcodeArgs];
}

function valueAfterArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseProviderModel(model: string | undefined): { provider?: string; model: string } | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { model: trimmed };
  const provider = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1);
  return modelId ? { provider, model: modelId } : { model: trimmed };
}

function buildAgentStartArgs(
  paneId: string,
  agentName: string,
  kind: SubagentAgentKind,
  agentArgs: string[],
): string[] {
  return [
    "agent",
    "start",
    agentName,
    "--kind",
    kind,
    "--pane",
    paneId,
    "--timeout",
    "60000",
    "--",
    ...agentArgs,
  ];
}

async function startAgentKind(
  paneId: string,
  agentName: string,
  kind: SubagentAgentKind,
  agentArgs: string[],
  operations: AgentStartOperations = defaultAgentStartOperations,
): Promise<void> {
  const args = buildAgentStartArgs(paneId, agentName, kind, agentArgs);
  const maxAttempts = operations.maxAttempts ?? 40;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("startAgentKind maxAttempts must be a positive integer.");
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await operations.run(args);
      return;
    } catch (error) {
      const paneBusy = herdrErrorCode(error) === "agent_pane_busy";
      if (!paneBusy || attempt === maxAttempts) throw error;
      await operations.sleep(100);
    }
  }
}

async function startPiAgent(
  paneId: string,
  agentName: string,
  piArgs: string[],
  operations: AgentStartOperations = defaultAgentStartOperations,
): Promise<void> {
  try {
    await startAgentKind(paneId, agentName, "pi", piArgs, operations);
  } catch (error) {
    if (error instanceof Error && error.message === "startAgentKind maxAttempts must be a positive integer.") {
      throw new Error("startPiAgent maxAttempts must be a positive integer.");
    }
    throw error;
  }
}

async function startPreferredSubagentAgent(
  paneId: string,
  agentName: string,
  jcodeArgs: string[],
  piArgs: string[],
  operations: AgentStartOperations = defaultAgentStartOperations,
): Promise<StartedSubagentAgent> {
  let jcodeError: unknown;
  try {
    const jcodeSessionPath = await startRawJcodeAgent(paneId, jcodeArgs, operations);
    return {
      kind: "jcode",
      args: jcodeArgs,
      command: buildJcodeLaunchCommand(jcodeArgs).map(shellQuote).join(" "),
      promptMode: "raw-pane",
      jcodeSessionPath,
    };
  } catch (error) {
    jcodeError = error;
  }

  try {
    await startAgentKind(paneId, agentName, "pi", piArgs, operations);
    return {
      kind: "pi",
      args: piArgs,
      command: ["pi", ...piArgs].map(shellQuote).join(" "),
      promptMode: "herdr-agent",
      fallbackReason: errorMessage(jcodeError),
    };
  } catch (error) {
    throw new Error(
      `Failed to start raw jcode subagent (${errorMessage(jcodeError)}); fallback pi also failed (${errorMessage(error)}).`,
      { cause: error },
    );
  }
}

async function startRawJcodeAgent(
  paneId: string,
  jcodeArgs: string[],
  operations: AgentStartOperations = defaultAgentStartOperations,
): Promise<string | undefined> {
  const cwd = jcodeArgs[jcodeArgs.indexOf("-C") + 1];
  const startedAfterMs = Date.now() - 1000;
  const maxAttempts = operations.maxAttempts ?? 40;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("startRawJcodeAgent maxAttempts must be a positive integer.");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await operations.run(["pane", "run", paneId, ...buildJcodeLaunchCommand(jcodeArgs)]);
      await waitForPaneAgentKind(paneId, "jcode", 10000, operations);
      await waitForPaneText(paneId, "1>", 30000, operations);
      return cwd ? await findLatestJcodeSessionPath(cwd, startedAfterMs) : undefined;
    } catch (error) {
      const paneBusy = herdrErrorCode(error) === "pane_not_ready" || herdrErrorCode(error) === "agent_pane_busy";
      if (!paneBusy || attempt === maxAttempts) throw error;
      await operations.sleep(100);
    }
  }
}

async function findLatestJcodeSessionPath(cwd: string, startedAfterMs: number, promptNeedle?: string): Promise<string | undefined> {
  const sessionsDir = join(process.env.JCODE_HOME ?? join(process.env.HOME ?? "", ".jcode"), "sessions");
  try {
    const entries = await fs.readdir(sessionsDir);
    const candidates = await Promise.all(entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const path = join(sessionsDir, entry);
        const stat = await fs.stat(path);
        return { path, mtimeMs: stat.mtimeMs };
      }));

    for (const candidate of candidates
      .filter((candidate) => candidate.mtimeMs >= startedAfterMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      const raw = await fs.readFile(candidate.path, "utf8").catch(() => "");
      if (!raw.includes(`Working directory: ${cwd}`)) continue;
      if (promptNeedle && !raw.includes(promptNeedle)) continue;
      return candidate.path;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function waitForPaneText(
  paneId: string,
  text: string,
  timeoutMs: number,
  operations: Pick<AgentStartOperations, "run"> = defaultAgentStartOperations,
): Promise<void> {
  await operations.run([
    "pane",
    "wait-output",
    "--match",
    text,
    "--source",
    "recent",
    "--lines",
    "120",
    "--timeout",
    String(timeoutMs),
    paneId,
  ]);
}

async function waitForPaneAgentKind(
  paneId: string,
  kind: SubagentAgentKind,
  timeoutMs: number,
  operations: Pick<AgentStartOperations, "listPanes" | "sleep"> = defaultAgentStartOperations,
): Promise<void> {
  const list = operations.listPanes ?? listPanes;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pane = (await list()).find((candidate) => candidate.pane_id === paneId);
    if (pane?.agent === kind) return;
    await operations.sleep(250);
  }
  throw new Error(`Timed out waiting for pane ${paneId} to report agent kind ${kind}.`);
}

async function agentPrompt(
  agentName: string,
  prompt: string,
  execute: (args: string[]) => Promise<string> = runHerdr,
): Promise<void> {
  try {
    await execute([
      "agent",
      "prompt",
      agentName,
      prompt,
      "--wait",
      "--until",
      "working",
      "--timeout",
      "10000",
    ]);
  } catch (error) {
    if (herdrErrorCode(error) !== "agent_prompt_stalled") throw error;

    await execute(["agent", "send-keys", agentName, "enter"]);
    await execute(["agent", "wait", agentName, "--until", "working", "--timeout", "10000"]);
  }
}

async function panePrompt(
  paneId: string,
  prompt: string,
  execute: (args: string[]) => Promise<string> = runHerdr,
): Promise<void> {
  await execute(["pane", "send-text", paneId, prompt]);
  await execute(["pane", "send-keys", paneId, "enter"]);
}

async function paneRead(paneId: string, lines: number): Promise<string> {
  return runHerdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
}

async function paneClose(paneId: string): Promise<void> {
  await runHerdr(["pane", "close", paneId]);
}

async function paneSendKeys(paneId: string, keys: string): Promise<void> {
  await runHerdr(["pane", "send-keys", paneId, keys]);
}

function encodeNotifyPayload(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function decodeNotifyPayload(encoded: string): Record<string, string> | undefined {
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, string>;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sanitizePaneTitle(value: string): string {
  return value
    .replace(/[\u0007\u001b]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makePaneTitle(role: Role, task: string): string {
  const simplifiedTask = task
    .replace(/^Review jj diff\s+\S+\s+/i, "")
    .replace(/^for\s+/i, "")
    .replace(/^Reply with exactly one word:\s*/i, "")
    .trim();
  const shortenedTask = simplifiedTask.length > 42 ? `${simplifiedTask.slice(0, 41)}…` : simplifiedTask;
  return sanitizePaneTitle(`${role}: ${shortenedTask || "subagent"}`);
}

function buildPiArgs(sessionPath: string, model?: string, thinking?: Thinking): string[] {
  const args = ["--session", sessionPath];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  return args;
}

function makeAgentName(role: Role, index: number, batchId: string): string {
  const batchSuffix = batchId.split("-").at(-1) ?? "batch";
  return `${role}-${index + 1}-${batchSuffix}`.slice(0, 32);
}

function formatStatusLine(agent: SubagentPane, live?: PaneInfo): string {
  const status = live?.agent_status ?? "missing";
  const nameText = agent.agentName ? ` {agent=${agent.agentName}}` : "";
  const modelText = agent.model ? ` {model=${agent.model}}` : "";
  return `- ${agent.paneId} [${status}] (${agent.role})${nameText}${modelText} ${agent.task}`;
}

function clip(text: string, max = 500): string {
  const compact = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-8).join("\n");
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function isStructuredHeader(line: string, header: string): boolean {
  const normalized = line.trim().toLowerCase();
  return normalized === header
    || normalized === `${header}:`
    || normalized === `1. ${header}`
    || normalized === `1. ${header}:`
    || normalized === `2. ${header}`
    || normalized === `2. ${header}:`
    || normalized === `3. ${header}`
    || normalized === `3. ${header}:`;
}

function extractStructuredSections(role: Role, text: string): Partial<Record<string, string>> {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const headers = role === "implement"
    ? ["changed files", "summary", "risks"]
    : role === "review"
      ? ["findings", "severity", "recommended changes"]
      : ["conclusion", "evidence", "unknowns"];

  const result: Partial<Record<string, string>> = {};
  for (const header of headers) {
    const idx = lines.findIndex((line) => isStructuredHeader(line, header));
    if (idx === -1) continue;

    const block: string[] = [];
    for (let i = idx; i < lines.length; i += 1) {
      const current = lines[i];
      if (!current) {
        if (block.length > 0) break;
        continue;
      }
      if (i > idx && headers.some((other) => isStructuredHeader(current, other))) {
        break;
      }
      block.push(current);
    }

    const body = block.slice(1).filter(Boolean);
    if (block.length > 0 && body.length > 0) {
      result[header] = block.join("\n");
    }
  }

  return result;
}

function extractErrorSummary(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const match = lines.find((line) => /^(error:|api_error\b|authenticationerror\b|incorrect api key provided\b|.*copilot api error\b|.*api error\b|.*model_not_available\b)/i.test(line));
  if (!match) return undefined;
  const normalized = match.replace(/^error:\s*/i, "");
  return `Error: ${normalized}`;
}

function looksLikePaneUiNoise(text: string): boolean {
  return text.includes("Pi can explain its own features and look up its docs.")
    || text.includes("Press ctrl+o to show full startup help and loaded resources.")
    || text.includes("[Prompts]")
    || text.includes("[Extensions]")
    || text.includes("[Themes]")
    || text.includes("Reloaded keybindings, extensions, skills, prompts, themes");
}

function extractPaneFallbackSummary(role: Role, text: string): string | undefined {
  const structured = extractStructuredSummary(role, text);
  if (structured) return structured;

  const error = extractErrorSummary(text);
  if (error) return error;

  if (looksLikePaneUiNoise(text)) return undefined;
  return undefined;
}

function extractStructuredSummary(role: Role, text: string): string | undefined {
  const sections = extractStructuredSections(role, text);
  const orderedKeys = role === "implement"
    ? ["changed files", "summary", "risks"]
    : role === "review"
      ? ["findings", "severity", "recommended changes"]
      : ["conclusion", "evidence", "unknowns"];
  const matches = orderedKeys.map((key) => sections[key]).filter((value): value is string => Boolean(value));
  if (matches.length === 0) return undefined;
  return matches.join("\n\n");
}

function firstMeaningfulLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  if (lines.length === 1) return lines[0];
  const head = lines[0].replace(/:$/, "");
  const next = lines[1];
  return next ? `${head}: ${next}` : lines[0];
}

function extractTaskLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("Task:")) return line.slice(5).trim();
  }
  return undefined;
}

function detectRoleFromOutput(text: string): Role | undefined {
  const normalized = text.toLowerCase();
  if (normalized.includes("your role is research.")) return "research";
  if (normalized.includes("your role is implementation.")) return "implement";
  if (normalized.includes("your role is review.")) return "review";
  return undefined;
}

function looksLikeSubagentOutput(text: string): boolean {
  return text.includes("You are a subagent working under a supervisor in herdr.")
    || text.includes("Conclusion:")
    || text.includes("Changed files:")
    || text.includes("Findings:");
}

function buildCollectSynthesis(items: Array<{ paneId: string; role: Role; task: string; sections: Partial<Record<string, string>>; excerpt: string; status: string }>): string | undefined {
  if (items.length === 0) return undefined;

  const combinedFindings = items.map((item) => {
    const key = item.role === "implement" ? "summary" : item.role === "review" ? "findings" : "conclusion";
    const primary = firstMeaningfulLine(item.sections[key]) ?? firstMeaningfulLine(item.excerpt) ?? "No summary available.";
    return `- ${item.paneId} (${item.role}) ${primary}`;
  });

  const risks = items.flatMap((item) => {
    const key = item.role === "implement" ? "risks" : item.role === "review" ? "severity" : "unknowns";
    const value = firstMeaningfulLine(item.sections[key]);
    return value ? [`- ${item.paneId}: ${value}`] : [];
  });

  const nextStep = items.some((item) => item.role === "implement")
    ? "Review the implementation-oriented pane results first, then decide whether follow-up code changes or verification are needed."
    : items.some((item) => item.role === "review")
      ? "Review the reviewer findings and severity notes, then decide whether the issues warrant follow-up fixes or can be accepted."
      : "Review the research conclusions, resolve the main unknowns, then decide whether to spawn implementation work.";

  const parts = [
    "# Synthesis",
    "",
    "Combined findings:",
    ...combinedFindings,
  ];

  if (risks.length > 0) {
    parts.push("", "Open risks / unknowns:", ...risks);
  }

  parts.push("", `Suggested next step: ${nextStep}`);
  return parts.join("\n");
}

function persistState(pi: ExtensionAPI, agents: SubagentPane[], messages: SubagentMessage[]) {
  pi.appendEntry<PersistedState>(STATE_TYPE, { agents, messages });
}

function restoreState(ctx: ExtensionContext): PersistedState {
  const branch = ctx.sessionManager.getBranch();
  let last: PersistedState = { agents: [], messages: [] };
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === STATE_TYPE) {
      const data = entry.data as PersistedState | undefined;
      if (Array.isArray(data?.agents)) {
        last = {
          agents: data.agents,
          messages: Array.isArray(data.messages) ? data.messages : [],
        };
      }
    }
  }
  return last;
}

function makeSessionPath(): string {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(16).slice(2, 10)}`;
  return join(SESSION_DIR, `${id}.jsonl`);
}

function makeBatchId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function getLatestBatchId(list: SubagentPane[]): string | undefined {
  let latest: SubagentPane | undefined;
  for (const agent of list) {
    if (!latest || agent.createdAt > latest.createdAt) latest = agent;
  }
  return latest?.batchId;
}
function makeMessageId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function compactMessageBody(body: string, max = 60): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function formatMessageTitle(kind: MessageKind, fromPaneId: string): string {
  return compactMessageBody(`${kind} from ${fromPaneId}`, 80);
}

function formatMessageStatus(kind: MessageKind): string {
  return compactMessageBody(`message: ${kind}`, 32);
}

async function herdrSocketCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error("HERDR_SOCKET_PATH is not available in this pane.");

  const id = `req-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  return await new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.end();
      fn();
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}
`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as { id?: string; result?: T; error?: { message?: string } };
          if (message.id !== id) continue;
          if (message.error) {
            finish(() => reject(new Error(message.error?.message ?? `Herdr socket call failed: ${method}`)));
            return;
          }
          finish(() => resolve(message.result as T));
          return;
        } catch (error) {
          finish(() => reject(error));
          return;
        }
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("end", () => {
      if (!settled) {
        settled = true;
        reject(new Error(`Herdr socket closed before responding to ${method}.`));
      }
    });
  });
}

async function reportMessageMetadata(message: SubagentMessage): Promise<void> {
  await herdrSocketCall("pane.report_metadata", {
    pane_id: message.toPaneId,
    source: MESSAGE_SOURCE,
    title: formatMessageTitle(message.kind, message.fromPaneId),
    custom_status: formatMessageStatus(message.kind),
    ttl_ms: message.ttlMs,
    seq: message.createdAt,
  });
}

async function reportCompletionMetadata(agent: SubagentPane): Promise<void> {
  await herdrSocketCall("pane.report_metadata", {
    pane_id: agent.supervisorPaneId,
    source: MESSAGE_SOURCE,
    title: `Subagent done: ${agent.paneId} (${agent.role})`,
    custom_status: "subagent done",
    ttl_ms: 10000,
    seq: Date.now(),
  });
}

function renderMessageLine(message: SubagentMessage): string {
  const statusText = message.delivery === "reported"
    ? "reported"
    : message.delivery === "target_missing"
      ? "target missing"
      : `report failed${message.error ? `: ${message.error}` : ""}`;
  return `- ${message.messageId} [${message.kind}] ${message.fromPaneId} -> ${message.toPaneId} (${statusText}) ${compactMessageBody(message.body, 120)}`;
}

function keepRecentMessages(messages: SubagentMessage[]): SubagentMessage[] {
  return messages.slice(-MAX_MESSAGES);
}


function filterAgentsByBatch(list: SubagentPane[], latestOnly?: boolean): SubagentPane[] {
  if (!latestOnly) return list;
  const latestBatchId = getLatestBatchId(list);
  return latestBatchId ? list.filter((agent) => agent.batchId === latestBatchId) : list;
}

function partitionCollectCleanupCandidates(
  targetAgents: SubagentPane[],
  byId: Map<string, PaneInfo>,
): { closeCandidates: SubagentPane[]; missingCandidates: SubagentPane[] } {
  const closeCandidates: SubagentPane[] = [];
  const missingCandidates: SubagentPane[] = [];

  for (const agent of targetAgents) {
    const pane = byId.get(agent.paneId);
    if (!pane) {
      missingCandidates.push(agent);
    } else if (pane.agent_status === "idle" || pane.agent_status === "done") {
      closeCandidates.push(agent);
    }
  }

  return { closeCandidates, missingCandidates };
}

async function extractAssistantTextFromSession(sessionPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(sessionPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const entry = JSON.parse(lines[i]) as {
        type?: string;
        message?: {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
          stopReason?: string;
          errorMessage?: string;
        };
      };
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const text = (entry.message.content ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (text) return text;

      const errorMessage = entry.message.errorMessage?.trim();
      if (errorMessage) return `Error: ${errorMessage}`;
      if (entry.message.stopReason === "error") return "Error: assistant response failed without text.";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function extractAssistantTextFromJcodeSession(sessionPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(sessionPath, "utf8");
    const parsed = JSON.parse(raw) as {
      messages?: Array<{
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
        error?: unknown;
        errorMessage?: string;
      }>;
    };
    const messages = parsed.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      const text = (message.content ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (text) return text;
      if (message.errorMessage) return `Error: ${message.errorMessage}`;
      if (message.error) return `Error: ${JSON.stringify(message.error)}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function waitForAgents(
  targetPaneIds: string[],
  timeoutMs: number,
  operations: { listPanes: () => Promise<PaneInfo[]>; sleep: (ms: number) => Promise<void> } = {
    listPanes,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const panes = await operations.listPanes();
    const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
    const missing = targetPaneIds.filter((paneId) => !byId.has(paneId));
    if (missing.length > 0) {
      throw new Error(`Cannot wait for missing tracked pane(s): ${missing.join(", ")}.`);
    }
    const pending = targetPaneIds.filter((paneId) => {
      const status = byId.get(paneId)?.agent_status;
      return status !== "idle" && status !== "done";
    });
    if (pending.length === 0) return;
    await operations.sleep(2000);
  }
  throw new Error(`Timed out waiting for panes to settle after ${timeoutMs}ms.`);
}

function formatCollectSource(source: CollectSource, status: string): string {
  if (source === "session") {
    return status === "missing" ? "session record (tracked pane missing)" : "session record";
  }
  if (source === "pane-fallback") return "live pane fallback (no session result)";
  return status === "missing"
    ? "unavailable (tracked pane missing and no session result)"
    : "unavailable (no session result or usable pane output)";
}

async function readCollectedOutput(
  agent: SubagentPane,
  lines: number,
  graceMs = 0,
): Promise<{ output: string; source: CollectSource }> {
  const tryRead = async (): Promise<{ output: string; source: CollectSource }> => {
    const jcodeSessionPath = agent.promptMode === "raw-pane"
      ? agent.jcodeSessionPath ?? await findLatestJcodeSessionPath(agent.cwd, agent.createdAt - 1000, agent.task)
      : undefined;
    const jcodeSessionText = jcodeSessionPath
      ? await extractAssistantTextFromJcodeSession(jcodeSessionPath)
      : undefined;
    if (jcodeSessionText) return { output: jcodeSessionText, source: "session" };

    const sessionText = agent.sessionPath ? await extractAssistantTextFromSession(agent.sessionPath) : undefined;
    if (sessionText) return { output: sessionText, source: "session" };

    const paneOutput = await paneRead(agent.paneId, lines).catch(() => "");
    const fallback = extractPaneFallbackSummary(agent.role, paneOutput);
    if (fallback) return { output: fallback, source: "pane-fallback" };
    return { output: "", source: "missing" };
  };

  let result = await tryRead();
  if (result.output) return result;

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await tryRead();
    if (result.output) return result;
  }

  return result;
}

// Pure helpers exported only to characterize the extension's existing behavior.
export const __test = {
  normalizeSpawnTasks,
  validateRequestedModels,
  buildJcodeArgs,
  buildJcodeLaunchCommand,
  buildPrompt,
  encodeNotifyPayload,
  decodeNotifyPayload,
  shellQuote,
  sanitizePaneTitle,
  makePaneTitle,
  buildPiArgs,
  extractStructuredSections,
  extractStructuredSummary,
  extractTaskLine,
  detectRoleFromOutput,
  looksLikeSubagentOutput,
  buildCollectSynthesis,
  getLatestBatchId,
  compactMessageBody,
  renderMessageLine,
  keepRecentMessages,
  filterAgentsByBatch,
  partitionCollectCleanupCandidates,
  cleanupCreatedPanes,
  spawnSubagentsTransactional,
  parseSplitPaneId,
  splitPane,
  UnknownSplitOutcomeError,
  createCompletionPollState,
  waitForAgents,
  formatCollectSource,
  formatStatusLine,
  herdrErrorCode,
  startPiAgent,
  startPreferredSubagentAgent,
  agentPrompt,
};

export default function herdrSubagentsExtension(pi: ExtensionAPI) {
  let agents: SubagentPane[] = [];
  let messages: SubagentMessage[] = [];
  let statusPollTimer: NodeJS.Timeout | undefined;

  const refreshFromSession = (ctx: ExtensionContext) => {
    const restored = restoreState(ctx);
    agents = restored.agents;
    messages = Array.isArray(restored.messages) ? restored.messages : [];
  };

  const pruneMissingAgents = async (): Promise<void> => {
    if (agents.length === 0) return;
    const panes = await listPanes();
    const livePaneIds = new Set(panes.map((pane) => pane.pane_id));
    const nextAgents = agents.filter((agent) => livePaneIds.has(agent.paneId));
    if (nextAgents.length !== agents.length) {
      agents = nextAgents;
      persistState(pi, agents, messages);
    }
  };

  const stopStatusPolling = () => {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = undefined;
    }
  };

  let pollingContext: ExtensionContext | undefined;
  const completionPoll = createCompletionPollState({
    insideHerdr,
    getAgents: () => agents,
    listPanes,
    async notifyCompletion(agent) {
      const message = `Subagent done: ${agent.paneId} (${agent.role}) ${agent.task}`;
      if (agent.supervisorPaneId && agent.supervisorPaneId !== process.env.HERDR_PANE_ID) {
        await reportCompletionMetadata(agent);
      } else {
        pollingContext?.ui.notify(message, "info");
      }
    },
  });

  const pollStatusesOnce = async (ctx: ExtensionContext) => {
    pollingContext = ctx;
    await completionPoll.poll();
  };

  const startStatusPolling = (ctx: ExtensionContext) => {
    stopStatusPolling();
    pollingContext = ctx;
    statusPollTimer = setInterval(() => {
      void pollStatusesOnce(ctx).catch(() => undefined);
    }, 3000);
  };

  pi.on("session_start", async (_event, ctx) => {
    completionPoll.reset();
    refreshFromSession(ctx);
    startStatusPolling(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    completionPoll.reset(true, true);
    refreshFromSession(ctx);
    startStatusPolling(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopStatusPolling();
    pollingContext = undefined;
    completionPoll.reset();
  });

  pi.registerTool({
    name: "herdr_subagents_spawn",
    label: "Herdr Spawn",
    description: "Proactively spawn visible herdr-based subagents for non-trivial work with two or more independent tracks.",
    promptSnippet: "Proactively parallelize multi-track research, debugging, review, or isolated implementation in visible Herdr panes.",
    promptGuidelines: [
      "Proactively use herdr_subagents_spawn without waiting for an explicit request when a non-trivial task has two or more independent workstreams.",
      "Prefer herdr_subagents_spawn for multi-module investigation, debugging separate hypotheses, comparing alternatives, independent review, and isolated non-overlapping implementation tasks.",
      "Do not use herdr_subagents_spawn for tiny sequential tasks, tightly coupled work, or workers that would edit the same files.",
      "Use herdr_subagents_status to inspect spawned pane status before reporting progress.",
      "Use herdr_subagents_collect after workers finish; it closes and untracks completed panes by default.",
    ],
    parameters: spawnParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      requireHerdr();
      if (params.tasks.length > MAX_TASKS) {
        throw new Error(`Too many tasks. Maximum is ${MAX_TASKS}.`);
      }
      const defaultRole: Role = params.role ?? "research";
      const cwd = params.cwd ?? ctx.cwd;
      const sourcePane = process.env.HERDR_PANE_ID as string;
      const batchId = makeBatchId();
      const normalizedTasks = normalizeSpawnTasks(params.tasks as Array<string | SpawnTask>, defaultRole, params.model);
      const defaultJcodeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const availableModelIds = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
      const modelCatalog = validateRequestedModels(normalizedTasks, availableModelIds);

      await fs.mkdir(SESSION_DIR, { recursive: true });

      const created = await spawnSubagentsTransactional(normalizedTasks, sourcePane, cwd, {
        split: splitPane,
        async prepare(item, index) {
          const sessionPath = makeSessionPath();
          await fs.mkdir(dirname(sessionPath), { recursive: true });
          const agentName = makeAgentName(item.role, index, batchId);
          const command = buildJcodeLaunchCommand(buildJcodeArgs(cwd, item.model ?? defaultJcodeModel)).map(shellQuote).join(" ");
          return {
            role: item.role,
            task: item.task,
            cwd,
            createdAt: Date.now(),
            batchId,
            supervisorPaneId: sourcePane,
            sessionPath,
            agentName,
            model: item.model,
            thinking: params.thinking,
            command,
          };
        },
        rename: (agent) => paneRename(agent.paneId, makePaneTitle(agent.role, agent.task)),
        start: async (agent) => {
          const started = await startPreferredSubagentAgent(
            agent.paneId,
            agent.agentName,
            buildJcodeArgs(agent.cwd, agent.model ?? defaultJcodeModel),
            buildPiArgs(agent.sessionPath, agent.model, agent.thinking),
          );
          agent.command = started.command;
          agent.agentKind = started.kind;
          agent.promptMode = started.promptMode;
          agent.jcodeSessionPath = started.jcodeSessionPath;
          agent.jcodeFallbackReason = started.fallbackReason;
        },
        prompt: (agent) => agent.promptMode === "raw-pane"
          ? panePrompt(agent.paneId, buildPrompt(agent.role, agent.task))
          : agentPrompt(agent.agentName, buildPrompt(agent.role, agent.task)),
        close: paneClose,
        async listPaneIds() {
          return new Set((await listPanes()).map((pane) => pane.pane_id));
        },
        getTracked: () => agents,
        setTracked(nextAgents) {
          agents = nextAgents;
          persistState(pi, agents, messages);
        },
      });
      completionPoll.markActive(created);

      const text = [
        `Checked ${modelCatalog.available.length} available model(s).`,
        modelCatalog.requested.length > 0
          ? `Validated Pi fallback model(s): ${modelCatalog.requested.join(", ")}. Jcode is still tried first.`
          : "No model override requested; jcode is tried first, then Pi's default model is used only if jcode startup fails.",
        `Spawned ${created.length} herdr subagent pane(s).`,
        ...created.flatMap((agent) => [
          formatStatusLine(agent),
          agent.agentName ? `  agent: ${agent.agentName}` : undefined,
          agent.agentKind ? `  agent kind: ${agent.agentKind}` : undefined,
          agent.promptMode ? `  prompt mode: ${agent.promptMode}` : undefined,
          agent.command ? `  command: ${agent.command}` : undefined,
          agent.jcodeSessionPath ? `  jcode session: ${agent.jcodeSessionPath}` : undefined,
          agent.jcodeFallbackReason ? `  jcode startup failed; fallback reason: ${agent.jcodeFallbackReason}` : undefined,
        ].filter((line): line is string => Boolean(line))),
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          agents: created,
          requestedModels: modelCatalog.requested,
          availableModels: modelCatalog.available,
        },
      };
    },
  });

  pi.registerTool({
    name: "herdr_subagents_status",
    label: "Herdr Status",
    description: "Show current herdr-based subagent panes tracked by this session.",
    parameters: statusParams,
    async execute(_toolCallId, params) {
      requireHerdr();
      const visibleAgents = filterAgentsByBatch(agents, params.latestOnly);
      const panes = await listPanes();
      const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
      const rows = visibleAgents
        .map((agent) => ({ agent, live: byId.get(agent.paneId) }))
        .filter(({ live }) => params.includeDone || live?.agent_status !== "done");

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "No tracked herdr subagents in this session." }],
          details: { agents: [] },
        };
      }

      const text = rows.map(({ agent, live }) => formatStatusLine(agent, live)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          agents: rows.map(({ agent, live }) => ({ ...agent, status: live?.agent_status ?? "missing" })),
        },
      };
    },
  });

  pi.registerTool({
    name: "herdr_subagents_message",
    label: "Herdr Message",
    description: "Record and route a structured metadata message to a target pane.",
    parameters: messageParams,
    async execute(_toolCallId, params) {
      requireHerdr();
      await pruneMissingAgents();
      const fromPaneId = params.fromPaneId ?? (process.env.HERDR_PANE_ID as string);
      const panes = await listPanes();
      const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
      const createdAt = Date.now();
      const message: SubagentMessage = {
        messageId: params.messageId?.trim() || makeMessageId(),
        fromPaneId,
        toPaneId: params.toPaneId,
        kind: params.kind ?? "status",
        body: params.body.trim(),
        createdAt,
        delivery: "reported",
        ttlMs: params.ttlMs,
      };

      if (!byId.has(message.toPaneId)) {
        message.delivery = "target_missing";
      } else {
        try {
          await reportMessageMetadata(message);
        } catch (error) {
          message.delivery = "report_failed";
          message.error = String(error);
        }
      }

      messages = keepRecentMessages([...messages, message]);
      persistState(pi, agents, messages);

      return {
        content: [{ type: "text", text: renderMessageLine(message) }],
        details: { message },
      };
    },
  });

  pi.registerTool({
    name: "herdr_subagents_messages",
    label: "Herdr Messages",
    description: "Show recent structured subagent message records.",
    parameters: messageLogParams,
    async execute(_toolCallId, params) {
      requireHerdr();
      const limit = params.limit ?? 20;
      const rows = messages
        .filter((message) => !params.paneId || message.fromPaneId === params.paneId || message.toPaneId === params.paneId)
        .slice(-limit);

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "No structured subagent messages recorded in this session." }],
          details: { messages: [] },
        };
      }

      return {
        content: [{ type: "text", text: rows.map(renderMessageLine).join("\n") }],
        details: { messages: rows },
      };
    },
  });

  pi.registerTool({
    name: "herdr_subagents_collect",
    label: "Herdr Collect",
    description: "Collect results, then close and untrack completed subagent panes by default; set closePanes to false to keep them open.",
    parameters: collectParams,
    async execute(_toolCallId, params) {
      requireHerdr();
      const targetAgents = filterAgentsByBatch(agents, params.latestOnly);
      if (targetAgents.length === 0) {
        return {
          content: [{ type: "text", text: "No tracked herdr subagents to collect from." }],
          details: {
            agents: [] as Array<Record<string, unknown>>,
            synthesis: undefined as string | undefined,
            closed: [] as SubagentPane[],
            missingCleared: [] as SubagentPane[],
            failedToClose: [] as SubagentPane[],
            remaining: agents,
          },
        };
      }

      const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const lines = params.lines ?? DEFAULT_LINES;
      const collectGraceMs = params.wait ? Math.min(30000, timeoutMs) : 0;
      if (params.wait) {
        await waitForAgents(targetAgents.map((agent) => agent.paneId), timeoutMs);
      }

      const panes = await listPanes();
      const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
      const summaries = [] as Array<Record<string, unknown>>;
      const synthesisItems = [] as Array<{ paneId: string; role: Role; task: string; sections: Partial<Record<string, string>>; excerpt: string; status: string }>;
      const textBlocks: string[] = [];

      for (const agent of targetAgents) {
        const { output, source } = await readCollectedOutput(agent, lines, collectGraceMs);
        const sections = extractStructuredSections(agent.role, output);
        const excerpt = extractStructuredSummary(agent.role, output)
          ?? extractErrorSummary(output)
          ?? (output ? clip(output) : "(no final assistant text recorded)");
        const status = byId.get(agent.paneId)?.agent_status ?? "missing";
        summaries.push({ ...agent, status, excerpt, sections, source });
        synthesisItems.push({ paneId: agent.paneId, role: agent.role, task: agent.task, sections, excerpt, status });
        textBlocks.push([
          `## ${agent.paneId} [${status}] (${agent.role})`,
          `Task: ${agent.task}`,
          `Result source: ${formatCollectSource(source, status)}`,
          excerpt,
        ].join("\n"));
      }

      const synthesis = buildCollectSynthesis(synthesisItems);
      let finalText = synthesis ? `${synthesis}\n\n${textBlocks.join("\n\n")}` : textBlocks.join("\n\n");

      const closed: SubagentPane[] = [];
      const failedToClose: SubagentPane[] = [];
      const missingCleared: SubagentPane[] = [];
      if (params.closePanes ?? true) {
        const candidates = partitionCollectCleanupCandidates(targetAgents, byId);
        missingCleared.push(...candidates.missingCandidates);
        const retained = await cleanupCreatedPanes(candidates.closeCandidates, {
          close: paneClose,
          async listPaneIds() {
            return new Set((await listPanes()).map((pane) => pane.pane_id));
          },
        });
        const retainedIds = new Set(retained.map((agent) => agent.paneId));
        closed.push(...candidates.closeCandidates.filter((agent) => !retainedIds.has(agent.paneId)));
        failedToClose.push(...retained);

        const clearedIds = new Set([...closed, ...missingCleared].map((agent) => agent.paneId));
        agents = agents.filter((agent) => !clearedIds.has(agent.paneId));
        persistState(pi, agents, messages);

        const activeCount = targetAgents.length - candidates.closeCandidates.length - missingCleared.length;
        const cleanupParts = [
          closed.length > 0 ? `closed ${closed.length} completed pane(s)` : undefined,
          missingCleared.length > 0 ? `cleared ${missingCleared.length} missing pane record(s)` : undefined,
          activeCount > 0 ? `left ${activeCount} active pane(s) open` : undefined,
          failedToClose.length > 0 ? `${failedToClose.length} pane(s) failed to close and remain tracked` : undefined,
        ].filter((part): part is string => Boolean(part));
        if (cleanupParts.length > 0) finalText += `\n\nCleanup: ${cleanupParts.join("; ")}.`;
      }

      return {
        content: [{ type: "text", text: finalText }],
        details: {
          agents: summaries,
          synthesis,
          closed,
          missingCleared,
          failedToClose,
          remaining: agents,
        },
      };
    },
  });

  pi.registerTool({
    name: "herdr_subagents_global_status",
    label: "Herdr Global Status",
    description: "Inspect likely herdr-based subagent panes in the current workspace, even outside this session's tracked state.",
    parameters: globalStatusParams,
    async execute(_toolCallId, params) {
      requireHerdr();
      const lines = params.lines ?? 40;
      const panes = await listPanes();
      const rows: Array<{ paneId: string; status: string; cwd: string; role?: Role; task?: string; model?: string; looksLikeSubagent: boolean }> = [];

      for (const pane of panes) {
        if (pane.agent !== "pi") continue;
        const output = await paneRead(pane.pane_id, lines).catch(() => "");
        const role = detectRoleFromOutput(output);
        const task = extractTaskLine(output);
        const looksLikeSubagent = looksLikeSubagentOutput(output) || Boolean(role) || Boolean(task);
        if (!looksLikeSubagent && !params.includeAllPiPanes) continue;
        const modelMatch = output.match(/\(([^)]+)\)\s+([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?)\s+•\s+(off|minimal|low|medium|high|xhigh)/);
        const model = modelMatch ? `${modelMatch[1]}/${modelMatch[2]}` : undefined;
        rows.push({
          paneId: pane.pane_id,
          status: pane.agent_status ?? "unknown",
          cwd: pane.foreground_cwd ?? pane.cwd ?? "",
          role,
          task,
          model,
          looksLikeSubagent,
        });
      }

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "No likely herdr subagent panes found in the current workspace." }],
          details: { panes: [] },
        };
      }

      const text = rows.map((row) => {
        const roleText = row.role ? ` (${row.role})` : "";
        const modelText = row.model ? ` {model=${row.model}}` : "";
        const taskText = row.task ? ` ${row.task}` : "";
        return `- ${row.paneId} [${row.status}]${roleText}${modelText}${taskText}`;
      }).join("\n");

      return {
        content: [{ type: "text", text }],
        details: { panes: rows },
      };
    },
  });

  pi.registerTool({
    name: "herdr_subagents_interrupt",
    label: "Herdr Interrupt",
    description: "Interrupt tracked herdr-based subagent panes.",
    parameters: interruptParams,
    async execute(_toolCallId, params) {
      requireHerdr();
      await pruneMissingAgents();
      let targetAgents = filterAgentsByBatch(agents, params.latestOnly);
      if (params.paneId) {
        targetAgents = targetAgents.filter((agent) => agent.paneId === params.paneId);
      }
      if (targetAgents.length === 0) {
        return {
          content: [{ type: "text", text: "No tracked herdr subagents matched the interrupt request." }],
          details: { interrupted: [] },
        };
      }

      for (const agent of targetAgents) {
        await paneSendKeys(agent.paneId, "Escape").catch(async () => {
          await paneSendKeys(agent.paneId, "C-c").catch(() => undefined);
        });
      }

      return {
        content: [{ type: "text", text: `Interrupted ${targetAgents.length} tracked herdr subagent(s).` }],
        details: { interrupted: targetAgents },
      };
    },
  });

  pi.registerTool({
    name: "herdr_subagents_clear",
    label: "Herdr Clear",
    description: "Close and clear tracked herdr-based subagent panes by default; set closePanes to false to leave panes open.",
    parameters: clearParams,
    async execute(_toolCallId, params) {
      requireHerdr();
      await pruneMissingAgents();
      const targetAgents = filterAgentsByBatch(agents, params.latestOnly);
      if (targetAgents.length === 0) {
        return {
          content: [{ type: "text", text: "No tracked herdr subagents to clear." }],
          details: { closed: [], cleared: [], failedToClose: [], remaining: agents },
        };
      }

      const closePanes = params.closePanes ?? true;
      const failedToClose: SubagentPane[] = [];
      if (closePanes) {
        for (const agent of targetAgents) {
          await paneClose(agent.paneId).catch(() => failedToClose.push(agent));
        }
      }

      const failedIds = new Set(failedToClose.map((agent) => agent.paneId));
      const clearedAgents = closePanes
        ? targetAgents.filter((agent) => !failedIds.has(agent.paneId))
        : targetAgents;
      const clearedIds = new Set(clearedAgents.map((agent) => agent.paneId));
      agents = agents.filter((agent) => !clearedIds.has(agent.paneId));
      persistState(pi, agents, messages);

      const text = !closePanes
        ? `Cleared tracking for ${clearedAgents.length} herdr subagent(s); panes remain open.`
        : failedToClose.length === 0
          ? `Closed and cleared ${clearedAgents.length} herdr subagent pane(s).`
          : `Closed and cleared ${clearedAgents.length} herdr subagent pane(s); ${failedToClose.length} failed to close and remain tracked.`;
      return {
        content: [{ type: "text", text }],
        details: {
          closed: closePanes ? clearedAgents : [],
          cleared: clearedAgents,
          failedToClose,
          remaining: agents,
        },
      };
    },
  });

  pi.registerCommand("herdr-subagents-global-status", {
    description: "Show likely herdr subagent panes in the current workspace",
    handler: async (_args, ctx) => {
      if (!insideHerdr()) {
        ctx.ui.notify("Not running inside herdr.", "error");
        return;
      }
      const panes = await listPanes();
      const lines: string[] = [];
      for (const pane of panes) {
        if (pane.agent !== "pi") continue;
        const output = await paneRead(pane.pane_id, 30).catch(() => "");
        const role = detectRoleFromOutput(output);
        const task = extractTaskLine(output);
        const looksLikeSubagent = looksLikeSubagentOutput(output) || Boolean(role) || Boolean(task);
        if (!looksLikeSubagent) continue;
        const modelMatch = output.match(/\(([^)]+)\)\s+([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?)\s+•\s+(off|minimal|low|medium|high|xhigh)/);
        const model = modelMatch ? `${modelMatch[1]}/${modelMatch[2]}` : undefined;
        lines.push(`- ${pane.pane_id} [${pane.agent_status ?? "unknown"}]${role ? ` (${role})` : ""}${model ? ` {model=${model}}` : ""}${task ? ` ${task}` : ""}`);
      }
      ctx.ui.notify(lines.join("\n") || "No likely herdr subagent panes found in the current workspace.", "info");
    },
  });

  pi.registerCommand("herdr-subagents-done", {
    description: "Internal command used by subagent completion notifications",
    handler: async (args, ctx) => {
      const payload = decodeNotifyPayload(args.trim());
      if (!payload) return;
      const paneId = payload.paneId ?? "unknown";
      const role = payload.role ?? "subagent";
      const task = payload.task ?? "(no task)";
      ctx.ui.notify(`Subagent done: ${paneId} (${role}) ${task}`, "info");
    },
  });

  pi.registerCommand("herdr-subagents-status", {
    description: "Show tracked herdr subagent panes",
    handler: async (_args, ctx) => {
      if (!insideHerdr()) {
        ctx.ui.notify("Not running inside herdr.", "error");
        return;
      }
      const panes = await listPanes();
      const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
      const lines = agents.length
        ? agents.map((agent) => formatStatusLine(agent, byId.get(agent.paneId)))
        : ["No tracked herdr subagents in this session."];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("herdr-subagents-collect", {
    description: "Collect recent output from tracked herdr subagent panes",
    handler: async (args, ctx) => {
      if (!insideHerdr()) {
        ctx.ui.notify("Not running inside herdr.", "error");
        return;
      }
      const wait = args.trim() === "wait";
      const collectGraceMs = wait ? 30000 : 0;
      if (wait) {
        await waitForAgents(agents.map((agent) => agent.paneId), DEFAULT_WAIT_TIMEOUT_MS).catch((error) => {
          ctx.ui.notify(String(error), "warning");
        });
      }
      const panes = await listPanes();
      const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
      const blocks: string[] = [];
      for (const agent of agents) {
        const { output, source } = await readCollectedOutput(agent, DEFAULT_LINES, collectGraceMs);
        const excerpt = extractStructuredSummary(agent.role, output)
          ?? extractErrorSummary(output)
          ?? (output ? clip(output) : "(no final assistant text recorded)");
        const status = byId.get(agent.paneId)?.agent_status ?? "missing";
        blocks.push(`${agent.paneId} [${status}] (${agent.role}) ${agent.task}\nResult source: ${formatCollectSource(source, status)}\n${excerpt}`);
      }
      ctx.ui.notify(blocks.join("\n\n") || "No tracked herdr subagents.", "info");
    },
  });

  pi.registerCommand("herdr-subagents-interrupt", {
    description: "Interrupt tracked herdr subagent panes (or one pane id)",
    handler: async (args, ctx) => {
      if (!insideHerdr()) {
        ctx.ui.notify("Not running inside herdr.", "error");
        return;
      }
      await pruneMissingAgents();
      const paneId = args.trim() || undefined;
      let targetAgents = paneId ? agents.filter((agent) => agent.paneId === paneId) : agents;
      if (targetAgents.length === 0) {
        ctx.ui.notify("No tracked herdr subagents matched the interrupt request.", "info");
        return;
      }
      for (const agent of targetAgents) {
        await paneSendKeys(agent.paneId, "Escape").catch(async () => {
          await paneSendKeys(agent.paneId, "C-c").catch(() => undefined);
        });
      }
      ctx.ui.notify(`Interrupted ${targetAgents.length} tracked herdr subagent(s).`, "info");
    },
  });

  pi.registerCommand("herdr-subagents-clear", {
    description: "Close and clear tracked subagent panes (append 'keep' to leave panes open)",
    handler: async (args, ctx) => {
      if (!insideHerdr()) {
        ctx.ui.notify("Not running inside herdr.", "error");
        return;
      }
      await pruneMissingAgents();
      const keepPanes = args.trim() === "keep";
      const targetAgents = [...agents];
      if (targetAgents.length === 0) {
        ctx.ui.notify("No tracked herdr subagents.", "info");
        return;
      }

      const failedToClose: SubagentPane[] = [];
      if (!keepPanes) {
        for (const agent of targetAgents) {
          await paneClose(agent.paneId).catch(() => failedToClose.push(agent));
        }
      }

      const failedIds = new Set(failedToClose.map((agent) => agent.paneId));
      agents = keepPanes ? [] : failedToClose;
      persistState(pi, agents, messages);

      if (keepPanes) {
        ctx.ui.notify(`Cleared tracking for ${targetAgents.length} herdr subagent(s); panes remain open.`, "info");
      } else if (failedIds.size === 0) {
        ctx.ui.notify(`Closed and cleared ${targetAgents.length} herdr subagent pane(s).`, "info");
      } else {
        ctx.ui.notify(`Closed and cleared ${targetAgents.length - failedIds.size} pane(s); ${failedIds.size} failed to close and remain tracked.`, "warning");
      }
    },
  });
}
