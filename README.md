# @kabxx/dsh-session-move

面向 DeepSeek Harness（`0.2.2-rc.5`）的会话跨工作区拖拽移动插件，支持 Linux（含 WSL）、macOS 与原生 Windows 的默认 Zstandard JSONL 存储。

- 在侧栏将普通会话直接拖到目标工作区的文件夹标题行（折叠或空工作区同样支持），原工作区内的上下排序不受影响。
- 连同关联的子智能体会话、日志目录与工作目录整组迁移：仅重写首帧会话头 `cwd` 并追加工作目录变更事件，同步更新工作区账本、侧栏列表与全文搜索索引；若日志已位于目标目录则仅补全工作区登记。
- 移动前自动释放空闲的 Web 会话句柄并通过原生会话锁（Linux / macOS `flock`、Windows 命名信号量）校验独占状态；运行中、存在未消费消息、归档或单独拖动的子智能体会话会被提前拦截，中途异常中断时由 `/recovery` 子插件在启动或下次操作时自动回滚或补完清理。

## 安装

需要 Node.js `>= 24.9.0`（Linux 环境需包含 `/usr/bin/flock`）：

```bash
dsh plugin --profile web add @kabxx/dsh-session-move
```

也可在 DSH 插件管理器中选择「添加插件」并输入 `@kabxx/dsh-session-move`（若使用其他配置档案，将 `--profile web` 替换为对应档案名）。本地调试源码时，直接填入克隆后的仓库目录绝对路径或执行 `dsh plugin --profile web add .` 即可。

## 开发

运行语法检查与测试（集成测试需将 `DSH_INSTALL_DIR` 与 `DSH_LEDGER_TEST_INSTALL` 指向本机 `@deepseek-ai/dsh` 安装目录）：

```bash
export DSH_INSTALL_DIR="$(npm root -g)/@deepseek-ai/dsh"
export DSH_LEDGER_TEST_INSTALL="$DSH_INSTALL_DIR"
npm run check
npm test
npm pack --dry-run
```

## 项目结构

| 路径 | 内容 |
| --- | --- |
| [`src/index.js`](src/index.js) | Host 入口，注册 `/api/session-move/session` 接口 |
| [`src/recovery.js`](src/recovery.js) | `/recovery` 子插件入口，负责启动时与按需的事务恢复及尾项清理 |
| [`src/move.js`](src/move.js) | 跨工作区移动主流程、空闲校验、事务提交与异常映射 |
| [`src/plan.js`](src/plan.js) | 移动前置校验、父子智能体会话组展开与目标路径检查 |
| [`src/transaction.js`](src/transaction.js) | 事务意图日志、整组备份暂存、原子目录切换与回滚 |
| [`src/zstd-frame.js`](src/zstd-frame.js) | Zstandard 会话容器帧扫描与首帧 `cwd` 原地重写 |
| [`src/ledger.js`](src/ledger.js) | 工作区 KV 账本原子切换、回滚与搜索索引刷新 |
| [`src/sidebar.js`](src/sidebar.js) | 迁移后刷新投影缓存与侧栏会话摘要事件 |
| [`src/lease.js`](src/lease.js) | 识别并安全释放空闲的 Web 会话写入句柄 |
| [`src/inbox.js`](src/inbox.js) | 重放校验会话持久收件箱是否存在未消费消息 |
| [`src/platform-fs.js`](src/platform-fs.js) | 跨平台会话锁（`flock` / Windows 信号量）、符号链接检查与原子替换 |
| [`src/paths.js`](src/paths.js) | 与原生 JSONL 存储一致的工作区目录编码计算 |
| [`src/config.js`](src/config.js) | 插件事务与历史版本恢复目录路径配置 |
| [`src/client.js`](src/client.js) | Web 侧栏文件夹行拖拽捕获、高亮反馈与 Toast 提示 |
| [`locale/`](locale/) | 主插件与 `/recovery` 子插件管理页中英文标题与描述 |
| [`test/`](test/) | 拖拽交互、Zstd 帧重写、账本切换与多阶段崩溃恢复测试 |

插件入口与注入配置见 [package.json](package.json) 和 [cordis.patch.yml](cordis.patch.yml)。
