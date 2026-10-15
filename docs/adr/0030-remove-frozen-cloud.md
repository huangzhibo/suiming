# ADR-0030：删除冻结的 Cloud 实现

- 状态：Accepted
- 日期：2026-10-15

## 背景

作者决定删除旧 Cloud，实现投入继续集中于本地桌面创作。此前的「冻结但维护 adapter」让独立的 CloudProjectStore、HTTP 协议、成员角色和同步机制继续牵制已收敛到 git CanonStore 的本地核心；旧实现的测试不能证明它符合当前核心契约。本决策取代 ADR-0008 及现行文档中保留 Cloud adapter 的要求。

## 决策

删除 Cloud API、PostgreSQL / S3 adapter、Runtime Cloud / sync、HTTP 专属 SDK、CLI cloud 命令及其配置读取、绑定接口、专属测试和依赖。不留空壳包、占位接口或另一份归档源码；历史由 Git 保存。

保留 Story Language、Checker、git Canon、Session / Task、桌面与 CLI 的共享 Runtime、host integrations、Open Story Directory / Package 的本地导入导出。现有端口只按本地真实调用保留，不为未来 Cloud 预建结构。未来 Cloud 以当时核心与产品需求重新设计部署、存储和同步；不预先指定 PostgreSQL 或 S3，也不重写领域规则和 Agent。

## 数据边界

只删除仓库实现，不操作用户作品或外部服务数据。旧 SQLite 中的 remote_bindings 表不再创建或访问，已存在的表不主动删除；不重建数据库、不修改 schema 版本来清空执行数据。旧配置的 cloud 顶层段被忽略，不影响模型配置，不重写用户配置。执行对象的内容寻址算法与已持久化 ID 保持不变。

完整目录冷备份继续保留作品、未提交候选、.git 中的 Canon 历史以及 .suiming 中的对话、任务、事件和执行对象。Open Story Package 仍只携带作品快照，不能替代完整备份。

## 验收

先补旧配置、旧数据库兼容回归，再删除实现。复验本地提交、历史回退、完整冷备份迁移与原对话续跑、CLI 和真实 Electron 桌面闭环。失去产品对象的 Cloud 测试随实现删除，不把测试数量下降或 skip 消失描述为覆盖率提升。记录测试证据与未验证边界。
