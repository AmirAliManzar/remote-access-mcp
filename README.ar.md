# Remote Access MCP

> **امنح مساعد الذكاء الاصطناعي وصولاً حقيقياً إلى جهازك.**
>
> اربط ChatGPT وClaude وGrok وQwen Desktop وغيرها من عملاء MCP باللابتوب أو الكمبيوتر أو الـVM أو الخادم لديك، ودع الـAgent يقرأ الملفات ويعدل الكود ويشغّل الاختبارات ويفحص السجلات وينفذ المهام متعددة الخطوات ضمن الصلاحيات التي تمنحها له.

Remote Access MCP هو بوابة وصول آمنة إلى جهاز حقيقي عبر [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

بدلاً من أن يقول الذكاء الاصطناعي “شغّل هذا الأمر”، يمكن للـAgent تنفيذ دورة كاملة:

**المراقبة → التخطيط → التعديل → الاختبار → التحقق → التقرير**

## ماذا يستطيع الـAgent أن يفعل؟

بحسب صلاحيات الـToken، يمكنه:

- قراءة وإنشاء وتعديل وحذف والبحث في الملفات
- رفع وتنزيل الملفات الثنائية
- تشغيل الاختبارات والبناء وShell بشكل مضبوط
- فحص العمليات والقرص والشبكة والخدمات والسجلات
- العمل مع Git
- الاستعلام من SQLite وMySQL وPostgreSQL وRedis
- فحص HTTP endpoints وبيئة Browser الاختيارية
- تشغيل Background Jobs ومهام متوازية محدودة
- تشغيل Scheduler وWebhook/Event automation
- فحص Docker/Kubernetes
- إنشاء Snapshot وإجراء Rollback للتغييرات الخطرة

## الأنظمة المدعومة

يعمل Core Gateway على **Linux وmacOS وWindows** مع Node.js 18+.

```bash
npm install -g remote-access-mcp
ramcp init
ramcp tunnel
```

لا تحتاج إلى Python أو Docker لتشغيل الـCore Gateway.

## الأمان

يمكن تقييد كل Token باستخدام:

- مسارات مسموحة وممنوعة
- Tool Scopes
- أدوار `auditor` و`developer` و`deployer` و`admin`
- Shell وCommand Allowlist
- وضع Read-only
- Rate Limit
- مدة صلاحية Token

وتشمل الحماية أيضاً فحص المسارات، وحماية SSRF، والتحقق من معاملات Git، وقيود SQLite، وAudit Hash Chain، وSnapshot/Rollback، وعزل الإضافات.

**الهدف ليس إعطاء AI صلاحيات غير محدودة، بل جعل قدراته واضحة ومحدودة وقابلة للمراقبة والإلغاء.**

## ربط عميل AI

للعملاء الذين يقبلون Token داخل URL:

```text
https://your-host/<token>/mcp
```

للعملاء الذين يدعمون Authorization Header:

```text
https://your-host/mcp
Authorization: Bearer <token>
```

```bash
ramcp url
```

## التطوير

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
- [Русский](README.ru.md)
- [Security](SECURITY.md)
- [Roadmap](ROADMAP.md)

## License

MIT © Amir Ali Manzar
