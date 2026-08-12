# OMPChamber v2.0.4 交接文档（2026-08-12）

> **状态：v2.0.4 已完成并发布。** 本文档是原始过程记录；最终交付内容、验证基线与剩余偏差以 `CHANGELOG.md [2.0.4]` 和 `OMP_MIGRATION_MAP.md` Phase 9 为准。

> 前一阶段因模型配额中断，本文档向接手者完整交代：当前进度、未提交半成品、已定跨端契约、剩余任务、验证与发布流程、关键坑。
> 仓库：`realchendahuang/OMPChamber`，分支 `main`，当前 HEAD = `db981312b`（= tag `v2.0.3`，已发布上线，25 资产全绿）。
> 总纲文档：`OMP_MIGRATION_MAP.md`（含 Phase 0–8 全部决策与红线），根 `AGENTS.md`（仓库铁律）。

---

## 1. 产品背景与本轮目标

OMPChamber 是 OpenChamber 的 fork，Agent 引擎已从 OpenCode 换成 OMP（npm `@oh-my-pi/pi-coding-agent@17.2.12`，独立进程 `omp --mode rpc-ui`，stdin/stdout NDJSON RPC）。服务端（`packages/web/server/agent-runtime/omp/`）把 OMP RPC 投影成 OpenCode 形状的 HTTP/SSE 供 UI 消费。

**业主明确决策：产品尚未正式发布，无用户数据包袱，允许彻底 breaking change，不要任何迁移/兼容 fallback 代码。**

本轮（v2.0.4）目标：消灭迁移遗留的最后一批妥协实现——多会话支持、会话删除、斜杠命令输出上时间线、PlanView 路径 OMP 化、持久化设置键彻底改名、移除 `OPENCODE_BINARY` 废弃 fallback。

**已完成并发布的 v2.0.3 内容**（不要在 v2.0.4 重复）：adapter 端点真化（command list/执行、shell、summarize、fork/branch、真实版本号、session status、todo、pending question/permission 注册表）、Windows 双启动器、onnx 按架构剪枝、升级 feed 重定向 oh-my-pi、约 35 处文案清扫、skill-routes ReferenceError 修复、自定义 OMP binary 设置生效。详见 `CHANGELOG.md` [2.0.3] 与 `OMP_MIGRATION_MAP.md` Phase 8。

---

## 2. 工作区未提交半成品（重要：先盘点再动手）

两个子代理中断时在工作区留下了**已通过局部验证但未提交**的改动。语法与类型检查已通过（`node --check` OK、`packages/ui` type-check 干净）。

### 2.1 Server 侧（packages/web，完成度 ~40%）

- **新增 `packages/web/server/agent-runtime/omp/session-store.js`**（完成，质量高）：OMP 磁盘会话存储的读取/删除模块。头部注释完整记录了经真实二进制验证的布局：`<sessionsRoot>/<bucket>/<ISO时间戳>_<sessionId>.jsonl`；sessionsRoot 解析（`PI_CONFIG_DIR`/profile/`PI_CODING_AGENT_DIR`/XDG）；bucket 编码规则（镜像 OMP 的 `KXi`，realpath 比较）；文件格式（第 1 行 title 槽、第 2 行 session header v3）；subagent 伴随目录随文件一起删；损坏文件跳过不拖垮列表。
- **修改 `session-manager.js`**（+138 行）：已接入 session-store，新增 `listSessions(directory)`（:287）和 `deleteSession(sessionId, directory)`（:358），live 会话会合并进列表。
- **缺口**：`omp-adapter-http.js` **尚未接线**——HTTP 端点还是旧的假实现（`GET /api/session` 单会话假列表、`GET /api/session/:id` 任意 id 都返回当前会话、`DELETE` 假 ok）。需要把端点改到 manager 的新方法上，并补测试。
- 子代理中断时的内部 todo 显示：探索与 live 实验（session store、switch_session、delete、branch、command_output）已完成，Task 1（真实 session 列表）进行中。其余任务未开始。

### 2.2 UI 侧（packages/ui，完成度 ~50%）

- **command_output 时间线渲染（任务 2，基本完成）**：
  - `src/sync/event-reducer.ts`（+170 行）：新增 `case "ompchamber:command-output"`，把命令输出合成为 client-only 的 synthetic assistant 消息（单个 synthetic text part，走标准 assistant 文本渲染）。部分行为已在注释中说透：live-only（下次权威消息加载会覆盖，server 不持久化）；按 parentID 挂到产生它的 user 消息（显式 payload messageID 可解析则用，否则最近一条已加载 user 消息，都没有则建隐藏的 synthetic user marker）；SSE Last-Event-ID 重放会去重。ID 生成器镜像 OMP `Identifier.ascending` 格式。
  - `src/sync/sync-context.tsx`（+6 行）：事件路由（:783, :1696）。
  - `src/sync/__tests__/event-reducer.test.ts`（+128 行，**21/21 通过**）。
  - `src/sync/DOCUMENTATION.md` +1 行。
  - **注意：server 侧的 SSE 投影还没写**（见任务 5），目前 UI 消费的是一个尚不存在的事件。
- **PlanView 路径改名（任务 1，完成）**：`PlanView.tsx` 4 行——`.opencode/plans` → `.omp/plans`、`~/.opencode/plans` → `~/.omp/plans`。**但 server 侧 fs 守卫（`lib/fs/routes.js:1346`）还没改**，两端暂时不一致。
- relay 注释（crypto/protocol/tunnel-client/tunnel-codec/tunnel-payloads 各 1 行）：`.opencode/plans/private-relay` 规格引用注释修正。
- **未开始**：任务 3（设置键改名）、任务 4（死 `opencode/` 分支前缀清理）。

---

## 3. 已定跨端契约（两边必须严格对齐，不要另起名字）

1. **SSE 事件**：`ompchamber:command-output`，payload 至少 `{ sessionID, text }`，可选 `messageID`（关联到产生输出的 user 消息）、`command`。UI 端已按此实现。Server 端投影写在 `omp-event-bridge.js`（仿 `ompchamber:subagent` / `ompchamber:available-commands` 先例），normalizer 映射写在 `event-normalizer.js`，并更新 `agent-runtime/omp/DOCUMENTATION.md`。
2. **设置键新名**（干净改名，无 fallback、无迁移代码）：
   - `opencodeBinary` → `ompBinary`
   - `showOpenCodeUpdateNotifications` → `showOmpUpdateNotifications`（settings.json 键 + zustand store 字段/action `setShowOmpUpdateNotifications`）
   - `openCodeUpdateToastDismissedVersion` → `ompUpdateToastDismissedVersion`；localStorage 键 `opencode-update-toast-dismissed-version` → `omp-update-toast-dismissed-version`
3. **计划目录**：repo 级 `.omp/plans`，home 级 `~/.omp/plans`。server fs 守卫与 UI 写路径必须一致。

### 不要动的保留契约（与 OMP 引擎或外部服务的接口，不是用户数据）

- 磁盘路径 `~/.config/opencode`、`~/.local/share/opencode`、`.opencode/`、`opencode.json`——**OMP 引擎自己的兼容插件会读这些**（已从 bundled cli.js 验证：MCP/skills/commands/settings/AGENTS.md 加载）。
- skill `source: 'opencode'` 数据契约、`processOpenCodeSsePayload` SSE schema 名、`OPENCODE_UPGRADE_*` payload codes。
- env：`OPENCODE_CONFIG_DIR`、`OPENCODE_SERVER_USERNAME/PASSWORD`、`VITE_OPENCODE_URL`（本轮不碰；`OPENCODE_BINARY` 除外——见任务 8）。
- `omp` 二进制固定 17.2.12，禁止自动升级（红线，见 OMP_MIGRATION_MAP §6）。上游已到 17.2.15，升级需走 compatibility branch + 协议/集成测试，不在本轮。

---

## 4. 剩余任务清单

### Server（packages/web）

1. **[收尾] 真实 session 列表**：把 `GET /api/session` 接到 `session-manager.listSessions(directory)`（已完成），保持 OpenCode 形状（参照 `toSdkSession`），按 directory 过滤，live 会话合并。补测试。
2. **真实 session get/resume**：`GET /api/session/:sessionId`——非 live 会话用 `switch_session` 切换后返回（实验方法：spawn 真实 omp rpc-ui 验证 switch_session 能否按 id 加载磁盘会话、返回什么、`get_messages` 能否读回历史）；不可行为任意 id 切换时至少读文件投影元数据并保持行为诚实。
3. **真实 delete**：`DELETE /api/session/:id` 接到 `deleteSession`。定义删除**活跃会话**的显式行为（409 拒绝或先切新会话——用真实二进制验证 OMP 容忍度）；文件不存在的 404/幂等语义写清楚。
4. **revert/unrevert**：保持 501，但错误 payload 说明原因并给出替代（fork/branch）；确认 UI `client.ts revertSession` 失败路径优雅。禁止用 branch 伪装 revert。结论写进 DOCUMENTATION.md。
5. **command_output → SSE**：normalizer + bridge 投影（契约见 §3.1）。实验确认帧到达时的 turn/消息上下文（能否关联 messageID）。
6. **fs 守卫改名**：`lib/fs/routes.js:1346` `.opencode/plans` → `.omp/plans`，同步改测试。
7. **设置键改名**：`lib/ompchamber/settings-helpers.js`（sanitize/format 白名单）、`omp-binary-resolution.js` 读 `ompBinary`，全 packages/web grep 三个旧键清零（契约见 §3.2）。
8. **移除 `OPENCODE_BINARY` fallback**：`omp-binary-resolution.js` 优先级变为 `OMP_BINARY` > settings `ompBinary` > `omp`；`packages/web/bin/` CLI 预检同步删除该变量解析/帮助文案，更新 `bin/lib/DOCUMENTATION.md`。

### UI（packages/ui）

9. **设置键改名**（与 §3.2 严格同名）：`lib/api/types.ts`（~:642,660-661）、`lib/desktop.ts`（~:59-60,158,161）、`lib/persistence.ts`（:171-179、:721-724、:1042 附近）、`stores/useUIStore.ts`（:2593 + persist 配置）、`components/sections/ompchamber/OmpCliSettings.tsx`、`components/update/OmpUpdateToast.tsx`、onboarding（`LocalSetupScreen.tsx:159`、`ChooserScreen.tsx:195`）及全部测试。zustand persist 旧值直接丢弃即可（业主已批准）。
10. **死 `opencode/` 分支前缀清理**：`components/session/sidebar/utils.tsx:122`、`components/views/GitView.tsx:594-601`。全仓 grep 确认无生产方后删除，保留周边逻辑，改测试。

### 端到端

11. **联调验证 command_output 全链路**：server 投影落地后，真实跑：UI 执行 `/session` 等内建命令 → 输出出现在聊天时间线。
12. **真实环境验证多会话**：两个以上会话存在于磁盘 → sidebar 列表正确 → 切换/resume → 删除非活跃会话消失、删除活跃会话按 §4.3 定义行为。

---

## 5. 验证与发布流程

### 验证命令（package.json 为准）

- **packages/web**：`cd packages/web && bun run test`（vitest。**严禁裸 `bun test`**——bun 运行器跨文件假定时器泄漏会挂起）。基线：1237 pass / 1 skip / 1 已知 load flake（`walkthrough/routes.test.js`，隔离重跑必过）。另有 33 个 adapter 集成测试跑真实 OMP 二进制。type-check：`bun run type-check`。
- **packages/ui**：type-check `bun run type-check`；测试用 `bun test <file>`（基线 1588 pass / 257 预存在失败与上游一致，**不得新增失败**）；lint `bun run lint`。
- **packages/vscode**：`bun test --isolate`（基线 101 pass / 0 fail）+ `bun run type-check`。
- **packages/electron**：`bun run test:architecture`（43/43）+ type-check + lint。
- **死代码**：源文件/导出变动后跑根目录 `bun run dead-code`（knip，非阻塞但要读报告）。
- **构建**：`cd packages/web && bun run build`、`cd packages/vscode && bun run build`（bundle 了 server.cjs，server 改动必须过这个）。
- **真实 OMP 实验**：二进制在 `packages/electron/resources/omp-cli/omp`（本机 bun 可用）。rpc-ui 会话实验范例见 `agent-runtime/omp/` 现有集成测试与 smoke-test.mjs。

### 提交流程（业主惯例）

- 提交必须带 pathspec；提交前 `[ -f .git/index.lock ] && rm .git/index.lock`。
- 不要运行任何 git/GitHub 写操作，除非业主明确要求（本流程已获授权的模式：提交 → push main → 打 tag → push tag 触发发布）。
- 建议按 server / UI / chore(version bump+changelog+docs) 分 2–3 个提交。

### 发布流程（v2.0.4）

1. `node scripts/bump-version.mjs 2.0.4`（同步 6 个 package.json）。
2. `CHANGELOG.md` 加 `[2.0.4]` 条目（风格参照 2.0.3：粗体 lead + 细节）。
3. `OMP_MIGRATION_MAP.md` 追加 Phase 8 补充或 Phase 9，记录本轮决策（特别是 revert 501 的取证结论、session 删除语义、无迁移改名）。
4. `git push origin main && git tag v2.0.4 && git push origin v2.0.4`。
5. 发布流水线自动跑（`.github/workflows/release.yml`，14 个 job：mac x64/arm64、win x64/arm64、linux x64/arm64、Android APK/AAB、npm tgz、VS Code vsix）。`gh run watch <id> -R realchendahuang/OMPChamber --exit-status` 监视。
6. 核验：`gh release view v2.0.4 -R realchendahuang/OMPChamber`（25 资产、非草稿）。v2.0.3 基线：mac dmg 269MB、win 228MB、linux x64 706MB / arm64 271MB——体积不应回涨。

---

## 6. 关键坑与约定

- **中断的半成品要先评审再续写**：server 的 session-store/session-manager 与 UI 的 event-reducer 改动质量良好但未经全量测试；`omp-adapter-http.js` 端子未接线是当前最大缺口。
- **测试禁令**：packages/web 下禁止裸 `bun test`（用 `bun run test` 即 vitest）。
- **AGENTS.md 铁律**：不加依赖；不记 secrets；最小完整改动；改契约更新 owning DOCUMENTATION.md；一个坏实体不得拖垮其他实体（session 列表解析必须容错）；fetch 失败不得伪装成权威空成功。
- **技能加载**：改代码前按根 AGENTS.md 表格加载对应项目 skill（server API→`ui-api-decoupling`、SSE→`relay-transport`、sync→`sync-state-invariants`、UI 文案→`locale-ui-patterns`、CLI→`clack-cli-patterns`）。
- **发布流水线已实现 secrets 自适应**：有 Apple/Android/NPM secrets 自动签名发布，没有则 mac 未签名、Android 自签名、iOS/npm 跳过——不要为此改 CI。
- **网络偶发**：本机 `gh` 偶发 x509 错误，重试即可。
- 业主沟通语言：中文。
