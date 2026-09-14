# Remote Access MCP

> **Дайте вашему AI-ассистенту реальный доступ к вашему компьютеру.**
>
> Подключите ChatGPT, Claude, Grok, Qwen Desktop и другие MCP-клиенты к ноутбуку, ПК, VM или серверу. Agent сможет читать файлы, изменять код, запускать тесты, проверять логи и выполнять многошаговые задачи в рамках выданных разрешений.

Remote Access MCP — безопасный gateway для доступа к реальной машине через [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

Вместо ответа “выполните эту команду” Agent может выполнить цикл:

**Наблюдение → Планирование → Изменение → Тест → Проверка → Отчёт**

## Возможности

В зависимости от разрешений Token Agent может:

- читать, создавать, изменять, удалять и искать файлы
- загружать и скачивать binary-файлы
- запускать тесты, сборку и контролируемые Shell-команды
- проверять процессы, диск, сеть, сервисы и логи
- работать с Git
- использовать SQLite, MySQL, PostgreSQL и Redis
- проверять HTTP endpoints и опциональный browser runtime
- запускать background jobs и ограниченные параллельные задачи
- использовать scheduler и webhook/event automation
- анализировать Docker/Kubernetes
- создавать Snapshot и выполнять Rollback рискованных изменений

## Платформы

Core Gateway поддерживает **Linux, macOS и Windows** с Node.js 18+.

```bash
npm install -g remote-access-mcp
ramcp init
ramcp tunnel
```

Для core runtime не нужны Python или Docker.

## Безопасность

Права задаются через Token и могут включать:

- разрешённые и запрещённые каталоги
- Tool Scopes
- роли `auditor`, `developer`, `deployer`, `admin`
- Shell и Command Allowlist
- Read-only режим
- Rate Limit
- срок действия Token

Также есть защита путей, SSRF protection, проверка Git-аргументов, ограничения SQLite, Audit Hash Chain, Snapshot/Rollback и изоляция плагинов.

**Цель — не дать AI бесконтрольную власть, а сделать его возможности явными, ограниченными, наблюдаемыми и отзывными.**

## Подключение AI-клиента

Для клиентов с Token в URL:

```text
https://your-host/<token>/mcp
```

Для клиентов с Authorization Header:

```text
https://your-host/mcp
Authorization: Bearer <token>
```

```bash
ramcp url
```

## Разработка

```bash
git clone https://github.com/AmirAliManzar/remote-access-mcp.git
cd remote-access-mcp
npm install
npm test
npm run build
```

- [English README](README.md)
- [فارسی](README.fa.md)
- [中文](README.zh-CN.md)
- [Türkçe](README.tr.md)
- [Security](SECURITY.md)
- [Roadmap](ROADMAP.md)

## License

MIT © Amir Ali Manzar
