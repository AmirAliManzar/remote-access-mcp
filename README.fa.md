# Remote Access MCP

<p align="center">
  <strong>به دستیار هوش مصنوعی‌ات دست واقعی به کامپیوترت بده.</strong><br>
  ChatGPT، Claude، Grok، Qwen Desktop و کلاینت‌های سازگار با MCP را به یک Agent واقعی تبدیل کن که می‌تواند روی لپ‌تاپ، دسکتاپ، VM یا سرورت کار کند.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/remote-access-mcp">NPM</a> ·
  <a href="https://github.com/AmirAliManzar/remote-access-mcp">GitHub</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

> **ایده ساده است:** چت‌بات همین الان می‌تواند فکر و تحلیل کند؛ Remote Access MCP به آن، با دسترسی کنترل‌شده، «دست» روی یک ماشین واقعی می‌دهد.

## Remote Access MCP چیست؟

[Model Context Protocol یا MCP](https://modelcontextprotocol.io/) استانداردی برای اتصال اپلیکیشن‌های هوش مصنوعی به ابزار و داده‌های خارجی است. **Remote Access MCP پل بین کلاینت هوش مصنوعی و یک ماشین واقعی است.**

آن را روی لپ‌تاپ، کامپیوتر، سرور، VM، Home Lab یا Cloud VM نصب کن؛ دسترسی‌ها را محدود کن؛ کلاینت MCP را وصل کن؛ و اجازه بده Agent واقعاً کار را انجام دهد.

به‌جای این:

> «این ارور منه؛ بگو چه دستوری اجرا کنم.»

می‌توانی بگویی:

> «پروژه را بررسی کن، باگ را بازتولید کن، فایل‌ها را اصلاح کن، تست‌ها را اجرا کن، لاگ‌ها را بررسی کن، مشکل را برطرف کن و دقیقاً بگو چه چیزی تغییر کرده.»

یعنی مدل فقط جواب نمی‌دهد؛ **چرخهٔ واقعی مشاهده → برنامه‌ریزی → تغییر → تست → تأیید را اجرا می‌کند.**

## از Chatbot به Agent

```text
┌──────────────────────┐
│ ChatGPT / Claude     │
│ Grok / Qwen / ...    │
└──────────┬───────────┘
           │ MCP / HTTPS
           ▼
┌──────────────────────────────┐
│      Remote Access MCP       │
│ auth · policy · audit · jobs  │
└──────────────┬───────────────┘
               │ ابزارهای کنترل‌شده
       ┌───────┼────────┬──────────┐
       ▼       ▼        ▼          ▼
     فایل    Shell     Git      Browser
       │       │        │          │
       └───────┴────────┴──────────┘
                    ▼
             ماشین واقعی شما
```

## Agent واقعاً چه کارهایی می‌تواند انجام دهد؟

بسته به Permissionهایی که می‌دهی، Agent می‌تواند:

- ساختار و کد یک پروژه را بررسی و درک کند
- فایل بسازد، بخواند، ویرایش کند، حذف کند و جابه‌جا کند
- فایل‌های باینری را Upload/Download کند
- Test، Lint، Build و Script اجرا کند
- Process، CPU، RAM، Disk، Network، Service و Log را بررسی کند
- روی Git کار کند
- از طریق Adapterهای کنترل‌شده با SQLite، MySQL، PostgreSQL و Redis کار کند
- Endpointهای HTTP و صفحات Browser را بررسی کند
- Jobهای طولانی را در Background اجرا کند
- چند کار مستقل را به‌صورت محدود و موازی انجام دهد
- کارهای زمان‌بندی‌شده و Event/Webhook را اجرا کند
- Docker/Kubernetes و زیرساخت موجود را بررسی کند
- قبل از تغییرات حساس Snapshot بگیرد و در صورت نیاز Rollback کند
- از Integrationهایی مثل Context7 و Codebase Memory استفاده کند

در نتیجه می‌توانی از یک چت‌بات معمولی، یک **Agent عملیاتی روی ماشین واقعی** بسازی.

## روی چه سیستم‌هایی؟

هسته پروژه برای **Linux، macOS و Windows** با Node.js 18+ طراحی شده است.

- Linux → systemd برای سرویس دائمی
- macOS → launchd برای سرویس دائمی
- Windows → Scheduled Tasks برای سرویس دائمی
- هر سیستم → اجرای مستقیم یا Tunnel/Direct HTTP بسته به شرایط

### لپ‌تاپ و دسکتاپ بدون دامنه

لازم نیست برای شروع دامنه بخری یا Port Forwarding انجام دهی:

```bash
npm install -g remote-access-mcp
ramcp init
ramcp tunnel
```

Remote Access MCP می‌تواند از Tunnel Providerهای پشتیبانی‌شده استفاده کند و یک HTTPS endpoint عمومی در اختیارت بگذارد.

## شروع سریع

### نصب

```bash
npm install -g remote-access-mcp
```

یا روی Ubuntu/Debian:

```bash
curl -fsSL https://raw.githubusercontent.com/AmirAliManzar/remote-access-mcp/main/install.sh | bash
```

### راه‌اندازی

```bash
ramcp init
```

با اجرای `ramcp` بدون آرگومان در یک Terminal تعاملی، TUI (رابط کاربری ترمینال) راهنمای پروژه باز می‌شود.

### دسترسی را محدود کن

مثلاً فقط پروژه مشخصی را در اختیار Agent قرار بده:

```bash
ramcp policy allow ~/Projects/my-app
ramcp policy shell on
```

یا یک Token اختصاصی بساز:

```bash
ramcp token add --name developer \
  --paths ~/Projects/my-app \
  --scopes filesystem,git,shell \
  --shell
```

### اتصال Chatbot

برای کلاینت‌هایی که Token را در URL می‌پذیرند:

```text
https://your-host/<token>/mcp
```

برای کلاینت‌هایی که Header دارند:

```text
https://your-host/mcp
Authorization: Bearer <token>
```

برای دریافت URL آماده:

```bash
ramcp url
```

## مثال واقعی: تعمیر پروژه

```text
کاربر:
«تست‌ها Fail شده‌اند. علت را پیدا کن، اصلاحش کن، تست‌های مرتبط را اجرا کن
و مطمئن شو تغییرت چیز دیگری را خراب نکرده.»

Agent:
  1. ساختار پروژه را بررسی می‌کند
  2. فایل‌های مرتبط را می‌خواند
  3. تست خراب را اجرا می‌کند
  4. خروجی و Log را بررسی می‌کند
  5. کد را اصلاح می‌کند
  6. تست‌های Focused را اجرا می‌کند
  7. Verification گسترده‌تر انجام می‌دهد
  8. نتیجه و فایل‌های تغییرکرده را گزارش می‌کند
```

## مثال واقعی: عیب‌یابی سرور

```text
«ببین چرا این سرور کند شده. CPU، RAM، Disk، Processها، Network، Logها
و Serviceها را بررسی کن، Bottleneck را پیدا کن، کم‌ریسک‌ترین راه‌حل را
اجرا کن و بعد نتیجه را Verify کن.»
```

## امنیت و Permission

نصب Remote Access MCP به معنی دادن دسترسی نامحدود به AI نیست.

هر Token می‌تواند موارد زیر را داشته باشد:

- مسیرهای مجاز
- مسیرهای ممنوع
- Scope ابزارها
- Roleهای `auditor`، `developer`، `deployer`، `admin`
- اجازه Shell
- Command Allowlist
- حالت Read-only
- Rate Limit
- Expiration

نمونه Token فقط‌خواندنی:

```bash
ramcp token add \
  --name auditor \
  --paths /srv/myapp \
  --scopes filesystem,git \
  --read-only
```

### Defense in Depth

پروژه شامل لایه‌های مختلف محافظتی است، از جمله:

- کنترل مسیر بعد از Resolve کردن `..` و Symlink
- برتری Deny نسبت به Allow
- بررسی Timing-safe برای Token
- Redact کردن Secretها در خروجی
- محافظت SSRF در برابر Loopback، Private Network و Cloud Metadata
- اعتبارسنجی Commandهای Git
- محدودیت Queryهای SQLite و مسدود بودن `ATTACH`
- محافظت از Serviceها و Processهای حساس
- Timeout و محدودیت خروجی Command
- Audit Log با Hash Chain
- Snapshot و Rollback فایل‌ها
- Plugin Isolation با Fail-Closed
- Autonomous Recovery به‌صورت پیش‌فرض خاموش

هدف امنیتی پروژه این نیست که «AI هیچ‌وقت اشتباه نمی‌کند»؛ هدف این است که **توانایی‌های AI محدود، قابل مشاهده، قابل بررسی و قابل لغو باشند.**

## Background Job و اجرای موازی

کارهای طولانی لازم نیست درخواست اصلی را Block کنند.

Gateway از اجرای محدود Worker برای مواردی مثل:

- Background Command
- Parallel Operation
- Retry محدود
- Cancellation
- Timeout
- Capture خروجی
- Metadata دائمی Job
- مالکیت Job بر اساس Token

پشتیبانی می‌کند.

## Automation و Event

Ruleهای Automation می‌توانند با Interval و Eventهای پشتیبانی‌شده مثل Webhook، File و Health اجرا شوند. Actionها همچنان از Policy، Scope، Read-only و Audit عبور می‌کنند.

مثلاً:

```text
Webhook
   ↓
بررسی Deployment
   ↓
Health Check
   ↓
جمع‌آوری Log
   ↓
گزارش نتیجه
```

Autonomous Recovery به‌صورت پیش‌فرض غیرفعال است و فعال‌سازی آن نیاز به تنظیم صریح Operator دارد.

## Codebase Memory و Integrationها

Integrationهای اختیاری می‌توانند قابلیت Agent را بیشتر کنند، بدون اینکه هسته پروژه به آن‌ها وابسته باشد.

- **Context7** → Context و Documentation کتابخانه‌ها
- **Codebase Memory** → Context مخصوص Repository و Codebase
- **Context Mode** → Integration محلی اختیاری
- Pluginهای محلی با Validation، Fingerprint و Isolation

هر Instance از Remote Access MCP می‌تواند Runtime، Cache و Data مستقل برای Codebase Memory داشته باشد تا با Instanceها و سرویس‌های دیگر روی همان ماشین تداخل نکند.

## CLI و TUI

CLI برای Script و Automation مناسب است و TUI برای مدیریت تعاملی خود Remote Access MCP طراحی شده است.

```bash
ramcp
ramcp doctor
ramcp status
ramcp service status
ramcp service logs -f
ramcp tunnel
ramcp url
ramcp token list
ramcp audit --verify
```

TUI یک Server Control Center عمومی نیست؛ تمرکزش روی Setup، اتصال، امنیت، تشخیص خطا و اجرای خود Remote Access MCP است.

## قابلیت‌های اصلی

| حوزه | نمونه قابلیت‌ها |
|---|---|
| Filesystem | list, read, write, edit, delete, search, upload/download |
| Shell | اجرای کنترل‌شده Command، Process، Kill |
| System | System Info، Disk، Network |
| HTTP | Request، Port Check، Web Fetch با SSRF Guard |
| Git | عملیات اعتبارسنجی‌شده |
| Database | SQLite، MySQL، PostgreSQL، Redis |
| Logs | فایل Log و Journal |
| Services | Status و Action کنترل‌شده |
| Planning | Plan، Snapshot، Rollback |
| Scheduling | Taskهای زمان‌بندی‌شده |
| Automation | Event و Webhook |
| Browser | Open، Extract، Screenshot اختیاری |
| Infrastructure | Docker، Kubernetes و تشخیص Cloudflare در صورت وجود CLI |
| Security | Secret Scan، Port Scan، Audit Verification |

سطح دقیق Toolها ممکن است در Releaseهای آینده تغییر کند؛ نسخه نصب‌شده و MCP Tool List منبع نهایی قابلیت‌ها هستند.

## توسعه و مشارکت

```bash
git clone https://github.com/AmirAliManzar/remote-access-mcp.git
cd remote-access-mcp
npm install
npm test
npm run build
```

Bug Report، Security Report، پیشنهاد، Pull Request و سناریوهای واقعی Agentic خوش‌آمدند.

## مستندات

- [README انگلیسی](README.md)
- [Roadmap](ROADMAP.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## مجوز

MIT © Amir Ali Manzar
