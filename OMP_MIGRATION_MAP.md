# OMP_MIGRATION_MAP.md

OMPChamber 1.0 Architecture Audit 产物。

> 原则：**OpenChamber 负责产品体验，OMP 负责 Agent 能力。** 保护已打磨好的 UI，把 Harness 复杂度吸收到 Adapter 层。
> 基线：OpenChamber v1.18.1（upstream `openchamber/openchamber`，本仓库完整 Git 历史 2454 commits）。
> 处置图例：✅ 直接保留 / 🔌 需要 Adapter / 🔁 OMP 替代 / 🙈 暂时隐藏 / 🗑 最后删除

---

## 1. 审计方法

1. 读取根目录 `AGENTS.md`、相关模块 `DOCUMENTATION.md`（sync / stores / opencode / event-stream / git / fs / terminal / preview / vscode / electron README）。
2. 全库搜索 `@opencode-ai/sdk`、`opencode`、`OpenCode`，按 package 统计命中面。
3. 按「UI-only / Session / Message / Tool / Model / Provider / MCP / Runtime lifecycle / Git / Diff / Preview / Usage」分类。
4. 逐类标注处置。
5. 对照 OMP 官方 RPC 协议源码（`can1357/oh-my-pi` `rpc-types.ts`）评估映射可行性。

## 2. 现状架构快照

```
React UI (packages/ui)
  │  opencodeClient 门面（唯一生产 value import 点）
  ▼
Sync 层 (ui/src/sync/*) —— State/GlobalState = 18 个 SDK 类型
  │  WS / SSE
  ▼
OpenChamber server (packages/web/server)
  ├─ lib/opencode/*            ← OpenCode runtime 集成（89 文件）
  ├─ lib/event-stream/*        ← WS ↔ SSE 桥（自研）
  ├─ lib/git·fs·terminal·preview ← 自研，不依赖 OpenCode
  └─ HTTP proxy /api/*         ← 转发到 OpenCode server
  ▼
OpenCode server（独立进程，HTTP API + SSE）
```

### 2.1 SDK 依赖统计（`@opencode-ai/sdk@1.18.15`）

| 范围 | 文件数 | 说明 |
|---|---|---|
| packages/ui | 181–183 | components 76 / sync 53 / lib 22 / stores 18 / hooks 8 / apps 4 |
| packages/web | 6 | server 内 4 处 SDK 命令式调用 + proxy 转发 |
| packages/vscode | 5 | extension host + webview，不运行 server |
| packages/electron / mobile | 0 | electron 走二进制捆绑；mobile 无 |

### 2.2 UI 高频 SDK 符号

`Session`(86) `Part`(64) `Message`(54) `SessionStatus`(15) `OpencodeClient`(15) `Agent`(10) `Event`(10) `PermissionRequest`(9) `Todo`(8) `QuestionRequest`(7)

### 2.3 三个关键现状

1. **唯一运行时耦合点**：`packages/ui/src/lib/opencode/client.ts`（1975 行）是 `createOpencodeClient` 唯一生产调用处；`getSdkClient()` / `getScopedSdkClient(dir)` 把 SDK client 直接喂给 sync 层。
2. **类型泄漏枢纽**：`packages/ui/src/sync/types.ts` 的 `State` / `GlobalState` 直接由 SDK 类型构成；组件层大多仅 `import type`（最易替换）。
3. **已有 decoupling 基建**：`lib/api/types.ts`(RuntimeAPIs，0 SDK import)、`lib/runtime-fetch.ts`、`contexts/runtimeAPIRegistry.ts`。native 壳能力已解耦，**session/message/part 域未解耦**。

## 3. OMP RPC-UI 协议速览（官方 `rpc-types.ts`）

- 模式：`omp --mode rpc-ui`（= rpc + 暴露工具卡片/选择器/对话框）。
- 传输：**stdin/stdout NDJSON（JSON Lines）**，双向，`id` 关联请求响应。
- 协议版本：`negotiate_protocol`（v1 帧 ≤1MiB；v2 支持 chunk ≤64MiB）。
- 入站命令：`prompt` `steer` `follow_up` `abort` `abort_and_prompt` `new_session` `get_state` `set_fast_mode` `get_available_commands` `set_todos` `set_host_tools` `set_host_uri_schemes` `set_subagent_subscription` `get_subagents` `get_subagent_messages` `set_model` `cycle_model` `get_available_models` `set_thinking_level` `cycle_thinking_level` `set_steering_mode` `set_follow_up_mode` `set_interrupt_mode` `compact` `set_auto_compaction` `set_auto_retry` `abort_retry` `bash` `abort_bash` `get_session_stats` `export_html` `switch_session` `branch` `get_branch_messages` `get_last_assistant_text` `set_session_name` `handoff` `get_messages` `get_messages_page` `get_login_providers` `login`
- 出站：`response`（含 id）、`ready`、`rpc_chunk`、session 事件帧（AgentSessionEvent）、子代理帧（`subagent_lifecycle` / `subagent_progress` / `subagent_event`）、extension UI 请求帧（`extension_ui_request`：select / confirm / input / editor / cancel / notify / setStatus / setWidget / setTitle / set_editor_text / open_url）。
- Host 双向：`host_tool_call` / `host_tool_cancel` / `host_tool_update` / `host_tool_result`、`host_uri_request` / `host_uri_result`。

> **架构差异点（最关键）**：OpenCode 暴露 **HTTP API + SSE**，OpenChamber 的 UI/server 都按 HTTP 形状消费；OMP 是 **进程级 stdin/stdout RPC**，无 HTTP 面。因此 Adapter 层必须把 OMP 帧转换成 OpenChamber 已有的 event-stream / HTTP 契约（或同步收敛 UI 消费面）。


## 4. 依赖分类与处置矩阵

### 4.1 UI-only（可原样保留，仅类型来源待收敛）

| 模块 | 处置 | 说明 |
|---|---|---|
| Layout / Sidebar / Session List / Composer / Chat Timeline / Markdown / Thinking / Tool Card / Diff Viewer / Terminal / File Viewer / Git UI / Preview / Dialogs / Menus / Settings Layout / Theme / Animation / Spacing / Typography / Scrolling / Loading / Notifications / Keyboard | ✅ | 全部保留，不重做 |
| `ui/src/components/**` | ✅ 保留 + 🔌 类型收敛 | 76 文件 `import type { Session }` 等；组件本身不动，换类型来源 |
| `ui/src/lib/api/types.ts`（RuntimeAPIs） | ✅ | 0 SDK import，天然 domain 边界 |
| `ui/src/lib/runtime-fetch.ts` / runtime-url / runtime-auth / runtime-switch | ✅ | transport 抽象已解耦 |
| `contexts/runtimeAPIRegistry.ts` / `hooks/useRuntimeAPIs.ts` | ✅ | 注入机制保留 |
| Diff / Git 相关组件（复用 Git API） | ✅ | `useGitStore` 不 import SDK，已 decoupled 正面范例 |

### 4.2 Session（需要 Adapter 的枢纽）

| 文件 | 处置 | 说明 |
|---|---|---|
| `ui/src/lib/opencode/client.ts` | 🔌 | 唯一运行时耦合点。门面方法签名保留，内部换成 OMP RPC 驱动的实现 |
| `ui/src/sync/sync-context.tsx`（SyncProvider sdk=...） | 🔌 | sdk client 注入点 → OMPChamber domain client |
| `ui/src/sync/types.ts`（State/GlobalState） | 🔌 | 类型泄漏枢纽 → 改为 OMPChamber Domain Types |
| `ui/src/sync/session-actions.ts` / `session-ui-store.ts` / `session-message-loader.ts` / `session-event-router.ts` / `event-pipeline.ts` / `event-reducer.ts` / `reconnect-recovery.ts` / `global-session-status.ts` / `session-ordering.ts` / `streaming.ts` | 🔌 | sync 层 53 文件整体消费 SDK 形状；换 client + 类型后可渐进保留 |
| `stores/useGlobalSessionsStore.ts` / `globalSessions.ts` | 🔌 | session.list 来自 SDK → OMP session 源 |
| `web/server/lib/openchamber-sessions/routes.js`（session.fork 等） | 🔌 | 复用 OMP `branch` / `switch_session` |

OMP 对应能力：`new_session` `get_messages` `get_messages_page` `branch` `switch_session` `set_session_name` `get_state` `handoff` `export_html`。**Session 持久化以 OMP session 文件为 source of truth**，UI 只存 metadata（pinned/archived/icon/last-opened/draft/unread/favorite model）。

### 4.3 Message / Part（流式渲染核心）

| 文件 | 处置 | 说明 |
|---|---|---|
| `ui/src/sync/`（message/part buckets）+ `components/chat/message/parts/**` | 🔌 + ✅ | 渲染组件保留；数据形状由 Adapter 归一 |
| Thinking / reasoning 渲染 | ✅ | OMP `message_update` 带 thinking 内容 → Adapter 转 ReasoningPart 形状 |
| `lib/messages/synthetic.ts` 等 | 🔌 | 消息合成逻辑保留，类型换 |

### 4.4 Tool（ToolRendererRegistry 目标）

| OMP 工具 | 目标 UI | 处置 |
|---|---|---|
| read / write | 文件卡片（点击打开、显示范围） | 🔁 OMP 替代 + ✅ UI 复用 |
| edit | Edit Diff（Open Diff 复用 Diff UI） | 🔁 重点适配 |
| bash | Bash Card（stdout/stderr 展开，Open in Terminal） | 🔁 |
| grep / glob | Search Card | 🔁 统一为 Search |
| ask | 原生 Question/Ask UI（映射 extension_ui_request select/confirm/input） | 🔁 |
| todo | Tasks / Todo 进度（映射 set_todos / TodoPhase） | 🔁 |
| task | Subagent Card（task = subagent，进度/工具计数，点击进详情） | 🔁 重点 |
| P1：browser web_search github lsp debug eval inspect_image hub checkpoint rewind recall retain reflect | 第二阶段 | 🔁 |

**架构落地**：新建 `ToolRendererRegistry`（`registerToolRenderer("edit", EditRenderer)` 等），已知工具走 Native UI，未知工具走 Generic Tool Card。Extension 新增工具永不崩 UI。

### 4.5 Model / Provider

| 文件 | 处置 | 说明 |
|---|---|---|
| `web/server/lib/opencode/proxy.js`（/api/model /api/provider 透传） | 🔁 | 改由 OMP `get_available_models` `get_login_providers` `login` 驱动 |
| `web/server/lib/opencode/auth.js`（`~/.local/share/opencode/auth.json`） | 🔁 | 凭据改由 OMP 管理（auth file / OMP login） |
| `web/server/lib/opencode/providers.js`（opencode.json 自定义 provider） | 🔁 | 自定义 provider 走 OMP 配置层 |
| `ui/.../ProvidersPage.tsx` / `stores/useConfigStore.ts` / `selection-store.ts` | ✅ 保留 + 🔌 | UI 保留；数据来源换 |
| `openchamber-routes.js` models-metadata（models.dev） | ✅ | 与 harness 无关，保留 |

### 4.6 MCP

| 文件 | 处置 | 说明 |
|---|---|---|
| `ui/.../McpPage.tsx` / `stores/useMcpStore.ts` / `useMcpConfigStore.ts` | ✅ 保留 + 🔌 | UI 保留 |
| `web/server/lib/opencode/config-entity-routes.js`（/api/config/mcp） | 🔁 | MCP 配置走 OMP（OMP 原生支持 MCP） |

### 4.7 Runtime lifecycle（最大的替换面）

| 文件 | 处置 | 说明 |
|---|---|---|
| `web/server/lib/opencode/lifecycle.js`（spawn `opencode serve`） | 🔁 | → `omp/process-manager.ts`：spawn `omp --mode rpc-ui`，heartbeat/exit/restart/backoff/timeout/abort |
| `web/server/lib/opencode/env-runtime.js`（binary 解析） | 🔁 | → OMP binary 解析（bundled OMP / 高级设置 "Use system OMP"） |
| `web/server/lib/opencode/proxy.js`（/api/* HTTP 透传） | 🔁 | → `rpc-client.ts`（stdin/stdout NDJSON） |
| `web/server/lib/opencode/session-runtime.js` / `watcher.js` | 🔁 | → `event-normalizer.ts`（OMP Event → OMPChamber Event） |
| `web/server/lib/event-stream/**` | ✅ | 自研 WS↔SSE 桥保留；上游 reader 换成 OMP event 源 |
| `web/server/lib/opencode/upgrade-capability.js` / `routes.js` 升级 | 🔁 | → OMP version 固定策略（bundled OMP；禁止自动追新） |
| `web/server/lib/opencode/config-entity-routes.js`（agents/commands） | 🔁 | Agents/Commands 走 OMP |
| `web/server/lib/opencode/auth-state-runtime.js` / `server-utils-runtime.js` / `network-runtime.js` 等 | 🔁 | 随 opencode 移除或改为 omp 等价物 |
| `web/server/lib/opencode/skills*` / `skill-routes.js` | 🔁 + ✅ | OMP 原生 Skills；OpenChamber skills-catalog UI 可复用 |
| `electron/scripts/prepare-opencode-cli.mjs` | 🔁 | → prepare-omp-cli.mjs（下载 bundled OMP） |

### 4.8 Git / Diff / Preview / Terminal / FS / Worktree（完全不依赖 OpenCode）

| 模块 | 处置 | 说明 |
|---|---|---|
| `web/server/lib/git/**` | ✅ | 自研（simple-git），与 harness 无关 |
| `web/server/lib/fs/**` | ✅ | 自研 |
| `web/server/lib/terminal/**` | ✅ | 自研 PTY |
| `web/server/lib/preview/**` | ✅ | 自研 |
| Worktree 逻辑（OpenChamber 成熟） | ✅ | **worktree 不交给 OMP**；OMP Session `cwd` 指向 worktree |

### 4.9 Usage 及其他 OpenCode-specific

| 模块 | 处置 | 说明 |
|---|---|---|
| `web/server/lib/quota/**` / `ui/.../UsagePage.tsx`（opencode-go quota） | 🙈 暂时隐藏 | OpenCode-specific usage |
| `ui/.../OpenCodeCliSettings.tsx` / `OpenCodeUpdateToast` / `useOpenCodeReadiness` | 🔁 替换为 OMP 设置 | OMP binary/version/config dir 设置 |
| `web/server/lib/agent-tool/**`（注入 OpenCode custom tool） | 🙈 暂时隐藏 | 后续用 OMP `set_host_tools` 等价实现 |
| `web/server/lib/scheduled-tasks/**`（依赖 opencode command） | 🙈 暂时隐藏 | OpenChamber 调度能力，等 OMP 稳定后复用 |
| `ui/.../AgentsSidebar` / `useAgentsStore` / `AgentGroups` | 🔁 | Agent 概念走 OMP agent（task/subagent） |
| Fusion / Multi-run | 🙈 暂时隐藏 | OpenCode 并行特性，推迟 |
| Remote instances / tunnels | ✅ 保留或 🙈 | tunnels 自研保留；remote OpenCode instance 管理隐藏 |
| `packages/vscode/**` | 🙈 推迟 | vscode 扩展整个推迟到 OMP 稳定后 |
| `packages/mobile/**` | 🙈 推迟 | 不在 1.0 |
| docs/opencode 相关页面 | 🔁 | 更新为 OMP 文档 |

## 5. 渐进式替换（Strangler Pattern）路线

```
Phase 0  Repository init（已做）：rename/branding/license/upstream/build
Phase 1  OMP process + RPC client + event logger（不碰 UI）
Phase 2  OMPChamber Domain Protocol：OMP raw event → Session/Message/Thinking/ToolCall/ToolResult/Status
Phase 3  现有 Chat UI 吃 OMP 数据：prompt/streaming/thinking/read/write/edit/bash（UI 不重设计）
Phase 4  ask/todo/task/subagent/model/reasoning/session resume/branch/compact/abort
Phase 5  完整替换 OpenCode backend（确认无核心依赖后再删除 lifecycle/server/adapters）
Phase 6  browser/lsp/mcp/skills/extensions/memory/github/debug
```

### 实施进度（截至 2026-08-10）

| Phase | 状态 | 交付物 |
|---|---|---|
| 0 | ✅ 完成 | rename/branding（OMPChamber 0.1.0）、THIRD_PARTY_NOTICES、upstream 历史 2454 commits、原始 build 验证 |
| 1 | ✅ 完成 | `packages/web/server/agent-runtime/omp/`：process-manager / rpc-client / rpc-types / logger（redact）；真实 omp spawn + ready + 命令链路验证（smoke-test.mjs） |
| 2 | ✅ 完成 | `packages/agent-protocol/`（Domain Types）+ event-normalizer / session-manager / model-manager / tool-normalizer / ui-request-handler / compatibility；18 个 normalizer 单测 |
| 3 | ✅ 完成 | `OMPCHAMBER_AGENT_ENGINE=omp` 开关：omp-adapter-http.js（session/model/message HTTP 投影）+ omp-event-bridge.js（domain→SSE 帧）+ global-hub.markConnected/publishEvent；真实 server 端到端验证（prompt→thinking→text→WS 实时流） |
| 4 | ✅ 完成 | adapter 端点：abort/compact/branch/rename/thinking/ask + **todo（Task Progress 实时链路：OMP todo_reminder → todo.updated SSE，真实验证）/ subagents 端点**；10+ adapter 集成测试 |
| 5 | ✅ 完成 | 剪断 OMP 下 OpenCode URL 隐式依赖（buildOpenCodeUrl/waitForOpenCodeReady/waitForOpenCodePort 守卫）；**UI 深层 SDK 穿越已收敛**（session-actions 5 处改走门面：moveSessionToDirectory/replyToPermission/replyToQuestion/rejectQuestion；56 测试全过）；**Electron bundled OMP**（prepare-omp-cli.mjs 打包固定 17.2.12 + extraResources + 桌面 settings agentEngine 切换，真实验证 bundled OMP 引擎 ready + 消息）；**OMP 下 buildOpenCodeUrl 修复**：加 `/api` 前缀 + 取 server 实际监听端口（修复前内部模块打 `http://127.0.0.1:port/session/xxx` 缺前缀 404；修复后 permission-auto-accept/ompchamber-sessions/scheduled-tasks/notifications/context-obligatory 全链路 200，日志零 404）；**验证状态**：OMP 组合 70 测试全绿 + web 全量 1245 通过（历史最佳）+ type-check 6/6 + **MVP 验收真实 coding 任务 read→edit→bash→tsc pass** + HTTP 层全端点矩阵（session/model/provider/path/abort/compact/branch/fork/todo/message/settings/system-info 全形状正确）+ **abort 真实链路**（长任务→abort→session 可用→后续 prompt 收到回复，已固化为集成测试）+ subagent 边界探索（get_subagents 始终空，set_subagent_subscription 防御性增强）；删除分级评估（A≈11/B≈38/C≈5）；**剩余**：物理删除需「默认引擎切换」产品决策（Electron settings agentEngine / web env，方案明确渐进迁移 OpenCode stays default until fully converges）+ UI sync 类型收敛（53 文件 SDK 类型 → Domain Types 独立工程） |
| 5b | ✅ 完成 | **物理删除 OpenCode 运行时**：`lib/opencode/` 37 个通用模块 git mv → `lib/ompchamber/`（agents/auth/bootstrap-runtime/commands/config-*/core-routes/feature-routes-runtime/hmr-state-runtime/mcp/models-metadata/npm-registry/ompchamber-routes/plugin-*/project-*/providers/pwa-manifest-routes/routes/server-*/session-runtime/settings-*/shared/shutdown-runtime/skill-*/snippets/startup-pipeline-runtime/static-routes-runtime/theme-runtime/tunnel-*/watcher 等 + 27 测试 + DOCUMENTATION.md）；21 个 OpenCode 运行时模块 git rm（lifecycle/env-runtime/env-config/network-runtime/auth-state-runtime/opencode-resolution-runtime/upgrade-capability/watcher/managed-process-registry/proxy/cli-*/path-utils + 测试）；omp-adapter-http/omp-event-bridge → `agent-runtime/omp/`；provider-env-aliases/startup-performance → `lib/` 通用层；index.js 8 个死 import 删除 + OpenCode 兼容 stub 保留（buildOpenCodeUrl/getOpenCodeAuthHeaders/waitForOpenCodeReady/restartOpenCode/refreshOpenCodeAfterConfigChange/getOpenCodeResolutionSnapshot/getOpenCodeUpgradeCapability）；`ompEngineEnabled = () => true`（OMP 是唯一引擎）；**验证**：web 全量 129 files/1159 tests 全绿 + lib/ompchamber 249 tests + agent-runtime 70 tests + vscode parity 3 tests + bun build 1050 modules 成功 + server 零 lib/opencode 引用 |
| 6 | ✅ 完成 | **UI 类型收敛**：`packages/agent-protocol/src/domain-types.ts`（~1400 行 SDK 形状镜像：Session/Part/Message/SessionStatus/Event/QuestionRequest/PermissionRequest/Agent/Project/Provider/Model/Path/VcsInfo/Command/LspStatus/McpStatus/Config/Todo/PermissionV2*/SdkResult/OpencodeClient 接口）；`packages/ui/src/lib/opencode/domain-client.ts`（~900 行自研 DomainClient 实现 OpencodeClient 契约，基于 runtimeFetch，SSE 流 + Last-Event-ID 重连 + throwOnError）；client.ts 门面 2020 行零改动仅换 import；UI 全部 185 文件 `@opencode-ai/sdk` → `@ompchamber/agent-protocol/domain-types`；UI package.json 删除 SDK 依赖；**验证**：UI type-check 全绿 + UI bun test 1585 pass/257 fail 与基线完全一致（零回归）+ web 全量 1159 tests 全绿 + UI grep opencode-ai/sdk 零结果 |

**Phase 5 删除分级**（`packages/web/server/lib/opencode/` 54 个非 test .js）——**已全部执行完毕（2026-08-11）**：
- **A 可安全删**（≈11）：cli-*、env-config、env-runtime、managed-process-registry、network-runtime、opencode-resolution-runtime、proxy、provider-env-aliases、upgrade-capability、lifecycle（清理 index.js 引用后）——**已 git rm**
- **B 需 adapter 才能删**（≈38）：auth-state-runtime、agents、commands、config-*、core-routes、feature-routes-runtime、hmr-state-runtime、mcp、npm-registry、ompchamber-routes、plugin-*、project-*、routes、server-*、session-runtime、settings-*、shutdown-runtime、skill-*、startup-*、static-routes、theme-runtime、tunnel-*、watcher——**已 git mv → lib/ompchamber/**（通用模块，非 OpenCode 运行时）
- **C 绑定外部无法删**（5）：auth.js、shared.js、models-metadata.js、providers.js、snippets.js（通用工具误放，应迁至 `lib/` 通用层）——**已 git mv → lib/ompchamber/ 或 lib/ 根**
- **保留**：omp-adapter-http.js、omp-event-bridge.js（OMP 桥）——**已 git mv → agent-runtime/omp/**

**Phase 5 遗留洞**（OMP 下 OpenCode URL 隐式依赖已剪断，UI 深层 SDK 穿越已收敛，但需 UI 类型收敛才能彻底替换）：
1. ~~UI 深层 SDK 穿越：`sync/session-actions.ts` 5 处直接调用~~ ✅ 已收敛为门面方法（`moveSessionToDirectory`/`replyToPermission`/`replyToQuestion`/`rejectQuestion`），56 测试通过。
2. client.ts 门面 60 方法中 `getConfig/updateConfig/getProviders/listAgents/listCommands/readFile/listFiles/searchFiles/...` 在 OMP 下需 adapter 补齐或降级。**已补齐 adapter 端点：`/api/model` `/api/provider` `/api/config`（空配置防崩）`/api/ompchamber/agent/status` `/api/ompchamber/thinking` `/api/ompchamber/ask/:id` `/api/ompchamber/todo` `/api/ompchamber/subagents` + session/message/abort/compact/branch/rename**。自研端点（git/terminal/fs/settings）在 OMP 引擎下已验证正常工作。**OpenCode 生态端点优雅降级**（`/api/agent` `/api/command` `/api/mcp` `/api/project` `/api/skill` 返回 `[]`、`/api/global/version` 返回 OpenCode 形状版本对象，避免 UI 404 重试报错；OMP 拥有自己的配置/认证模型，详情类动态路径 `:id` 走 UI catch 降级不伪装）。**session resume + UI 真实发消息路径已补齐并真实验证**：`GET /api/session/:id`（session.get 形状，resume）+ `PATCH /api/session/:id`（SDK session.update 形状，改名同步到 OMP source of truth）+ `POST /api/session/:id/prompt_async`（UI `session.promptAsync` 真实发消息路径——此前 MVP 验证用手动 /message 绕过，现真实 UI 形状全链路验证：prompt_async→OMP→消息读回）。UI 斜杠命令（sendCommand）因 OMP 引擎下命令列表为空不触发，正常走 prompt_async。**端到端端点覆盖审计（UI client.ts 门面全部 SDK 方法对照）已补齐**：`GET /api/session/status`（必须注册在 `/api/session/:sessionId` 之前，否则 "status" 被当 sessionId 吞掉；返回 `Record<sessionId,{type}>` 形状）+ `/api/config/providers` `/api/project/current` `/api/experimental/tool/ids` `/api/question` `/api/permission`（空列表降级）+ `/api/path`（返回 `{directory,worktree,state}` 形状）。**client.ts 门面全覆盖审计（第二轮）**：`app.agents`(→/agent 降级)/`app.skills`(→/skill 降级)/`command.list`(→/api/command 降级)/`config.providers`(降级)/`file.*`(UI 非测试零调用，FilesView 走自研 /api/fs)/`session.*` 全部覆盖。**本轮新增**：`POST /api/session/:id/fork`（OMP new_session 映射，cancelled→400）+ `DELETE /api/session/:id`（返回 `{ok:true}`，OMP 单会话无 delete）+ `POST /api/session/:id/command`→**501**（OMP 无命令面，防御性明确失败）+ `GET /api/session/:id/todo`（`runtime.session.current.todos`）+ `POST /api/session/:id/{revert,unrevert,shell,summarize}`→**501**（OMP 无对应 RPC）+ **OpenCode 形状权限/问题响应端点**（`POST /api/session/:id/permissions/:permissionId`、`/question/:requestId/reply|reject` → respondAsk）。**omp-event-bridge ask 投影（关键缺口）**：原 bridge 丢弃 ask 帧，新增 confirm→`permission.asked`（PermissionRequest 形状）、select/input→`question.asked`（QuestionRequest 形状，含 options/placeholder）；index.js stampSessionId 扩展 properties.permission/question 分支。**测试稳定性修复**：adapter 测试 beforeAll 显式 30s 超时（bun hook 默认 5s，多 OMP 测试文件并发 spawn 时超时）——组合跑 69 测试全绿。剩余辅助功能（session.command/shell/revert/summarize/fork）在 OMP 引擎下 501 明确失败（UI 有 catch/toast），非 MVP 主路径。
3. VSCode 跨包引用 `provider-env-aliases`（管理其独立 opencode serve），不可物理删除。

**关键实施策略**：
1. `packages/agent-protocol/`（或 `agent-runtime/`）先定义 OMPChamber Domain Types（AgentSession / AgentMessage / ToolCall 等）。
2. Adapter 层把 OMP 事件归一为 Domain Event，再投影到 sync 层现有 State 形状 → UI 零改动先行。
3. 逐步把 sync/types.ts 从 SDK 类型换成 Domain Types，一次一个 bucket。
4. `client.ts` 门面保持方法签名不变，替换内部实现（Strangler 的手术刀点）。

## 6. 硬性约束（红线）

1. **UI 不得直接 import OMP 类型**，也不得继续直接依赖 OpenCode SDK 类型。
2. **`omp` 必须运行在独立进程**（OmpProcessManager spawn），Electron Main 不直接跑 AgentSession。
3. **固定 bundled OMP 版本**，禁止自动升级（OMP v17.2.x ↔ OMPChamber 0.1 对账）；高级设置可 "Use system OMP"。
4. **OMP Session 是 conversation source of truth**，不复制 transcript 数据库。
5. **Model/Provider 完全读 OMP**，不自己实现 Provider。
6. 所有 OMP 进程具备 heartbeat / exit detection / stderr capture / restart / backoff / timeout / abort；UI 状态必须有 `OMP crashed [Restart][View Logs]`，禁止无限 loading。
7. 日志 `~/.ompchamber/logs/`：app.log / omp.log / rpc.log / crash.log，**redact Authorization/API keys/OAuth tokens/Secrets**。
8. Worktree 归 OpenChamber，OMP 只管 cwd。
9. 每个 OMP 升级走 compatibility branch + protocol tests + integration tests + visual regression + 手动测试。
10. 每次改 `packages/ui` 前先问「能否在 Adapter/Normalizer 层解决？」——能，就改 Adapter。

## 7. 测试体系

| 类型 | 覆盖 |
|---|---|
| Protocol Test | Recorded RPC fixture：prompt/thinking/tool call/tool result/ask/abort/error/session switch/compact/subagent |
| Integration Test | 真启动 bundled OMP：spawn → prompt → read → edit → bash → finish |
| Visual Regression | Chat/Thinking/Edit/Diff/Bash/Ask/Task/Error/Loading/Session Sidebar/Composer |
| Manual | edit/bash/ask/task/session/compact 每次升级回归 |

**实施状态（2026-08-10）**：协议测试已落地（`agent-runtime/omp/protocol-fixtures.test.js`，13 个 recorded RPC fixtures）；集成测试已落地（adapter 真实 omp 进程，12 测试）；normalizer 20 测试；bridge 4 测试；**web 全量 1224 通过**（含修复 2 个上游预先存在失败：git.test mock 补 `getGitRangeDiff`、sse-routes app mock 补 `patch`）；全仓 type-check 6/6 通过。

## 8. 未知项 / 待确认

- [x] OMP binary 分发渠道与捆绑方式（npm `@oh-my-pi/pi-coding-agent` vs GitHub release artifact）——**已定：npm `@oh-my-pi/pi-coding-agent@17.2.12` 捆绑进 `resources/omp-cli`（prepare-omp-cli.mjs），extraResources 打包，bundled OMP 通过全部 29 个 adapter 集成测试**
- [ ] OMP `extension_ui_request` 与 OpenChamber Question/Permission UI 的映射细节。
- [ ] OMP session 文件格式与 OpenChamber `session.list` / sidebar 全局缓存的对接（一次性列出 vs 增量）。
- [ ] OMP host tools（`set_host_tools`）能否承载 OpenChamber 未来注入能力。
- [ ] `omp --mode rpc-ui` 子代理事件（subagent_*）与 Task UI 映射。
