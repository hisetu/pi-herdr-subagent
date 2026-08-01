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
