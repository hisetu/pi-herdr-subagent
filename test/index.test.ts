import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";

import { __test } from "../index.ts";

const {
  normalizeSpawnTasks,
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
  cleanupCreatedPanes,
  spawnSubagentsTransactional,
  parseSplitPaneId,
  splitPane,
  UnknownSplitOutcomeError,
  createCompletionPollState,
  waitForAgents,
  formatCollectSource,
  formatStatusLine,
} = __test;

describe("task normalization and role prompts", () => {
  test("normalizes string and object tasks with the documented precedence", () => {
    assert.deepEqual(
      normalizeSpawnTasks(
        [
          "inspect logs",
          { task: "apply fix", role: "implement" },
          { task: "review fix", model: "task-model" },
        ],
        "research",
        "default-model",
      ),
      [
        { task: "inspect logs", role: "research", model: "default-model" },
        { task: "apply fix", role: "implement", model: "default-model" },
        { task: "review fix", role: "research", model: "task-model" },
      ],
    );
  });

  test("builds each role prompt with its role and exact output contract", () => {
    const contracts = {
      research: ["Your role is research.", "Conclusion:", "Evidence:", "Unknowns:"],
      implement: ["Your role is implementation.", "Changed files:", "Summary:", "Risks:"],
      review: ["Your role is review.", "Findings:", "Severity:", "Recommended changes:"],
    } as const;

    for (const [role, requiredLines] of Object.entries(contracts)) {
      const prompt = buildPrompt(role as keyof typeof contracts, "characterize behavior");
      assert.ok(prompt.startsWith("You are a subagent working under a supervisor in herdr.\n"));
      assert.ok(prompt.endsWith("\nTask: characterize behavior"));
      for (const line of requiredLines) assert.ok(prompt.split("\n").includes(line), `${role}: ${line}`);
    }
  });
});

describe("payload, quoting, title, and CLI argument helpers", () => {
  test("round-trips UTF-8 notification payloads and rejects malformed data", () => {
    const payload = { paneId: "pane-1", task: "檢查 'quoted' output", role: "review" };
    assert.deepEqual(decodeNotifyPayload(encodeNotifyPayload(payload)), payload);
    assert.equal(decodeNotifyPayload("not-json"), undefined);
  });

  test("quotes shell arguments for exact POSIX shell round-tripping", () => {
    for (const value of ["plain value", "it's safe", "$HOME", "line one\nline two", ""]) {
      const output = execFileSync("sh", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" });
      assert.equal(output, value);
    }
  });

  test("sanitizes and simplifies pane titles without changing their role prefix", () => {
    assert.equal(sanitizePaneTitle("  hello\u001b  \n world\u0007 "), "hello world");
    assert.equal(makePaneTitle("review", "Review jj diff abc123 for unsafe shell quoting"), "review: unsafe shell quoting");
    assert.equal(makePaneTitle("research", "Reply with exactly one word: Ready"), "research: Ready");
    assert.equal(makePaneTitle("implement", "x".repeat(50)), `implement: ${"x".repeat(41)}…`);
  });

  test("builds positional-safe Pi argument arrays and omits absent options", () => {
    assert.deepEqual(buildPiArgs("/tmp/session with spaces.jsonl"), ["--session", "/tmp/session with spaces.jsonl"]);
    assert.deepEqual(buildPiArgs("session.jsonl", "provider/model", "high"), [
      "--session", "session.jsonl", "--model", "provider/model", "--thinking", "high",
    ]);
  });

  test("recovers a pane ID from valid Herdr split output", async () => {
    const output = JSON.stringify({ result: { pane: { pane_id: "pane-1" } } });
    assert.equal(parseSplitPaneId(output), "pane-1");
    assert.equal(parseSplitPaneId("truncated output"), undefined);
    assert.equal(parseSplitPaneId(JSON.stringify({ result: {} })), undefined);

    const cliError = Object.assign(new Error("nonzero exit"), { stdout: output });
    assert.equal(await splitPane("source", "right", "/repo", async () => { throw cliError; }), "pane-1");
    await assert.rejects(
      splitPane("source", "right", "/repo", async () => { throw new Error("no output"); }),
      UnknownSplitOutcomeError,
    );
  });
});

describe("structured output parsing and synthesis", () => {
  test("extracts ordered role sections and ignores unrelated text", () => {
    const reviewOutput = [
      "preamble",
      "1. Findings:",
      "- unsafe quoting",
      "2. Severity:",
      "medium",
      "3. Recommended changes:",
      "add coverage",
      "",
      "trailing pane noise",
    ].join("\n");

    assert.deepEqual(extractStructuredSections("review", reviewOutput), {
      findings: "1. Findings:\n- unsafe quoting",
      severity: "2. Severity:\nmedium",
      "recommended changes": "3. Recommended changes:\nadd coverage",
    });
    assert.equal(
      extractStructuredSummary("review", reviewOutput),
      "1. Findings:\n- unsafe quoting\n\n2. Severity:\nmedium\n\n3. Recommended changes:\nadd coverage",
    );

    assert.deepEqual(extractStructuredSections("research", [
      "Conclusion:",
      "Parser is stable.",
      "Evidence:",
      "Tests pass.",
      "Unknowns:",
      "None.",
    ].join("\n")), {
      conclusion: "Conclusion:\nParser is stable.",
      evidence: "Evidence:\nTests pass.",
      unknowns: "Unknowns:\nNone.",
    });

    assert.deepEqual(extractStructuredSections("implement", [
      "Changed files:",
      "test/index.test.ts",
      "Summary:",
      "Coverage added.",
      "Risks:",
      "Low.",
    ].join("\n")), {
      "changed files": "Changed files:\ntest/index.test.ts",
      summary: "Summary:\nCoverage added.",
      risks: "Risks:\nLow.",
    });
  });

  test("recognizes prompt metadata and synthesizes role-specific primary and risk sections", () => {
    const researchPrompt = buildPrompt("research", "inspect parser");
    assert.equal(extractTaskLine(researchPrompt), "inspect parser");
    assert.equal(detectRoleFromOutput(researchPrompt), "research");
    assert.equal(looksLikeSubagentOutput(researchPrompt), true);
    assert.equal(looksLikeSubagentOutput("ordinary terminal output"), false);

    const synthesis = buildCollectSynthesis([
      {
        paneId: "pane-r",
        role: "research",
        task: "inspect",
        sections: { conclusion: "Conclusion:\nParser is stable.", unknowns: "Unknowns:\nNone." },
        excerpt: "fallback",
        status: "done",
      },
      {
        paneId: "pane-i",
        role: "implement",
        task: "change",
        sections: { summary: "Summary:\nTests added.", risks: "Risks:\nLow." },
        excerpt: "fallback",
        status: "idle",
      },
    ]);

    assert.match(synthesis ?? "", /- pane-r \(research\) Conclusion: Parser is stable\./);
    assert.match(synthesis ?? "", /- pane-i \(implement\) Summary: Tests added\./);
    assert.match(synthesis ?? "", /- pane-r: Unknowns: None\./);
    assert.match(synthesis ?? "", /Suggested next step: Review the implementation-oriented pane results first/);
    assert.equal(buildCollectSynthesis([]), undefined);
  });
});

describe("transactional subagent spawning", () => {
  type SpawnOperations = Parameters<typeof spawnSubagentsTransactional>[3];

  const tasks = [
    { task: "first task", role: "research" as const },
    { task: "second task", role: "review" as const },
  ];

  function makeHarness(
    failAt?: "split" | "rename" | "start" | "prompt" | "close",
    liveAfterClose = false,
    initialTracked: Parameters<SpawnOperations["setTracked"]>[0] = [],
  ) {
    let tracked: Parameters<SpawnOperations["setTracked"]>[0] = [...initialTracked];
    const snapshots: string[][] = [];
    const calls: string[] = [];
    let nextPane = 1;

    const operations: SpawnOperations = {
      async split(source, direction) {
        calls.push(`split:${source}:${direction}`);
        if (failAt === "split") throw new Error("split failed");
        return `pane-${nextPane++}`;
      },
      async prepare(item, index) {
        return {
          role: item.role,
          task: item.task,
          cwd: "/repo",
          createdAt: index + 1,
          batchId: "batch-1",
          supervisorPaneId: "supervisor",
          sessionPath: `/sessions/${index}.jsonl`,
          agentName: `agent-${index}`,
          command: `pi --session /sessions/${index}.jsonl`,
        };
      },
      async rename(agent) {
        calls.push(`rename:${agent.paneId}`);
        if (failAt === "rename") throw new Error("rename failed");
      },
      async start(agent) {
        calls.push(`start:${agent.paneId}`);
        if (failAt === "start") throw new Error("start failed");
      },
      async prompt(agent) {
        calls.push(`prompt:${agent.paneId}`);
        if (failAt === "prompt") throw new Error("prompt failed");
      },
      async close(paneId) {
        calls.push(`close:${paneId}`);
        if (failAt === "close") throw new Error("close failed");
      },
      async listPaneIds() {
        calls.push("list");
        return liveAfterClose ? new Set(["pane-1"]) : new Set<string>();
      },
      getTracked: () => tracked,
      setTracked(agents) {
        tracked = agents;
        snapshots.push(agents.map((agent) => agent.paneId));
      },
    };

    return { operations, calls, snapshots, getTracked: () => tracked };
  }

  test("tracks each pane before rename and completes the existing split layout", async () => {
    const harness = makeHarness();

    const created = await spawnSubagentsTransactional(tasks, "supervisor", "/repo", harness.operations);

    assert.deepEqual(created.map((agent) => agent.paneId), ["pane-1", "pane-2"]);
    assert.deepEqual(harness.snapshots, [["pane-1"], ["pane-1", "pane-2"]]);
    assert.deepEqual(harness.calls, [
      "split:supervisor:right",
      "rename:pane-1",
      "start:pane-1",
      "prompt:pane-1",
      "split:pane-1:down",
      "rename:pane-2",
      "start:pane-2",
      "prompt:pane-2",
    ]);
  });

  for (const failure of ["rename", "start", "prompt"] as const) {
    test(`closes and untracks the pane when ${failure} fails`, async () => {
      const harness = makeHarness(failure);

      await assert.rejects(
        spawnSubagentsTransactional(tasks, "supervisor", "/repo", harness.operations),
        new RegExp(`Failed to spawn herdr subagents: ${failure} failed.*All panes created by this call were cleaned up`),
      );

      assert.deepEqual(harness.getTracked(), []);
      assert.deepEqual(harness.snapshots, [["pane-1"], []]);
      assert.ok(harness.calls.includes("close:pane-1"));
    });
  }

  test("best-effort closes every pane created before a later task fails", async () => {
    const harness = makeHarness();
    let promptCount = 0;
    harness.operations.prompt = async (agent) => {
      harness.calls.push(`prompt:${agent.paneId}`);
      promptCount += 1;
      if (promptCount === 2) throw new Error("second prompt failed");
    };

    await assert.rejects(
      spawnSubagentsTransactional(tasks, "supervisor", "/repo", harness.operations),
      /second prompt failed.*All panes created by this call were cleaned up/,
    );

    assert.deepEqual(harness.calls.slice(-2), ["close:pane-1", "close:pane-2"]);
    assert.deepEqual(harness.getTracked(), []);
  });

  test("retains complete pane ownership when cleanup close fails", async () => {
    const harness = makeHarness("close", true);
    harness.operations.prompt = async (agent) => {
      harness.calls.push(`prompt:${agent.paneId}`);
      throw new Error("prompt failed");
    };

    await assert.rejects(
      spawnSubagentsTransactional(tasks, "supervisor", "/repo", harness.operations),
      /prompt failed.*remain tracked: pane-1/,
    );

    assert.deepEqual(harness.getTracked(), [{
      paneId: "pane-1",
      role: "research",
      task: "first task",
      cwd: "/repo",
      createdAt: 1,
      batchId: "batch-1",
      supervisorPaneId: "supervisor",
      sessionPath: "/sessions/0.jsonl",
      agentName: "agent-0",
      command: "pi --session /sessions/0.jsonl",
    }]);
    assert.deepEqual(harness.snapshots, [["pane-1"], ["pane-1"]]);
    assert.deepEqual(harness.calls.slice(-2), ["close:pane-1", "list"]);
  });

  test("untracks a pane whose close reports failure but liveness confirms it is missing", async () => {
    const harness = makeHarness("close", false);
    harness.operations.start = async () => { throw new Error("start failed"); };

    await assert.rejects(
      spawnSubagentsTransactional(tasks, "supervisor", "/repo", harness.operations),
      /start failed.*All panes created by this call were cleaned up/,
    );

    assert.deepEqual(harness.getTracked(), []);
    assert.deepEqual(harness.snapshots.at(-1), []);
  });

  test("persists unchanged tracking and closes nothing when split fails", async () => {
    const harness = makeHarness("split");

    await assert.rejects(
      spawnSubagentsTransactional(tasks, "supervisor", "/repo", harness.operations),
      /split failed.*All panes created by this call were cleaned up/,
    );

    assert.deepEqual(harness.calls, ["split:supervisor:right"]);
    assert.deepEqual(harness.snapshots, [[]]);
  });

  test("does not claim cleanup when split creation cannot be determined", async () => {
    const harness = makeHarness();
    harness.operations.split = async () => {
      throw new UnknownSplitOutcomeError("split output was malformed");
    };

    await assert.rejects(
      spawnSubagentsTransactional(tasks, "supervisor", "/repo", harness.operations),
      /split output was malformed.*Unable to determine whether the failed split created an additional untracked pane; inspect Herdr/,
    );

    assert.deepEqual(harness.getTracked(), []);
  });

  test("reports both retained panes and an ambiguous later split", async () => {
    const harness = makeHarness("close", true);
    let splitCount = 0;
    const split = harness.operations.split;
    harness.operations.split = async (...args) => {
      splitCount += 1;
      if (splitCount === 2) throw new UnknownSplitOutcomeError("second split was ambiguous");
      return split(...args);
    };

    await assert.rejects(
      spawnSubagentsTransactional(tasks, "supervisor", "/repo", harness.operations),
      /second split was ambiguous.*remain tracked: pane-1.*additional untracked pane; inspect Herdr/,
    );

    assert.deepEqual(harness.getTracked().map((agent) => agent.paneId), ["pane-1"]);
  });

  test("preserves agents tracked before the failed batch", async () => {
    const existing = {
      paneId: "existing",
      role: "research" as const,
      task: "existing task",
      cwd: "/repo",
      createdAt: 0,
      batchId: "old-batch",
      supervisorPaneId: "supervisor",
    };
    const harness = makeHarness("rename", false, [existing]);

    await assert.rejects(
      spawnSubagentsTransactional(tasks, "supervisor", "/repo", harness.operations),
      /rename failed.*All panes created by this call were cleaned up/,
    );

    assert.deepEqual(harness.getTracked(), [existing]);
  });

  test("cleans up and retries final state persistence when provisional persistence fails", async () => {
    const harness = makeHarness();
    const setTracked = harness.operations.setTracked;
    let attempts = 0;
    harness.operations.setTracked = (agents) => {
      setTracked(agents);
      attempts += 1;
      if (attempts === 1) throw new Error("persist failed");
    };

    await assert.rejects(
      spawnSubagentsTransactional(tasks, "supervisor", "/repo", harness.operations),
      /persist failed.*All panes created by this call were cleaned up/,
    );

    assert.deepEqual(harness.calls, ["split:supervisor:right", "close:pane-1"]);
    assert.deepEqual(harness.getTracked(), []);
    assert.deepEqual(harness.snapshots, [["pane-1"], []]);
  });

  test("cleanup is idempotent for panes already missing", async () => {
    const pane = { ...await makeHarness().operations.prepare(tasks[0], 0), paneId: "pane-1" };
    let closeAttempts = 0;
    const cleanup = () => cleanupCreatedPanes([pane], {
      async close() {
        closeAttempts += 1;
        throw new Error("pane missing");
      },
      async listPaneIds() {
        return new Set();
      },
    });

    assert.deepEqual(await cleanup(), []);
    assert.deepEqual(await cleanup(), []);
    assert.equal(closeAttempts, 2);
  });
});

describe("completion polling lifecycle", () => {
  const trackedAgent = {
    paneId: "pane-1",
    role: "research" as const,
    task: "inspect lifecycle",
    cwd: "/repo",
    createdAt: 1,
    batchId: "batch-1",
    supervisorPaneId: "supervisor",
  };

  const pane = (status: string) => ({ pane_id: "pane-1", agent_status: status });

  test("prevents overlapping polls", async () => {
    let releaseList!: (panes: Array<{ pane_id: string; agent_status: string }>) => void;
    let listCalls = 0;
    const blockedList = new Promise<Array<{ pane_id: string; agent_status: string }>>((resolve) => {
      releaseList = resolve;
    });
    const poller = createCompletionPollState({
      insideHerdr: () => true,
      getAgents: () => [trackedAgent],
      listPanes: async () => {
        listCalls += 1;
        return blockedList;
      },
      notifyCompletion: async () => undefined,
    });

    const first = poller.poll();
    assert.equal(await poller.poll(), false);
    assert.equal(listCalls, 1);
    releaseList([pane("working")]);
    assert.equal(await first, true);
    assert.equal(poller.isPolling(), false);
  });

  test("reset invalidates an in-flight poll without allowing a replacement to overlap", async () => {
    let releaseList!: (panes: Array<{ pane_id: string; agent_status: string }>) => void;
    let notifications = 0;
    const blockedList = new Promise<Array<{ pane_id: string; agent_status: string }>>((resolve) => {
      releaseList = resolve;
    });
    const poller = createCompletionPollState({
      insideHerdr: () => true,
      getAgents: () => [trackedAgent],
      listPanes: async () => blockedList,
      notifyCompletion: async () => { notifications += 1; },
    });

    const stalePoll = poller.poll();
    poller.reset();
    assert.equal(await poller.poll(), false);
    releaseList([pane("done")]);
    await stalePoll;

    assert.equal(notifications, 0);
    assert.equal(poller.isPolling(), false);
  });

  test("notifies a newly spawned agent that settles before its first poll", async () => {
    let notifications = 0;
    const poller = createCompletionPollState({
      insideHerdr: () => true,
      getAgents: () => [trackedAgent],
      listPanes: async () => [pane("done")],
      notifyCompletion: async () => { notifications += 1; },
    });

    poller.markActive([trackedAgent]);
    await poller.poll();
    await poller.poll();

    assert.equal(notifications, 1);
  });

  test("preserves active observations across a session-tree reset", async () => {
    let status = "working";
    let notifications = 0;
    const poller = createCompletionPollState({
      insideHerdr: () => true,
      getAgents: () => [trackedAgent],
      listPanes: async () => [pane(status)],
      notifyCompletion: async () => { notifications += 1; },
    });

    await poller.poll();
    poller.reset(true, true);
    status = "done";
    await poller.poll();

    assert.equal(notifications, 1);
  });

  test("records an in-flight successful notification across a session-tree reset", async () => {
    let releaseNotification!: () => void;
    let notifications = 0;
    const notification = new Promise<void>((resolve) => { releaseNotification = resolve; });
    const poller = createCompletionPollState({
      insideHerdr: () => true,
      getAgents: () => [trackedAgent],
      listPanes: async () => [pane("done")],
      notifyCompletion: async () => {
        notifications += 1;
        await notification;
      },
    });

    poller.markActive([trackedAgent]);
    const inFlight = poller.poll();
    await Promise.resolve();
    poller.reset(true, true);
    releaseNotification();
    await inFlight;
    await poller.poll();

    assert.equal(notifications, 1);
    assert.equal(poller.hasNotified(trackedAgent), true);
  });

  test("does not resurrect notification state after a full shutdown reset", async () => {
    let releaseNotification!: () => void;
    const notification = new Promise<void>((resolve) => { releaseNotification = resolve; });
    const poller = createCompletionPollState({
      insideHerdr: () => true,
      getAgents: () => [trackedAgent],
      listPanes: async () => [pane("done")],
      notifyCompletion: async () => notification,
    });

    poller.markActive([trackedAgent]);
    const inFlight = poller.poll();
    await Promise.resolve();
    poller.reset();
    releaseNotification();
    await inFlight;

    assert.equal(poller.hasNotified(trackedAgent), false);
  });

  test("deduplicates completion and retries a failed notification", async () => {
    let status = "working";
    let notifyAttempts = 0;
    const poller = createCompletionPollState({
      insideHerdr: () => true,
      getAgents: () => [trackedAgent],
      listPanes: async () => [pane(status)],
      notifyCompletion: async () => {
        notifyAttempts += 1;
        if (notifyAttempts === 1) throw new Error("notify failed");
      },
    });

    await poller.poll();
    status = "done";
    await poller.poll();
    assert.equal(poller.hasNotified(trackedAgent), false);
    await poller.poll();
    await poller.poll();
    status = "idle";
    await poller.poll();

    assert.equal(notifyAttempts, 2);
    assert.equal(poller.hasNotified(trackedAgent), true);
  });

  test("recovers after a list error and reset clears stale transition state", async () => {
    let listCalls = 0;
    let status = "working";
    let notifications = 0;
    const poller = createCompletionPollState({
      insideHerdr: () => true,
      getAgents: () => [trackedAgent],
      listPanes: async () => {
        listCalls += 1;
        if (listCalls === 1) throw new Error("temporary list failure");
        return [pane(status)];
      },
      notifyCompletion: async () => { notifications += 1; },
    });

    await assert.rejects(poller.poll(), /temporary list failure/);
    assert.equal(poller.isPolling(), false);
    await poller.poll();
    poller.reset();
    status = "done";
    await poller.poll();
    assert.equal(notifications, 0, "reset completion must not use stale active state");
    status = "working";
    await poller.poll();
    status = "idle";
    await poller.poll();
    assert.equal(notifications, 1);
  });
});

describe("missing pane and result-source reporting", () => {
  test("does not treat a missing pane as a settled completion", async () => {
    await assert.rejects(
      waitForAgents(["missing-pane"], 1000, {
        listPanes: async () => [],
        sleep: async () => undefined,
      }),
      /Cannot wait for missing tracked pane\(s\): missing-pane/,
    );
  });

  test("distinguishes missing status plus session, pane fallback, and unavailable sources", () => {
    const trackedAgent = {
      paneId: "gone",
      role: "review" as const,
      task: "review lifecycle",
      cwd: "/repo",
      createdAt: 1,
      batchId: "batch-1",
      supervisorPaneId: "supervisor",
    };
    assert.match(formatStatusLine(trackedAgent), /^- gone \[missing\] \(review\)/);
    assert.equal(formatCollectSource("session", "done"), "session record");
    assert.equal(formatCollectSource("session", "missing"), "session record (tracked pane missing)");
    assert.equal(formatCollectSource("pane-fallback", "idle"), "live pane fallback (no session result)");
    assert.equal(
      formatCollectSource("missing", "missing"),
      "unavailable (tracked pane missing and no session result)",
    );
  });
});

describe("latest batch filtering and message retention", () => {
  const agent = (paneId: string, batchId: string, createdAt: number) => ({
    paneId,
    role: "research" as const,
    task: paneId,
    cwd: "/repo",
    createdAt,
    batchId,
    supervisorPaneId: "supervisor",
  });

  test("selects the batch containing the newest agent while preserving list order", () => {
    const agents = [agent("old", "batch-a", 10), agent("new-1", "batch-b", 30), agent("new-2", "batch-b", 20)];
    assert.equal(getLatestBatchId(agents), "batch-b");
    assert.deepEqual(filterAgentsByBatch(agents, true).map((item) => item.paneId), ["new-1", "new-2"]);
    assert.equal(filterAgentsByBatch(agents, false), agents);
    assert.deepEqual(filterAgentsByBatch([], true), []);
  });

  test("retains only the newest 200 messages and characterizes message rendering", () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
      messageId: `msg-${index}`,
      fromPaneId: "from",
      toPaneId: "to",
      kind: "status" as const,
      body: ` body   ${index} `,
      createdAt: index,
      delivery: "reported" as const,
    }));

    const retained = keepRecentMessages(messages);
    assert.equal(retained.length, 200);
    assert.equal(retained[0].messageId, "msg-5");
    assert.equal(retained.at(-1)?.messageId, "msg-204");
    assert.equal(compactMessageBody("  many\n spaces  "), "many spaces");
    assert.equal(renderMessageLine(messages[0]), "- msg-0 [status] from -> to (reported) body 0");
  });
});
