# Brace Map Chat 数据库设计

## 目标与边界

学习数据由本地服务端的 SQLite 数据库持久化，浏览器不再作为正式数据源。默认数据库文件为 `.data/brace-map-chat.sqlite`，可以通过 `DATABASE_PATH` 修改位置。

当前产品是单用户本地应用，数据库只有一个逻辑工作区。模型请求配置仍由服务端管理，API Key 不会返回浏览器。未来增加账户时，为业务表补充 `owner_id` 和 `workspace_id`，再把同源校验升级为登录鉴权即可。

项目采用双层单实例保护：项目目录中的实例锁阻止第二个 Vite/Preview 服务从其他端口启动；服务端编辑租约只允许一个浏览器页面加载可写工作区。服务进程、页面或浏览器异常退出后，操作系统会关闭连接，编辑租约随即释放；遗留的进程锁会在确认原 PID 已不存在后自动回收。

## 表结构

| 表 | 保存内容 |
| --- | --- |
| `app_settings` | 当前画布、当前规划会话、当前模型配置、Agent 模型选择、示例快照版本和全局工作区版本 |
| `canvases` | 学习主题、目标、结果、学习方式、画布版本和排序 |
| `nodes` | 节点层级、坐标、标题、简介、笔记、状态、冻结上下文和结构化摘要 |
| `node_messages` | 普通节点的用户/AI 消息、顺序以及停止、未完整、失败状态 |
| `edges` | 画布中的父子连线与顺序 |
| `agent_planning_sessions` | 初始化规划会话、当前方案、待确认方案和采用关系 |
| `agent_planning_messages` | 初始化规划中的用户/Agent 消息 |
| `agent_sessions` | 全局学习树 Agent 的可恢复会话 |
| `agent_session_messages` | 全局 Agent 消息 |
| `agent_reviewed_operations` | Agent 提案、审核状态、画布版本和执行结果 |

大段正文仍按独立消息行存储；只有结构灵活且不需要单独查询的值使用 JSON，例如节点学习摘要、Agent 操作对象和规划方案。这样既保留关系约束，也避免为了低价值字段制造大量联结表。

## 写入规则

- 画布保存携带 `expectedVersion`；服务端在 `BEGIN IMMEDIATE` 事务中核对全局工作区版本，不一致时返回 `409 WORKSPACE_CONFLICT`，防止旧页面覆盖新数据。
- 正式服务启动前必须取得项目级实例锁；锁信息记录访问 URL、PID、启动时间和数据库路径，第二个端口不能绕过。
- 浏览器必须先保持 `GET /api/editor-lease` 长连接，才能读取和编辑工作区；第二页面返回 `423 EDITOR_LEASE_HELD`，不会加载旧工作区。
- 工作区只同步已删除或 `revision` 发生变化的画布；不同画布可以安全复用节点和消息 ID。
- 规划会话的普通保存按会话 ID 合并，旧页面请求中缺少的会话不会被静默删除；同一会话以 `updatedAt` 更新的一方为准。
- 删除规划会话必须调用单会话 `DELETE` 接口，服务端只删除指定会话并清理其当前选中状态。
- 前端对同一领域的保存请求按顺序排队，较早的慢请求不能覆盖较新的状态。
- 页面隐藏和 `pagehide` 可能连续发生；前端按变更版本去重同一份保存。只有不超过浏览器 keepalive 安全阈值的小请求才启用 keepalive，大工作区主要依靠隐藏事件提前发起普通保存。
- 所有进入数据库的画布、消息、树关系、Agent 操作和规划会话都会经过现有备份验证器；无效请求返回 `422`。
- SQLite 开启外键、WAL、`busy_timeout` 和 `synchronous=NORMAL`。
- schema 使用 `PRAGMA user_version` 执行单向版本迁移，当前版本为 2；v1 数据库启动时会在事务中迁移，并保留画布、消息、规划会话和 Agent 会话。
- `GET /api/ready` 会执行 SQLite `quick_check`，数据库异常时返回降级状态。

## 浏览器旧数据迁移

启动时先读取 SQLite，再检查旧版 `localStorage` 键。发现旧数据后：

1. 浏览器完整解析旧画布、全局 Agent 会话、规划会话和偏好；
2. 服务端再次校验，并按 ID 合并；画布版本更高或会话 `updatedAt` 更新的一方优先；
3. 服务端事务提交成功后返回最终状态；
4. 浏览器收到成功响应后才删除旧键。

迁移接口是幂等的。请求失败、服务端不可用或数据校验失败时，不会清除浏览器旧数据。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/storage/state` | 启动时读取完整应用状态 |
| `GET` | `/api/editor-lease` | 持有当前服务唯一的浏览器编辑租约；连接断开即释放 |
| `POST` | `/api/storage/migrate-browser` | 一次性合并旧浏览器数据 |
| `PUT` | `/api/storage/workspace` | 携带 `expectedVersion` 保存画布、节点、消息和布局；成功返回新版本 |
| `PUT` | `/api/storage/planning-sessions` | 保存初始化规划会话 |
| `DELETE` | `/api/storage/planning-sessions/:id` | 明确删除一份初始化规划会话 |
| `PUT` | `/api/storage/agent-runtime` | 保存全局 Agent 会话和模型选择 |
| `PUT` | `/api/storage/preferences` | 保存当前配置和快照版本 |
| `GET` | `/api/storage/export` | 从数据库导出学习数据备份 |
| `PUT` | `/api/storage/import` | 校验并事务替换学习数据 |

所有写接口保留同源校验。公开部署前必须增加身份认证、授权、CSRF 防护和每个账户的数据隔离。

## 备份与恢复

导出直接读取数据库中的已提交状态。导入先完整校验备份，包括 Agent 会话引用的画布，再在一个事务中替换画布、全局 Agent 会话和初始化规划会话；模型配置、API Key 和模型偏好不属于学习数据备份。导入成功也会推进工作区版本，使其他旧页面无法静默覆盖新数据。

SQLite 自身的文件级备份应同时复制主文件和 WAL，或在应用停止后复制 `.sqlite` 文件。日常跨版本迁移优先使用设置中的 JSON 学习数据备份。
