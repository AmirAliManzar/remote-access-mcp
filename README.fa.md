# remote-access-mcp

[![npm version](https://img.shields.io/npm/v/remote-access-mcp.svg)](https://www.npmjs.com/package/remote-access-mcp)
[![CI](https://github.com/AmirAliManzar/remote-access-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AmirAliManzar/remote-access-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

هر سرور لینوکسی رو با MCP ([Model Context Protocol](https://modelcontextprotocol.io)) به ماشینی تبدیل کن که هوش مصنوعی بهش وصل بشه.

ChatGPT (حالت Developer)، Claude، Grok و هر کلاینت MCP-دیگه از طریق HTTPS وصل میشن و به‌صورت امن سرورت رو کنترل می‌کنن — همه پشت دسترسی‌های per-token.

**بدون پایتون. بدون داکر. فقط Node.js.**

```bash
npm install -g remote-access-mcp
ramcp init
```

## نصب

```bash
curl -fsSL https://raw.githubusercontent.com/AmirAliManzar/remote-access-mcp/main/install.sh | bash
ramcp init
```

## شروع سریع

روی **سرور** با دامنه:

```bash
ramcp init                          # کانفیگ + اولین توکن
ramcp policy allow /srv/myapp       # چه مسیرهایی رو AI ببینه
ramcp policy shell on               # اجازه اجرای دستور (اختیاری)
ramcp service install --domain mcp.example.com   # systemd + nginx
ramcp doctor                        # بررسی سلامت همه‌چیز
ramcp url                           # URL کانکتور برای چت‌بات
```

روی **لپ‌تاپ / دسکتاپ** (بدون دامنه و بدون پورت‌فوروارد):

```bash
ramcp tunnel
# → دفعه اول cloudflared رو خودکار دانلود می‌کنه (بدون نیاز به اکانت)
#   یه URL عمومی https میده مثل https://random-words.trycloudflare.com
# دستور `ramcp url` توی ترمینال دیگه، لینک زنده کانکتور رو نشون میده.
```

روی ویندوز، مک و لینوکس یکسانه — PowerShell/cmd روی ویندوز، launchd روی مک، systemd روی لینوکس برای سرویس خودکار.

## توکن‌های چندگانه — کمترین دسترسی به‌صورت پیش‌فرض

```bash
# توکن فقط-خواندنی برای ممیزی
ramcp token add --name auditor --paths /srv --scopes filesystem --read-only

# توکن دیپلوی: فایل + گیت + شل، با محدودیت نرخ و انقضا
ramcp token add --name deploy --paths /srv/app --scopes filesystem,git,shell --shell --rpm 30 --expires 2026-12-31
```

هر توکن خودش داره: مسیرهای مجاز/غیرمجاز، گروه ابزارها (scopes)، فلگ شل، حالت فقط-خواندنی، محدودیت نرخ، و تاریخ انقضا.

## ۳۸ ابزار در ۱۵ گروه

فایل‌سیستم (۷)، شل (۳)، سیستم (۳)، HTTP با محافظ SSRF (۳)، گیت با whitelist فعل‌ها (۱)، SQLite تک-دستوره (۲)، لاگ/journalctl (۳)، سرویس‌های systemd (۲)، پکیج‌ها apt/npm (۳)، زمان‌بند (۳)، اسکن امنیتی (۲)، تحلیل پروژه (۲)، پلنینگ + اسنپ‌شات/rollback (۴)، مدیریت پالیسی (۴).

## مدل امنیتی

- **فقط loopback** — سرور روی `127.0.0.1` گوش میده
- **توکن timing-safe** روی هر درخواست — در لاگ‌ها فقط fingerprint ذخیره میشه
- **Sandbox per-token** — resolve سیم‌لینک و `..` قبل از چک؛ deny همیشه برنده‌ست
- **محدوده‌های SSRF بسته** — AI نمیتونه به metadata کلود یا سرویس‌های داخلی برسه
- **ضد injection** — فعل‌های git whitelist، SQL تک-دستوره، ATTACH بسته
- **لاگ audit ضد-دستکاری** — hash chain؛ `ramcp audit --verify` هر حذف/ویرایش رو لو میده؛ رازهای داخل آرگومان‌ها redact میشن
- **Hot-reload** — تغییر پالیسی از درخواست بعدی اعمال میشه، بدون ریستارت
- **کلید-کشِ حالت فقط-خواندن** — `ramcp policy readonly on` همه ابزارهای تغییردهنده رو قفل می‌کنه

## دستورات کامل

`init` `start` `url` `doctor` `status` `token list|add|show|rotate|revoke` `policy [token] allow|deny|shell|readonly` `audit [--verify]` `service install|uninstall|logs|status` `schedule list` — جزئیات: [README انگلیسی](README.md)

## مجوز

MIT — [LICENSE](LICENSE)

---

📚 [English README](README.md) | [نقشه راه](ROADMAP.md)

## یکپارچه‌سازی‌های MCP اختیاری

در نسخه ۲.۳، یک لایهٔ یکپارچه‌سازی برای ابزارهای توسعه‌دهنده اضافه شده است:

- **Context7** — به‌صورت ابزارهای نام‌گذاری‌شده مانند `context7_resolve-library-id` و `context7_get-library-docs` داخل دروازه در دسترس قرار می‌گیرد.
- **Codebase Memory** — در صورت تنظیم `RAMCP_ENABLE_CODEBASE_MEMORY=1` ابزارهای `codebase_memory_*` را ارائه می‌کند. این یکپارچه‌سازی عمداً اختیاری است، چون Codebase Memory از daemon و cache بومیِ سطح حساب استفاده می‌کند و نباید بدون هماهنگی با نشست‌های دیگر آن multiplex شود. با `RAMCP_CODEBASE_ROOT` ریشهٔ مخزن کدی را که این نمونه باید در اختیار Codebase Memory قرار دهد مشخص کنید؛ `index_repository` نیز در خود Remote Access MCP به همین ریشه محدود شده است.
- **Context Mode** — فقط به‌عنوان وابستگی اختیاری محلی نصب می‌شود و به‌عنوان سرویس میزبانی‌شده از طریق Remote Access MCP ارائه نمی‌شود، چون مجوز Elastic License 2.0 آن ارائهٔ نرم‌افزار به‌عنوان سرویس میزبانی‌شده یا مدیریت‌شده را محدود می‌کند.

اگر یک یکپارچه‌سازی اختیاری در زمان راه‌اندازی قابل اجرا نباشد، هستهٔ Remote Access MCP همچنان در دسترس می‌ماند و آن یکپارچه‌سازی با پیام تشخیصی کنار گذاشته می‌شود.
