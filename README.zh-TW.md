# pi-herdr-subagent

[English](./README.md)

為 pi 提供 **可見的、以 herdr pane 為基礎的 subagents**。

這個套件讓 supervisor agent 可以在獨立的 herdr panes 中啟動幾個 **真正的 pi subagents**，讓使用者直接觀察進度，而不是依賴隱藏的背景 worker。

## 功能

它提供以下工具：

- `herdr_subagents_spawn`
- `herdr_subagents_status`
- `herdr_subagents_global_status`
- `herdr_subagents_collect`
- `herdr_subagents_interrupt`
- `herdr_subagents_clear`

它也內建 `herdr-subagents` skill，用於 supervisor 風格的 pane orchestration。

## 適用情境

適合在你想要這些效果時使用：

- 一個主要的 supervisor pane
- 1-4 個可見的 worker panes
- 透明化的平行 research / review / implementation 工作流
- 在 herdr 裡進行簡單的 fan-out / fan-in 流程

當使用者想要 **直接看到每個 subagent 在做什麼** 時，這特別有幫助。

## 特性

- 在相鄰的 herdr panes 中啟動 1-4 個可見 subagents
- 依 pane 追蹤 subagent 狀態
- 從 subagent session 收集結構化結果
- 在各 pane 結果之上加上一層輕量 supervisor synthesis
- 支援在 tracked pane 完成時，將輕量 completion notification 回送到 supervisor pane
- 先用簡單的三種角色：
  - `research`
  - `implement`
  - `review`
- 支援整批共用預設角色，或每個 task 個別覆寫角色

## 需求

- [pi](https://github.com/earendil-works/pi)
- [herdr](https://github.com/ogulcancelik/herdr)
- 目前的 pi session 必須執行在 **herdr pane 內**

## 安裝

```bash
pi install https://github.com/hisetu/pi-herdr-subagent
```

接著重新載入 pi：

```text
/reload
```

## 工具說明

### `herdr_subagents_spawn`

在相鄰 panes 中啟動幾個可見的 subagents。

參數：

- `tasks: Array<string | { task: string; role?: "research" | "implement" | "review"; model?: string }>` — 1 到 4 個 task prompts
- `role?: "research" | "implement" | "review"` — 當 task 沒有個別指定角色時使用的預設角色
- `model?: string` — 可選的預設 pi model override
- `thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`
- `cwd?: string` — 啟動 panes 時的工作目錄

範例：

```json
{
  "tasks": [
    "Inspect auth token flow in the Postman collection.",
    "Inspect where ssid is generated and consumed in the Android app."
  ],
  "role": "research",
  "thinking": "minimal",
  "cwd": "/Users/lucas"
}
```

混合角色範例：

```json
{
  "tasks": [
    { "task": "Inspect auth token flow in the Postman collection.", "role": "research", "model": "github-copilot/gpt-5.4" },
    { "task": "Review auth/session refactor for API design and migration risk.", "role": "review", "model": "anthropic/claude-opus-4.7" },
    { "task": "Fix one focused Compose state bug in the Android app.", "role": "implement" }
  ],
  "thinking": "minimal",
  "cwd": "/Users/lucas"
}
```

### `herdr_subagents_status`

顯示目前 session 追蹤中的 subagent panes。

參數：

- `includeDone?: boolean`
- `latestOnly?: boolean` — 只顯示最新一批 spawned batch

### `herdr_subagents_global_status`

檢查目前 herdr workspace 中疑似 subagent 的 panes，即使它們不屬於目前 session 也可以看到。

參數：

- `lines?: number`
- `includeAllPiPanes?: boolean`

### `herdr_subagents_collect`

收集 tracked subagent panes 的結果。

輸出包含：

- 跨 panes 的輕量 synthesized summary
- 原始的每-pane 結構化結果

參數：

- `wait?: boolean` — 等待 panes 收斂到 `idle` / `done`
- `lines?: number` — fallback pane-read line count
- `timeoutMs?: number`
- `latestOnly?: boolean` — 只收集最新一批

### `herdr_subagents_interrupt`

中斷 tracked subagent panes。

參數：

- `paneId?: string`
- `latestOnly?: boolean`

### `herdr_subagents_clear`

清除 tracked subagent panes，並可選擇關閉它們。

參數：

- `closePanes?: boolean`
- `latestOnly?: boolean`

## 角色

### `research`

適合：

- code investigation
- API tracing
- log analysis
- fact finding

預期輸出格式：

- `Conclusion:`
- `Evidence:`
- `Unknowns:`

### `implement`

適合：

- 小範圍 code changes
- isolated fixes
- narrow refactors

預期輸出格式：

- `Changed files:`
- `Summary:`
- `Risks:`

### `review`

適合：

- correctness review
- API design review
- migration risk review
- maintainability review

預期輸出格式：

- `Findings:`
- `Severity:`
- `Recommended changes:`

## 建議流程

1. 將工作拆成 2-4 個窄範圍 tasks
2. 呼叫 `herdr_subagents_spawn`
3. 用 `herdr_subagents_status` 檢查進度
4. 用 `herdr_subagents_collect` 收集結果
5. 用內建 lightweight synthesis 快速看 supervisor summary
6. 如果有 pane 卡住，可用 `herdr_subagents_interrupt`
7. 完成後可用 `herdr_subagents_clear` 清理 tracked panes
8. 如有需要，在 supervisor pane 綜合出最終答案

## 備註

- 這個套件只能在 herdr 管理的 panes 內使用
- 若你在不同 supervisor / session 中觀察，可用 `herdr_subagents_global_status` 看 workspace-wide 的粗略狀態
- 支援整批共用角色，也支援 per-task role overrides
- collect 會優先讀取 spawned subagent 的 **session output**，不足時才 fallback 到 pane output
- 缺失的 panes 會自動從 tracked state 移除
- 想只看最新一批時可用 `latestOnly: true`
- extension 會在 tracked pane 進入 `idle` 或 `done` 時，回送輕量 completion notify 到 supervisor pane

## 未來想法

- richer supervisor summaries
