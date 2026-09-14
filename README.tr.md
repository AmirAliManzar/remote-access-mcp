# Remote Access MCP

> **Yapay zekâ asistanınıza bilgisayarınıza gerçek erişim verin.**
>
> ChatGPT, Claude, Grok, Qwen Desktop ve diğer MCP uyumlu istemcileri dizüstü bilgisayarınıza, masaüstünüze, VM'inize veya sunucunuza bağlayın. Agent; dosya okuyabilir, kod değiştirebilir, test çalıştırabilir, log inceleyebilir ve çok adımlı işleri tamamlayabilir.

Remote Access MCP, [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) tabanlı güvenli bir makine erişim gateway'idir.

AI yalnızca “şu komutu çalıştır” demek yerine, verdiğiniz yetkiler dahilinde gerçek bir iş döngüsü gerçekleştirebilir:

**Gözlemle → Planla → Değiştir → Test Et → Doğrula → Raporla**

## Neler yapabilir?

Token izinlerine bağlı olarak Agent:

- dosyaları okuyabilir, oluşturabilir, düzenleyebilir, silebilir ve arayabilir
- binary dosya yükleyebilir/indirebilir
- test, build, lint ve kontrollü Shell komutları çalıştırabilir
- process, disk, network, service ve logları inceleyebilir
- Git repository'leriyle çalışabilir
- SQLite, MySQL, PostgreSQL ve Redis sorgulayabilir
- HTTP endpoint'leri ve isteğe bağlı browser ortamını inceleyebilir
- background job ve sınırlı paralel görevler çalıştırabilir
- scheduler ve webhook/event otomasyonları kullanabilir
- Docker/Kubernetes altyapısını inceleyebilir
- Snapshot alıp riskli dosya değişikliklerini geri alabilir

## Platformlar

Çekirdek Gateway **Linux, macOS ve Windows** üzerinde Node.js 18+ ile çalışır.

```bash
npm install -g remote-access-mcp
ramcp init
ramcp tunnel
```

Çekirdek çalışma için Python veya Docker gerekmez.

## Güvenlik

Token bazlı yetkilendirme ile şunları sınırlandırabilirsiniz:

- izin verilen/reddedilen dizinler
- Tool Scopes
- `auditor`, `developer`, `deployer`, `admin` rolleri
- Shell ve Command Allowlist
- Read-only modu
- Rate Limit
- Token expiration

Ayrıca path güvenliği, SSRF koruması, Git argüman doğrulaması, SQLite kısıtlamaları, audit hash chain, snapshot/rollback ve plugin isolation gibi katmanlar bulunur.

**Amaç AI'ya sınırsız güç vermek değil; yeteneklerini açık, sınırlı, gözlemlenebilir ve iptal edilebilir hale getirmektir.**

## AI istemcisini bağlama

URL üzerinden Token kabul eden istemciler:

```text
https://your-host/<token>/mcp
```

Authorization Header destekleyen istemciler:

```text
https://your-host/mcp
Authorization: Bearer <token>
```

```bash
ramcp url
```

## Geliştirme

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
- [Security](SECURITY.md)
- [Roadmap](ROADMAP.md)

## License

MIT © Amir Ali Manzar
