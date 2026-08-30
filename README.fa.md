# remote-access-mcp

[![npm version](https://img.shields.io/npm/v/remote-access-mcp.svg)](https://www.npmjs.com/package/remote-access-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

هر سرور لینوکسی رو با MCP ([Model Context Protocol](https://modelcontextprotocol.io)) به ماشینی تبدیل کن که هوش مصنوعی بهش وصل بشه.

ChatGPT (حالت Developer)، Claude، Grok و هر کلاینت MCP-دیگه از طریق HTTPS وصل میشن و به‌صورت امن سرورت رو کنترل می‌کنن: خواندن و نوشتن فایل، اجرای دستورات شل، وضعیت سیستم، دیتابیس SQLite و کار با گیت — همه پشت یک توکن.

**بدون پایتون. بدون داکر. فقط Node.js.**

```bash
npm install -g remote-access-mcp
ramcp init
```

## فلسفه

دستیارهای هوش مصنوعی قوی‌ان ولی از زیرساخت شما دورن. این گیت‌وی اون رو برعکس می‌کنه: چت‌بات شما خودش مهندس DevOps میشه. «ببین چرا دیسک سرور پر میشه» یا «برنچ جدید رو دیپلوی کن و لاگ‌ها رو نگاه کن» تبدیل به گفتگوهای واقعی میشن.

سرور فقط روی `127.0.0.1` گوش میده. پشت nginx/Caddy (با Cloudflare یا هر لبه TLS دیگه) قرارش میدی و دقیقاً یک endpoint HTTPS به دنیا ارائه میشه. هر درخواست باید توکن داشته باشه — یا به‌صورت هدر `Authorization: Bearer` یا داخل مسیر URL (`/<token>/mcp`) برای کلاینت‌هایی مثل کانکتور ChatGPT که نمی‌تونن هدر سفارشی ست کنن.

## نصب

### یک خطی (هر سرور اوبونتو/دبیان)

```bash
curl -fsSL https://raw.githubusercontent.com/AmirAliManzar/remote-access-mcp/main/install.sh | bash
```

سپس:

```bash
ramcp init
```

### دستی

```bash
npm install -g remote-access-mcp
ramcp init
```

## دستورات

| دستور | توضیح |
|---|---|
| `ramcp init` | ساخت کانفیگ + توکن. اجرای مجدد امنه. |
| `ramcp start` | اجرا در foreground. |
| `ramcp url` | چاپ URL کانکتور برای چت‌بات. |
| `ramcp token rotate` | تولید توکن جدید (قبلی فوراً باطل میشه). |
| `ramcp policy` | نمایش مسیرهای مجاز. |
| `ramcp policy allow <path>` | دادن دسترسی AI به یک دایرکتوری. |
| `ramcp policy deny <path>` | سلب دسترسی از یک دایرکتوری. |
| `ramcp policy shell on/off` | فعال/غیرفعال کردن اجرای شل. |
| `ramcp service install` | نصب سرویس systemd + vhostnginx. |
| `ramcp service uninstall` | حذف سرویس و کانفیگ nginx. |
| `ramcp status` | وضعیت سرویس. |

## اتصال چت‌بات

### ChatGPT (Developer Mode → Connectors)

از فرمت URL استفاده کن (ChatGPT نمی‌تونه هدر سفارشی ست کنه):

```
https://دامنه.com/<token>/mcp
```

آماده‌ش رو بگیر:

```bash
$ ramcp url
https://mcp.example.com/6kX9mQf2.../mcp
```

### Claude و هر کلاینت MCP با پشتیبانی هدر

Endpoint: `https://دامنه.com/mcp`
هدر: `Authorization: Bearer <token>`

## ابزارها

**فایل‌سیستم** (۷) — `list_directory`, `read_file`, `write_file`, `edit_file`, `delete_path`, `search_code`, `file_info`

**شل** (۳) — `run_command`, `process_list`, `kill_process`

**سیستم** (۳) — `system_info`, `disk_usage`, `network_interfaces`

**HTTP** (۲) — `http_request`, `port_check`

**گیت** (۱) — `git`

**SQLite** (۲) — `sqlite_query`, `sqlite_schema`

**سیاست دسترسی** (۴) — `list_allowed_paths`, `allow_path`, `deny_path`, `shell_enabled`

## مدل امنیتی

- **فقط loopback.** گیت‌وی روی `127.0.0.1:8765` گوش میده — از شبکه مستقیم قابل دسترسی نیست.
- **احراز هویت توکنی روی هر درخواست.** دو فرمت: هدر bearer یا مسیر URL.
- **موتور سیاست مسیر.** ابزارهای فایل‌سیستم symlinkها رو resolve و `..` رو قبل از چک allow/deny نرمال‌سازی می‌کنن. deny همیشه برنده‌ست.
- **شل پشت فلگ.** تا صریحاً فعالش نکنی خاموشه.
- **بدون لو رفتن رازها در لاگ‌ها.**

انتظار اینه که TLS جلوش باشه (nginx + Let's Encrypt یا لبه CDN). خود گیت‌وی HTTP ساده روی loopback حرف می‌زنه.

## مجوز

MIT — [LICENSE](LICENSE)

---

📚 [English README](README.md) | [نقشه راه](ROADMAP.md)
