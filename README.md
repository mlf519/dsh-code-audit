# dsh-code-audit

DeepSeek Harness（DSH）代码审计插件：用任务化的方式管理代码审计，可按所选漏洞提示词或审计 Skill 驱动 DSH 原生 Agent 会话进行审计，沉淀漏洞、进度与运行轨迹，并导出可直接交付的专业审计报告。

当前版本：**0.4.2** ｜ 兼容 DSH `>=0.1.1-rc.2 <0.3.0`（含 0.2.x）

## 功能特性

### 审计任务

- 新建、修改、删除、启用 / 暂停审计任务，指定代码目录、任务说明与审计范围。
- **两种审计模式**：`按漏洞提示词` 只审计勾选的漏洞类型；`按审计 Skill` 完全按照所选 Skill 的规定执行。两种模式都支持漏洞管理、运行记录与报告导出。
- **弹窗式目录选择**：支持盘符 / 根目录、上一级、面包屑与路径输入，逐层预览后再确认，避免手输路径出错。
- **模型与客户端同步**：任务可直接选择 DSH 已配置的模型服务商与模型；未选择时按「任务设置 → 插件默认 → DSH 默认模型」顺序回退。
- **调度方式**：手动、定时一次、5 字段 Cron、固定间隔。
- **实时进度**：运行中显示百分比、当前审计类型、已完成类型数、步骤数、工具调用次数、已发现漏洞数与已运行时长；失败时直接展示错误原因。
- **中途导出**：审计进行中也可导出报告，已完成的发现正常输出，尚未审计的类型以空章节保留。

### 漏洞管理

- 漏洞列表支持按任务、状态、严重级别与关键词筛选。
- 详情弹窗展示位置、分类、描述、触发路径 / 数据流、证据代码、**PoC 请求包 / 复现示例** 与修复建议。
- 支持标记为已确认、已忽略、误报、重新打开，并填写处理备注；Agent 工具还支持标记为已修复。
- 支持删除漏洞记录。

### 审计提示词

- 内置 14 类常见漏洞审计提示词，覆盖注入、文件、认证、反序列化、网络、配置、加密、业务逻辑与依赖风险。
- 支持新建、修改、启用 / 禁用、删除提示词；禁用后不会出现在新建 / 修改任务的可选列表中。删除内置提示词后，插件重启会重新生成内置模板。
- 支持导出 / 导入 YAML（兼容 JSON）备份，按名称合并。

内置提示词一览：

| 分类 | 提示词 |
| --- | --- |
| 注入 | SQL 注入、跨站脚本 XSS、命令注入与代码执行、模板注入与表达式注入 |
| 文件 | 路径穿越与任意文件读写、文件上传与 XXE |
| 认证与业务 | 认证与会话缺陷、竞态与业务逻辑 |
| 网络与配置 | 服务端请求伪造 SSRF、硬编码凭据与敏感信息泄露、日志 / 异常与信息泄露 |
| 其他 | 不安全的反序列化、加密与随机数缺陷、依赖与供应链风险 |

### 审计 Skill

- Skill 直接采用标准 `SKILL.md` 格式：YAML frontmatter（`name`、`description`、`tools`、`file_patterns` 等）+ Markdown 正文，参考文件放在 `references/` 目录，与 [CodeAuditSkill](https://github.com/zhiyuwang720-dev/CodeAuditSkill/) 等仓库的 Skill 结构一致。
- 支持新建、修改、启用 / 禁用、删除审计 Skill；禁用后不会出现在新建 / 修改任务的可选列表中，已引用该 Skill 的任务编辑时需重新选择。编辑器内直接编辑 `SKILL.md`，并可增删 `references/` 参考文件。
- 保存或导入后会自动镜像到用户级 DSH Skill 目录 `~/.dsh/skills/<name>/`（`SKILL.md` + `references/`）：DSH 会把 `name` 注册为可自动调用的 Skill，并支持在任意会话输入 `/name` 直接加载，例如 `/web-vuln-audit`。停用、删除或改名时会同步清理旧目录。
- 镜像只覆盖本插件创建的目录（通过 `.dsh-code-audit.json` 标记识别）；与已有同名第三方 Skill 冲突时不会覆盖。名称需为 kebab-case（如 `web-vuln-audit`），否则仅保留在插件内。
- `/audit skills` 可列出插件内的审计 Skill 及其对应的会话调用命令。
- 导入支持：单个 `SKILL.md`、整个 Skill 目录（含 `references/`）、ZIP 包，以及旧版 YAML / JSON 备份；导入按 `name` 合并。
- 导出支持：单个 Skill 导出为 `SKILL.md + references/` 的 ZIP；也可一键导出全部 Skill 为多目录 ZIP；仍保留旧版 YAML 备份导出。
- 审计时优先走 DSH 原生 Skill 调用：审计提示词以 `/skill-name` 开头，由 DSH 加载 `SKILL.md` 正文、Agent 按需读取 `references/` 下的文件；仅当该 Skill 未镜像成功（名称非法或与第三方 Skill 同名冲突）时，才回退为正文 + 全部参考文件内联。
- Skill 模式的审计要求以 Skill 为唯一权威：审计范围、步骤、判定标准、报告格式与产出位置全部按 Skill 执行；插件不额外识别或指定报告格式，只附加进度上报、漏洞记录与标准报告导出，不改变或削弱 Skill 要求。Skill 要求写入文件（如 `reports/`）时按 Skill 执行，这是只读约束的唯一例外。
- 任务引用的 Skill 被删除后，任务会明确提示重新选择，不会静默回退。

### 专业审计报告

- 支持 Markdown、HTML、JSON 三种格式，可在「审计任务」行点击「报告」导出，或通过 `/audit report` 与 Agent 工具导出；选中格式后弹窗自动关闭。两种审计模式都统一导出标准审计报告。
- **Markdown**：报告编号、报告信息表、执行摘要、风险分布、重点漏洞、审计范围与方法、审计覆盖、VULN 编号漏洞详情、未发现问题类型、运行历史、运行总结与免责声明。
- **HTML**：深色渐变封面、报告编号与元信息、统计磁贴、目录、严重级别分组卡片、深色 PoC 代码块、打印样式与响应式布局，适合直接交付或归档。
- **JSON**：包含报告元信息、任务、运行记录、漏洞与覆盖明细，便于二次处理。
- **PoC 请求包**：审计 Agent 对可利用漏洞会提交原始 HTTP 请求（请求行、Host、关键 Header、Body）与一条可直接执行的 `curl` 命令，报告中以代码块展示；无法通过 HTTP 触发的漏洞会说明复现步骤，不会伪造请求。

### 运行记录与会话

- 每次运行生成独立 Agent 会话，并将 DSH 原生 trajectory 事件以 JSONL 落盘，可在「运行记录」下载或删除（运行中的记录不可删除）。
- **审计会话保留**：任务结束后不再销毁会话，对话会留在客户端左侧会话列表，并按「任务名 · MM-DD HH:mm」自动重命名，便于回看与续聊。
- 默认最多保留 50 个已结束会话（`maxRetainedSessions` 可调），超出后释放最旧的会话句柄；会话日志本身仍由 DSH 持久化管理。

### 客户端体验

- 安装后在左侧导航栏出现「代码审计」入口，点击即在右侧主内容区打开控制台（与「技能中心」相同的面板机制）。
- 页面背景与配色跟随系统深浅色。
- 任务与漏洞操作按钮保持单行展示，任务列表不显示内部任务 ID。

## 安装

```bash
# 本地开发目录（桌面客户端）
dsh plugin --profile desktop add <本仓库绝对路径>

# Web profile
dsh plugin --profile web add <本仓库绝对路径>

# npm 包
dsh plugin --profile web add dsh-code-audit

# GitHub 源码
dsh plugin --profile web add github:mlf519/dsh-code-audit
```

安装后重新加载 DSH 配置并**重启客户端**，左侧导航栏会出现「代码审计」入口。

也可直接访问 Web 控制台：

```text
http://127.0.0.1:<DSH 端口>/dsh-code-audit/
```

## 使用教程

### 1. 准备审计提示词

打开「审计提示词」，确认本次要审计的漏洞类型已启用。可按项目实际情况修改提示词内容（审计目标、检查清单、判定标准、误报排除、严重级别建议）。

### 2. 新建审计任务

在「审计任务」中点击「新建任务」：

1. 填写任务名称与任务说明（例如关注的模块、业务背景）。
2. 先选择审计方式：
   - **按提示词**：勾选本次要启用的漏洞提示词；列表只显示已启用的类型，未勾选的类型不会审计。
   - **按审计 Skill**：选择已在「审计 Skill」页创建 / 导入并启用的 Skill，任务将完全按该 Skill 的 `SKILL.md` 与参考文件执行。
3. 点击「选择目录」，在弹窗中逐层预览并选择代码目录。
4. 按需选择模型服务商与模型；留空则使用插件默认或 DSH 默认模型。
5. 选择调度方式：
   - 手动：仅点击运行时执行；
   - 定时一次：指定执行时间；
   - Cron：填写 5 字段表达式，例如 `0 2 * * *`；
   - 固定间隔：按分钟周期执行。
6. 保存任务。

### 2.1 导入现成的审计 Skill

在「审计 Skill」页点击「导入 Skill」，可以：

- 选择整个 Skill 目录（包含 `SKILL.md` 与 `references/`）；
- 选择 `SKILL.md` 或 ZIP 包；
- 选择旧版 YAML / JSON 备份；
- 直接粘贴 `SKILL.md` 内容。

导入按 frontmatter 的 `name` 合并：同名 Skill 更新内容，新名称则创建。

### 3. 运行任务并查看进度

在任务行点击「运行」。插件会创建一个独立 Agent 会话，以代码目录为 cwd，并注入所选提示词与上报规范。

运行期间任务行会显示进度条与阶段信息，包括当前审计类型、类型完成数、步骤数、工具调用次数、已发现漏洞数与已运行时长。模型回复超时或失败时，会按「设置」中的间隔自动发送「继续」并从中断处续跑，达到续跑次数上限后才结束并显示错误原因。

### 4. 复核漏洞

审计发现会实时进入「漏洞管理」。点击「详情」查看：

- 漏洞位置、分类、描述与触发路径；
- 证据代码；
- PoC 请求包 / 复现示例（如模型已提交）；
- 修复建议。

确认后标记为「验证通过」，误报标记为「误报」，暂不处理可「忽略」，并可在处理备注中记录验证结论。

### 5. 导出报告

在任务行点击「报告」，选择 Markdown / HTML / JSON 导出。审计中途也可导出，报告只包含当前已完成的部分，未审计类型显示为空章节。

报告同时归档到 `${DSH_HOME}/storages/code-audit/reports/`。历史漏洞如果没有 PoC，报告会给出说明；重新运行审计后，新发现的漏洞才会带上 PoC 请求包。

### 6. 查看运行记录与会话

- 「运行记录」可查看每次运行的状态、触发方式、耗时、漏洞数与进度，并可下载 trajectory JSONL 或删除记录。
- 任务结束后，对应会话会保留在客户端左侧会话列表，标题为「任务名 · 时间」，可直接打开回看审计过程。

## 斜杠命令

```text
/audit list                          列出任务
/audit skills                        列出审计 Skill 及可用的 /名称 调用
/audit prompts                       列出审计提示词
/audit run <任务ID>                  立即运行任务
/audit report <任务ID> [格式]        导出报告（markdown|html|json）
/web-vuln-audit                      直接加载已同步的审计 Skill（任意会话可用）
```

## Agent 工具

| 工具 | 用途 |
| --- | --- |
| `code_audit_list_tasks` | 列出审计任务 |
| `code_audit_create_task` | 新建审计任务（含调度） |
| `code_audit_run_task` | 立即运行任务 |
| `code_audit_list_prompts` | 列出审计提示词 |
| `code_audit_list_skills` | 列出审计 Skill |
| `code_audit_report_progress` | 上报审计进度（开始 / 完成某个漏洞类型或 Skill） |
| `code_audit_submit_finding` | 上报漏洞，支持 `poc_request` 提交 PoC 请求包 |
| `code_audit_submit_summary` | 提交运行总结 |
| `code_audit_submit_skill_report` | 提交 Skill 生成的 Markdown 报告（可选，用于归档） |
| `code_audit_update_finding` | 更新漏洞处理状态 |
| `code_audit_export_report` | 导出报告文件（默认为标准审计报告，也支持已归档的 Skill 报告） |

## 调度说明

| 类型 | 说明 |
| --- | --- |
| `manual` | 仅手动触发 |
| `once` | 在指定时间执行一次，执行后任务完成 |
| `cron` | 5 字段 Cron（分 时 日 月 周），例如 `0 2 * * *` |
| `interval` | 按固定分钟间隔循环执行 |

调度器默认每 30 秒检查一次到期任务；任务运行中不会被重复调度。

## 存储方案

以插件独立 SQLite 为唯一事实来源，辅以 DSH 原生轨迹与可移植的提示词备份：

```text
${DSH_HOME}/storages/code-audit/
├── code-audit.db                 # SQLite：tasks / runs / findings / prompts / skills / settings
├── trajectories/<runId>.jsonl    # 每次运行的原生 session 事件流（NDJSON）
└── reports/                      # 导出的报告归档
```

- `DSH_HOME` 默认是 `~/.dsh`，也可通过插件配置 `dataDir` 覆盖。
- SQLite 使用 WAL 模式，插件卸载时自动关闭。
- 漏洞记录包含 PoC 字段；旧数据库在升级后会自动补充该列，无需手工迁移。
- 审计 Skill 以完整 `SKILL.md` + `references` 文件内容 + frontmatter 元数据的形式存储在 SQLite 中，导出时再组装为标准目录 / ZIP。
- 提示词与 Skill 的旧版备份均为 YAML（也接受 JSON），按名称合并导入。
- DSH 自身的会话持久化文件仍由 DSH 管理；插件的 JSONL 是面向审计运行的独立轨迹副本，可直接下载分析。

## 配置

可在 profile 的 `cordis.patch.yml` 中覆盖插件配置：

```yaml
- id: code-audit
  config:
    dataDir: !!js dshHomePath('storages', 'code-audit')
    maxConcurrentRuns: 2          # 默认 1
    runTimeoutMinutes: 60         # 0 表示不限制
    llmRetryDelayMinutes: 5       # 模型回复失败后自动续跑间隔（0–1440）
    llmRetryCount: 3              # 自动续跑次数上限
    maxRetainedSessions: 50       # 结束后保留的审计会话上限
    defaultProvider: deepseek     # 留空使用 DSH 默认模型
    defaultModel: deepseek-chat
    autoStartScheduler: true
    schedulerIntervalMs: 30000
```

控制台「设置」页可修改最大并发数、单次超时、模型回复失败后的自动续跑间隔（0–1440 分钟）、自动续跑次数与默认模型，修改持久化在 SQLite 的 `settings` 表。

## 安全说明

- 审计 Agent 被明确要求只读浏览代码，但插件不会在沙箱层强制只读；请在 DSH 中使用合适的工具审批与沙箱策略。
- 报告中的 PoC 请求包仅用于授权范围内的安全验证，请勿对未授权系统使用。
- Web 控制台无额外认证，依赖 DSH webServer 仅监听本机地址。请勿将 DSH 端口直接暴露到公网。
- 插件下发的审计提示词与模型上报的漏洞内容均可能包含敏感代码片段，请妥善保护 `${DSH_HOME}/storages/code-audit/`。

## 开发

- 纯 ESM，无第三方运行时依赖，使用 Node 内置 `node:sqlite`。
- 入口：[src/index.js](./src/index.js)；存储：[src/store.js](./src/store.js)；运行器：[src/runner.js](./src/runner.js)；报告：[src/report.js](./src/report.js)；控制台资源在 `src/web/`。
- 基本自检：

```bash
node --check src/index.js
node --check src/runner.js
node --check src/store.js
node --check src/report.js
node -e "import('./src/store.js').then(m => { const s = new m.AuditStore('./.tmp-data'); console.log('prompts:', s.listPrompts().length); s.close() })"
node -e "import('./src/yaml.js').then(m => { const text = m.stringifyPromptsDocument([{ name: 'x', content: 'a\nb' }]); console.log(m.parsePromptsDocument(text)[0]) })"
```

## License

MIT
