# Remote Access MCP

> **让你的 AI 助手真正访问你的电脑。**
>
> 将 ChatGPT、Claude、Grok、Qwen Desktop 等支持 MCP 的客户端连接到你的笔记本、台式机、虚拟机或服务器，让 Agent 真正读取文件、修改代码、运行测试、检查日志并完成多步骤任务。

Remote Access MCP 是一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的安全机器访问网关。

AI 不再只能告诉你“应该运行什么命令”，而可以在你授权的范围内执行完整工作流：

**观察 → 计划 → 修改 → 测试 → 验证 → 汇报**

## 能做什么？

根据 Token 权限，Agent 可以：

- 阅读、创建、修改、删除和搜索文件
- 上传/下载二进制文件
- 运行测试、构建、脚本和受控 Shell 命令
- 检查进程、磁盘、网络、服务和日志
- 操作 Git 仓库
- 使用 SQLite、MySQL、PostgreSQL、Redis
- 检查 HTTP Endpoint 和可选 Browser 环境
- 并行执行任务和后台 Job
- 创建定时任务和 Webhook/Event 自动化
- 检查 Docker/Kubernetes 等基础设施
- 创建 Snapshot 并回滚风险文件修改
- 使用可选的 Context7、Codebase Memory 等集成

## 跨平台

核心 Gateway 支持 **Linux、macOS、Windows**，Node.js 18+。

```bash
npm install -g remote-access-mcp
ramcp init
ramcp tunnel
```

不需要 Python，也不需要 Docker 才能运行核心 Gateway。

## 安全

权限以 Token 为中心，可以限制：

- 允许/拒绝的目录
- Tool Scopes
- `auditor` / `developer` / `deployer` / `admin` Role
- Shell 和 Command Allowlist
- Read-only 模式
- Rate Limit
- Token 过期时间

同时提供路径安全检查、SSRF 防护、Git 参数验证、SQLite 限制、Audit Hash Chain、Snapshot/Rollback 和插件隔离等机制。

**AI 的能力应该是明确、受限、可观察、可撤销的。**

## 连接 AI 客户端

支持 URL Token 的客户端：

```text
https://your-host/<token>/mcp
```

支持 Authorization Header 的客户端：

```text
https://your-host/mcp
Authorization: Bearer <token>
```

```bash
ramcp url
```

## 开发

```bash
git clone https://github.com/AmirAliManzar/remote-access-mcp.git
cd remote-access-mcp
npm install
npm test
npm run build
```

- [English README](README.md)
- [فارسی](README.fa.md)
- [Security](SECURITY.md)
- [Roadmap](ROADMAP.md)

## License

MIT © Amir Ali Manzar
