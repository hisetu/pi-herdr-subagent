import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATE_TYPE = "herdr-subagents-state";
const MAX_TASKS = 4;
const DEFAULT_WAIT_TIMEOUT_MS = 300000;
const DEFAULT_LINES = 30;
const SESSION_DIR = "/Users/lucas/.pi/agent/extensions/herdr-subagents/sessions";

type Role = "research" | "implement" | "review";
type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
  model?: string;
  thinking?: Thinking;
};

type NormalizedSpawnTask = {
  task: string;
  role: Role;
  model?: string;
};

type PersistedState = {
  agents: SubagentPane[];
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
});

const clearParams = Type.Object({
  closePanes: Type.Optional(Type.Boolean({ description: "Close tracked panes before clearing them" })),
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

async function splitPane(sourcePaneId: string, cwd?: string): Promise<string> {
  const args = ["pane", "split", sourcePaneId, "--direction", "right", "--no-focus"];
  if (cwd) args.push("--cwd", cwd);
  const stdout = await runHerdr(args);
  const parsed = JSON.parse(stdout) as { result?: { pane?: { pane_id?: string } } };
  const paneId = parsed.result?.pane?.pane_id;
  if (!paneId) throw new Error("Failed to parse new pane id from herdr pane split output.");
  return paneId;
}

async function paneRun(paneId: string, command: string): Promise<void> {
  await runHerdr(["pane", "run", paneId, command]);
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

function buildPiCommand(role: Role, task: string, sessionPath: string, model?: string, thinking?: Thinking): string {
  const prompt = buildPrompt(role, task);
  const parts = ["pi", "--session", shellQuote(sessionPath)];
  if (model) parts.push("--model", shellQuote(model));
  if (thinking) parts.push("--thinking", shellQuote(thinking));
  parts.push(shellQuote(prompt));
  return parts.join(" ");
}

function formatStatusLine(agent: SubagentPane, live?: PaneInfo): string {
  const status = live?.agent_status ?? "missing";
  const modelText = agent.model ? ` {model=${agent.model}}` : "";
  return `- ${agent.paneId} [${status}] (${agent.role})${modelText} ${agent.task}`;
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
    if (block.length > 0) {
      result[header] = block.join("\n");
    }
  }

  return result;
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

function persistState(pi: ExtensionAPI, agents: SubagentPane[]) {
  pi.appendEntry<PersistedState>(STATE_TYPE, { agents });
}

function restoreState(ctx: ExtensionContext): SubagentPane[] {
  const branch = ctx.sessionManager.getBranch();
  let last: SubagentPane[] = [];
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === STATE_TYPE) {
      const data = entry.data as PersistedState | undefined;
      if (Array.isArray(data?.agents)) {
        last = data.agents;
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

function filterAgentsByBatch(list: SubagentPane[], latestOnly?: boolean): SubagentPane[] {
  if (!latestOnly) return list;
  const latestBatchId = getLatestBatchId(list);
  return latestBatchId ? list.filter((agent) => agent.batchId === latestBatchId) : list;
}

async function extractAssistantTextFromSession(sessionPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(sessionPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const entry = JSON.parse(lines[i]) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const text = (entry.message.content ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (text) return text;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function waitForAgents(targetPaneIds: string[], timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const panes = await listPanes();
    const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
    const pending = targetPaneIds.filter((paneId) => {
      const status = byId.get(paneId)?.agent_status;
      if (status == null) return false;
      return status !== "idle" && status !== "done";
    });
    if (pending.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for panes to settle after ${timeoutMs}ms.`);
}

export default function herdrSubagentsExtension(pi: ExtensionAPI) {
  let agents: SubagentPane[] = [];
  let statusPollTimer: NodeJS.Timeout | undefined;
  const lastKnownStatuses = new Map<string, string>();

  const refreshFromSession = (ctx: ExtensionContext) => {
    agents = restoreState(ctx);
  };

  const pruneMissingAgents = async (): Promise<void> => {
    if (agents.length === 0) return;
    const panes = await listPanes();
    const livePaneIds = new Set(panes.map((pane) => pane.pane_id));
    const nextAgents = agents.filter((agent) => livePaneIds.has(agent.paneId));
    if (nextAgents.length !== agents.length) {
      agents = nextAgents;
      persistState(pi, agents);
    }
  };

  const stopStatusPolling = () => {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = undefined;
    }
  };

  const pollStatusesOnce = async (ctx: ExtensionContext) => {
    if (!insideHerdr() || agents.length === 0) return;
    await pruneMissingAgents();
    if (agents.length === 0) return;
    const panes = await listPanes();
    const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
    for (const agent of agents) {
      const status = byId.get(agent.paneId)?.agent_status;
      if (!status) continue;
      const previous = lastKnownStatuses.get(agent.paneId);
      lastKnownStatuses.set(agent.paneId, status);
      const becameDone = (status === "idle" || status === "done") && previous && previous !== status && previous !== "idle" && previous !== "done";
      if (becameDone) {
        const message = `Subagent done: ${agent.paneId} (${agent.role}) ${agent.task}`;
        if (agent.supervisorPaneId && agent.supervisorPaneId !== process.env.HERDR_PANE_ID) {
          const payload = encodeNotifyPayload({
            paneId: agent.paneId,
            role: agent.role,
            task: agent.task,
            status,
          });
          await paneRun(agent.supervisorPaneId, `/herdr-subagents-done ${payload}`).catch(() => {
            ctx.ui.notify(message, "info");
          });
        } else {
          ctx.ui.notify(message, "info");
        }
      }
    }
  };

  const startStatusPolling = (ctx: ExtensionContext) => {
    stopStatusPolling();
    statusPollTimer = setInterval(() => {
      void pollStatusesOnce(ctx).catch(() => undefined);
    }, 3000);
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshFromSession(ctx);
    startStatusPolling(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refreshFromSession(ctx);
    startStatusPolling(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopStatusPolling();
  });

  pi.registerTool({
    name: "herdr_subagents_spawn",
    label: "Herdr Spawn",
    description: "Spawn simple herdr-based subagents in sibling panes.",
    promptSnippet: "Spawn herdr-based subagents in separate panes for parallel research or implementation tasks.",
    promptGuidelines: [
      "Use herdr_subagents_spawn when the user wants visible pane-based subagents in herdr.",
      "Use herdr_subagents_status to inspect spawned pane status before reporting progress.",
      "Use herdr_subagents_collect to gather results after spawned panes finish.",
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
      const created: SubagentPane[] = [];
      const batchId = makeBatchId();
      const normalizedTasks = normalizeSpawnTasks(params.tasks as Array<string | SpawnTask>, defaultRole, params.model);

      await fs.mkdir(SESSION_DIR, { recursive: true });

      for (const item of normalizedTasks) {
        const paneId = await splitPane(sourcePane, cwd);
        const sessionPath = makeSessionPath();
        await fs.mkdir(dirname(sessionPath), { recursive: true });
        const command = buildPiCommand(item.role, item.task, sessionPath, item.model, params.thinking);
        await paneRun(paneId, command);
        created.push({
          paneId,
          role: item.role,
          task: item.task,
          cwd,
          createdAt: Date.now(),
          batchId,
          supervisorPaneId: sourcePane,
          sessionPath,
          model: item.model,
          thinking: params.thinking,
        });
      }

      agents = [...agents, ...created];
      persistState(pi, agents);

      const text = [
        `Spawned ${created.length} herdr subagent pane(s).`,
        ...created.map((agent) => formatStatusLine(agent)),
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: { agents: created },
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
      await pruneMissingAgents();
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
    name: "herdr_subagents_collect",
    label: "Herdr Collect",
    description: "Collect recent output from tracked herdr-based subagent panes.",
    parameters: collectParams,
    async execute(_toolCallId, params) {
      requireHerdr();
      await pruneMissingAgents();
      const targetAgents = filterAgentsByBatch(agents, params.latestOnly);
      if (targetAgents.length === 0) {
        return {
          content: [{ type: "text", text: "No tracked herdr subagents to collect from." }],
          details: { agents: [] },
        };
      }

      const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const lines = params.lines ?? DEFAULT_LINES;
      if (params.wait) {
        await waitForAgents(targetAgents.map((agent) => agent.paneId), timeoutMs);
      }

      const panes = await listPanes();
      const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
      const summaries = [] as Array<Record<string, unknown>>;
      const synthesisItems = [] as Array<{ paneId: string; role: Role; task: string; sections: Partial<Record<string, string>>; excerpt: string; status: string }>;
      const textBlocks: string[] = [];

      for (const agent of targetAgents) {
        const sessionText = agent.sessionPath ? await extractAssistantTextFromSession(agent.sessionPath) : undefined;
        const output = sessionText ?? await paneRead(agent.paneId, lines).catch(() => "");
        const sections = extractStructuredSections(agent.role, output);
        const excerpt = extractStructuredSummary(agent.role, output) ?? clip(output || "(no readable recent output)");
        const status = byId.get(agent.paneId)?.agent_status ?? "missing";
        summaries.push({ ...agent, status, excerpt, sections });
        synthesisItems.push({ paneId: agent.paneId, role: agent.role, task: agent.task, sections, excerpt, status });
        textBlocks.push([`## ${agent.paneId} [${status}] (${agent.role})`, `Task: ${agent.task}`, excerpt].join("\n"));
      }

      const synthesis = buildCollectSynthesis(synthesisItems);
      const finalText = synthesis ? `${synthesis}\n\n${textBlocks.join("\n\n")}` : textBlocks.join("\n\n");

      return {
        content: [{ type: "text", text: finalText }],
        details: { agents: summaries, synthesis },
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
      const rows: Array<{ paneId: string; status: string; cwd: string; role?: Role; task?: string; looksLikeSubagent: boolean }> = [];

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
    description: "Clear tracked herdr-based subagent panes and optionally close them.",
    parameters: clearParams,
    async execute(_toolCallId, params) {
      requireHerdr();
      await pruneMissingAgents();
      const targetAgents = filterAgentsByBatch(agents, params.latestOnly);
      if (targetAgents.length === 0) {
        return {
          content: [{ type: "text", text: "No tracked herdr subagents to clear." }],
          details: { cleared: [], remaining: agents },
        };
      }

      if (params.closePanes) {
        for (const agent of targetAgents) {
          await paneClose(agent.paneId).catch(() => undefined);
        }
      }

      const clearedIds = new Set(targetAgents.map((agent) => agent.paneId));
      agents = agents.filter((agent) => !clearedIds.has(agent.paneId));
      persistState(pi, agents);

      return {
        content: [{ type: "text", text: `Cleared ${targetAgents.length} tracked herdr subagent(s).` }],
        details: { cleared: targetAgents, remaining: agents },
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
      await pruneMissingAgents();
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
      await pruneMissingAgents();
      const wait = args.trim() === "wait";
      if (wait) {
        await waitForAgents(agents.map((agent) => agent.paneId), DEFAULT_WAIT_TIMEOUT_MS).catch((error) => {
          ctx.ui.notify(String(error), "warning");
        });
      }
      const blocks: string[] = [];
      for (const agent of agents) {
        const sessionText = agent.sessionPath ? await extractAssistantTextFromSession(agent.sessionPath) : undefined;
        const output = sessionText ?? await paneRead(agent.paneId, DEFAULT_LINES).catch(() => "");
        const excerpt = extractStructuredSummary(agent.role, output) ?? clip(output || "(no readable recent output)");
        blocks.push(`${agent.paneId} (${agent.role}) ${agent.task}\n${excerpt}`);
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
    description: "Clear tracked herdr subagent panes (append 'close' to also close panes)",
    handler: async (args, ctx) => {
      if (!insideHerdr()) {
        ctx.ui.notify("Not running inside herdr.", "error");
        return;
      }
      await pruneMissingAgents();
      const closePanes = args.trim() === "close";
      const targetAgents = [...agents];
      if (targetAgents.length === 0) {
        ctx.ui.notify("No tracked herdr subagents.", "info");
        return;
      }
      if (closePanes) {
        for (const agent of targetAgents) {
          await paneClose(agent.paneId).catch(() => undefined);
        }
      }
      agents = [];
      persistState(pi, agents);
      ctx.ui.notify(`Cleared ${targetAgents.length} tracked herdr subagent(s).`, "info");
    },
  });
}
