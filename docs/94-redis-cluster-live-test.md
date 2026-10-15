# L-04 收口：Redis Cluster 实跑实测记录（2026-10-15）

> 遗留来源：[v0.2.0 发布验收报告](./archive/release/90-release-v0.2.0.md) 登记 L-04「Redis Cluster 实跑」——`@fw/cache` 的 redis-cluster 驱动此前只有单测与 fake 客户端覆盖，从未在真实集群上运行。
> 本次在真机（`106.55.32.251`，2C2G）以一次性容器拉起真实 6 节点集群实跑收口，**结论：通过**。

## 1. 集群环境（一次性，测后即删）

| 项 | 值 |
|---|---|
| 镜像 | `redis:8.10.2`（1Panel 既有镜像，未拉新） |
| 拓扑 | 6 节点单容器：7000/7001/7002 为 master，7003/7004/7005 为对应 replica（`--cluster-replicas 1`），bus 端口 17000–17005 |
| 网络约束 | 全部端口仅发布到宿主机 `127.0.0.1`；节点 `--cluster-announce-ip 127.0.0.1`（单容器内互访 + 宿主机客户端同走 loopback，无需 ioredis natMap） |
| 建群 | `redis-cli --cluster create ... --cluster-replicas 1`，`cluster_state:ok`、16384 槽全覆盖、6 节点互认 |
| 生命周期 | 容器 `fw-redis-cluster-test` 测试结束即 `docker rm -f`；生产 Redis（面板托管 6379）全程未触碰 |

## 2. 框架级实跑（`@fw/cache` redis-cluster 驱动，8/8 通过）

> 被测服务 = v0.4.0 真机产物 `dist/main.js`（端口 3900），`CACHE_DRIVER=redis-cluster` + `CACHE_URL=127.0.0.1:7000,7001,7002`（ioredis Cluster 按槽位自动分派/重定向）+ `CACHE_FAIL_OPEN=true`（**断言不降级**以证明连接真实建立）。

| 编号 | 断言 | 结果 |
|---|---|---|
| C1 | 服务以 redis-cluster 驱动启动成功 | ✅ |
| C2 | 真实读写，`driver=redis-cluster`（put-and-pick 往返） | ✅ |
| C3 | `/ready` 报告 `checks.cache=ok`（健康探针真实探活） | ✅ |
| C4 | 全程无降级日志（未触发 fail-open） | ✅ |
| C5 | `@Cacheable` 命中（第二次不回源，键落集群槽位） | ✅ |
| C6 | 标签失效（集合键与业务键可能异槽，跨节点删除后重新回源） | ✅ |
| C7 | 分布式锁（SET NX PX 互斥 + TTL 释放；比较删除 Lua 脚本在集群节点执行） | ✅ |
| C8 | 多键读写按槽位路由正常 | ✅ |

## 3. 边界与遗留

- **范围 = `@fw/cache`**（L-04 的登记口径）。`@fw/queue`（bullmq）/ `@fw/transport` 的 redis 段仍由 CI/真机单机 Redis 覆盖；bullmq 在 cluster 上的 hash-tag 语义（队列键族同槽）属独立验证面，登记后续（与队列驱动的多实例部署场景一并评估）。
- 集群为单容器多进程拓扑（省内存），与生产级「多容器各一节点」在**客户端语义上等价**（announce 127.0.0.1 时 MOVED/重定向地址同样可达）；重定向路径已由 C6/C8 跨槽操作覆盖。
- 实测期间生产服务 `/health` 恒 200，未受影响。

## 4. 结论

L-04 **收口**：`redis-cluster` 驱动在真实集群上的读写、命中、标签失效、分布式锁、降级判定全部符合 PRD-004 语义。框架「切换只改 .env」的承诺在 cluster 形态成立（本实测仅改 `CACHE_DRIVER`/`CACHE_URL`，零代码改动）。
