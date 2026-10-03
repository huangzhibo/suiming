# packages/cloud-postgres：Cloud 的 PostgreSQL 存储

Cloud 目前冻结，只保存 Canon 与同步（[系统架构](../../docs/architecture.md)第 9 节）；已有 adapter 随共享契约修正，不借此扩张。全仓通用的约定见根目录的 [AGENTS.md](../../AGENTS.md)。

- **本包与 `apps/api` 的集成测试默认 skip，改 Cloud schema 后要真跑一遍**：起一次性容器（`docker run --rm -e POSTGRES_PASSWORD=... -p 127.0.0.1:54329:5432 postgres:18.6-alpine`），设 `SUIMING_TEST_POSTGRES_URL` 跑 `packages/cloud-postgres/test/migrator.test.ts`，跑完停掉容器。2026-09-14 这么做才发现 `migrator.test.ts` 从 2026-09-13 的 `004_drop_execution` 起就在断言早已删除的 `tasks` / `task_leases` / `run_events`——skip 掉的测试不会告诉你它坏了。
