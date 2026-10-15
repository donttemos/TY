<!--
@file fw-app Helm Chart 使用说明（T-M8-07 / PRD-008 FR-09）
@description Chart 目录结构、安装/升级/回滚流程、关键 values 说明、探针与迁移 Job 语义、
  以及本机无 helm 时的离线校验方式；§7 为集群最低规格结论（L-01 暂缓期间的规划输入）。
@author donttemo
@created 2026-10-14
@modified 2026-10-15 donttemo L-01 暂缓决策落档：新增 §7 集群最低规格与形态结论（1 台冒烟 / 2 台最小生产 / 3 台 HA）
-->

# fw-app Helm Chart

通用应用框架（`@fw`）的标准应用 Chart：NestJS 11 后端 + 可选队列 Worker + 可选管理后台静态站点。
对应 [部署与运维手册 §6 大档部署](../../../docs/60-deployment-ops.md)。

## 1. 目录结构

```
deploy/helm/fw-app/
├─ Chart.yaml              # 元信息（apiVersion v2 / version / appVersion / kubeVersion）
├─ values.yaml             # 默认值（小档可跑）
├─ values-prod.yaml        # 生产覆盖示例（HPA + PDB + worker + admin-web + ingress）
├─ templates/
│  ├─ _helpers.tpl         # 命名与标签模板
│  ├─ configmap.yaml       # 非敏感配置（values.config）
│  ├─ secret.yaml          # 敏感配置（仅逐键注入时渲染；生产走 existingSecret）
│  ├─ deployment.yaml      # API Deployment（三档探针 / 滚动更新 / 安全上下文）
│  ├─ service.yaml         # API Service
│  ├─ hpa.yaml             # HorizontalPodAutoscaler（autoscaling.enabled 时）
│  ├─ pdb.yaml             # PodDisruptionBudget
│  ├─ ingress.yaml         # Ingress（ingress.enabled 时）
│  ├─ serviceaccount.yaml  # ServiceAccount（serviceAccount.create 时）
│  ├─ networkpolicy.yaml   # NetworkPolicy（networkpolicy.enabled 时）
│  ├─ migrate-job.yaml     # 迁移 Job（helm.sh/hook: pre-install,pre-upgrade）
│  ├─ worker-deployment.yaml # 队列 Worker（worker.enabled 时）
│  ├─ admin-web.yaml       # 管理后台 Deployment + Service（adminWeb.enabled 时）
│  └─ NOTES.txt            # 安装后提示
└─ README.md               # 本文件
```

## 2. 安装与升级

```bash
# 安装（生产：密钥经外部 Secret 注入）
helm upgrade --install myapp ./deploy/helm/fw-app \
  -f ./deploy/helm/fw-app/values-prod.yaml \
  --set image.tag=0.1.0 \
  --set secrets.existingSecret=fw-prod-secrets \
  --namespace fw --create-namespace --wait

# 查看渲染结果（不提交到集群）
helm template myapp ./deploy/helm/fw-app -f ./deploy/helm/fw-app/values-prod.yaml

# 校验 Chart
helm lint ./deploy/helm/fw-app
helm template myapp ./deploy/helm/fw-app | kubectl apply --dry-run=server -f -

# 回滚
helm rollback myapp 1 -n fw
```

## 3. 关键 values

| 键 | 默认 | 说明 |
|---|---|---|
| `replicaCount` | 3 | `autoscaling.enabled=true` 时由 HPA 接管，Deployment 不再设 replicas |
| `strategy.rollingUpdate.maxUnavailable` / `maxSurge` | 0 / 1 | 滚动更新零不可用 |
| `probes.readiness.path` / `liveness.path` | `/ready` / `/health` | **不可混用**：readiness 反映依赖就绪，liveness 只反映进程存活 |
| `app.terminationGracePeriodSeconds` | 45 | 必须 > `MQ_SHUTDOWN_TIMEOUT` 与 `TRANSPORT_SHUTDOWN_TIMEOUT` |
| `resources` | 250m/512Mi → 1C/1Gi | requests 与 limits 必填（避免节点争抢） |
| `autoscaling.*` | 3~12 / CPU 60% | 含缩容稳定窗 300s 与伸缩策略 |
| `podDisruptionBudget.minAvailable` | 2 | 驱逐/缩容期间可用副本下限 |
| `config.*` | 见 `values.yaml` | 进 ConfigMap（**非敏感**）；变更经 `checksum/config` 触发滚动 |
| `configUrls.*` | 空 | 非敏感连接串（无密码场景）；`configInValues=true` 时才进 ConfigMap |
| `secrets.existingSecret` | 空 | **生产必填**；非空时不再渲染 Secret 模板 |
| `migrateJob.enabled` | true | 迁移以 pre-upgrade 钩子执行，失败即阻断发布 |
| `worker.enabled` | false | 队列消费者（同镜像、`TRANSPORT_ROLE=handler`），副本独立伸缩 |
| `adminWeb.enabled` | false | 管理后台静态站点（Nginx 镜像托管 `dist/`） |
| `ingress.enabled` | false | 入口；TLS 由 cert-manager / 云 LB 负责 |

## 4. 语义要点

**探针三档**：`startupProbe`（慢启动保护，默认 20×3s）→ `readinessProbe`（`/ready`，依赖就绪）→ `livenessProbe`（`/health`，进程存活）。readiness 失败只摘流量不重启；liveness 失败才重启进程。

**迁移 Job**：以 `helm.sh/hook: pre-install,pre-upgrade` 执行 `pnpm db:migrate`，`hook-delete-policy: before-hook-creation` 保证每次发布新建。迁移锁由应用侧保证单实例执行。

**配置变更**：`values.config` 变更 → ConfigMap 内容变化 → Pod 模板 `checksum/config` 注解变化 → 触发滚动更新（无需手工重启）。

**密钥**：默认**不渲染** Secret 对象；容器经 `secretRef` 取用。生产用 `secrets.existingSecret` 指向外部管理（External Secrets Operator / CSI / 手工创建）。

**Worker 与 API 分离**：两者同镜像不同角色（`TRANSPORT_ROLE`），选择器按 `app.kubernetes.io/component` 区分，避免抢流量；cron 单点执行依赖 `CACHE_DRIVER=redis` 的分布式锁。

## 5. 离线校验（无 helm / kubectl 环境）

本机或 CI 没有 helm 时，用仓库脚本做等价门禁：

```bash
node scripts/check-helm-chart.mjs
```

该脚本实现 Helm 模板子集渲染（`include` / `if` / `range` / `with` / 内置函数），对 `values.yaml`、`values-prod.yaml`、最小档三套渲染结果做 **K8s 清单语义断言**（探针路径、`maxUnavailable=0`、`resources` 齐备、非 root、HPA/PDB 参数、Secret 不落明文、迁移 Job 钩子、组件开关生效），共 63 项。**它是离线兜底，不替代真实集群的 `helm install` + `kubectl rollout` 冒烟**（见 `docs/archive/m8/96-m8-drills.md` L-01）。

## 6. 安装后自检

```bash
kubectl rollout status deploy/myapp-fw-app-api -n fw --timeout=180s
kubectl port-forward svc/myapp-fw-app-api 3000:80 -n fw
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/ready
curl -fsS http://127.0.0.1:3000/metrics | grep -E 'cache_hit|fw_queue_'
kubectl get hpa,pdb -n fw
kubectl get jobs -l app.kubernetes.io/component=migrate -n fw
```

## 7. 集群最低规格与形态结论（2026-10-15，L-01 暂缓期间的规划输入）

> 状态：真实 K8s 集群部署冒烟（遗留 L-01）**暂缓**——当前无可用集群环境。本节把选型决策所需的服务器规格结论先行落档，待有环境时按此直接开测。

### 7.1 K8s 本身的底线

| 形态 | 节点数 | 说明 |
|---|---|---|
| 冒烟 / 验证（k3s 单节点） | **1 台** | 控制面 + 工作负载混布，Chart 可装可跑，无高可用；**L-01 冒烟用此形态即可**（建议 4C8G） |
| 最小可用生产 | 2 台 | 1 控制面 + 1 工作节点；控制面仍单点 |
| 最小高可用 | **3 台起** | etcd 仲裁要求奇数票（1 或 3），3 台起才能容忍 1 台故障——生产 HA 的事实最低线 |

### 7.2 本 Chart 的资源账（默认 values）

默认副本：**app ×3（`replicaCount: 3`）+ worker ×2 + admin-web ×2 = 7 个 Pod**；
PG / Redis 走**外置地址**（values `database` / `cache` 为 host URL，不占集群节点）——「几台服务器」只需算 K8s 节点 + 外置中间件宿主。

| 目标 | 建议 | values 调整 |
|---|---|---|
| 关闭 L-01（验证 Chart 在真集群可装：探针 / HPA / PDB / 迁移 Job 语义） | 1 台 4C8G k3s | 精简档：app×1 / worker×1 / adminWeb×1，`autoscaling.enabled=false` |
| 小规模生产 | 2 台 4C8G worker | app×2 / worker×1 / adminWeb×1，中间件沿用现有外置实例 |
| 认真上 HA | 3 台起（或 3 worker + 独立控制面） | 默认 values + `values-prod.yaml`（HPA + PDB） |

### 7.3 暂缓期间的替代保障

无集群不等于无门禁：`pnpm check:helm`（离线渲染 + 清单语义断言 63/63）持续在 CI 生效；上生产前仍须在目标集群补 `helm template` + `--dry-run=server` + 灰度发布验证（见 [60 手册 §6](../../../docs/60-deployment-ops.md)）。
