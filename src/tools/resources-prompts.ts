import os from 'node:os';
import fs from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted } from '../core/policy.js';
import { dataDir } from '../core/platform.js';

export function registerResourcesAndPrompts(server:McpServer,ctx:ToolContext):void{
 const gate=(tool:string)=>assertToolPermitted({tool,scopes:ctx.token.scopes,readOnly:ctx.readOnly});
 const json=(x:unknown)=>JSON.stringify(x,null,2);
 server.registerResource('system_resource','ramcp://system',{description:'Current local system information',mimeType:'application/json'},async()=>({contents:[{uri:'ramcp://system',mimeType:'application/json',text:json({hostname:os.hostname(),platform:process.platform,release:os.release(),arch:os.arch(),cpus:os.cpus().length,totalMemory:os.totalmem(),freeMemory:os.freemem(),uptime:os.uptime()})}]}));
 server.registerResource('services_resource','ramcp://services',{description:'Configured service and runtime overview',mimeType:'application/json'},async()=>({contents:[{uri:'ramcp://services',mimeType:'application/json',text:json({platform:process.platform,pid:process.pid,uptime:process.uptime()})}]}));
 server.registerResource('network_resource','ramcp://network',{description:'Local network interface information',mimeType:'application/json'},async()=>({contents:[{uri:'ramcp://network',mimeType:'application/json',text:json(os.networkInterfaces())}]}));
 server.registerResource('projects_resource','ramcp://projects',{description:'Local Remote Access MCP data directory overview',mimeType:'application/json'},async()=>({contents:[{uri:'ramcp://projects',mimeType:'application/json',text:json({dataDir:dataDir(),entries:fs.existsSync(dataDir())?fs.readdirSync(dataDir()):[]})}]}));
 server.registerResource('audit_resource','ramcp://audit',{description:'Recent audit entries for the authenticated operator',mimeType:'application/json'},async()=>{gate('audit_resource');if(!ctx.cfg.audit.enabled)return{contents:[{uri:'ramcp://audit',mimeType:'application/json',text:json([])}]};const {AuditLog}=await import('../core/audit.js');const audit=new AuditLog(ctx.cfg.audit.db_path);const fingerprint=AuditLog.fingerprint(ctx.token.token);const rows=audit.query({fingerprint,limit:100});return{contents:[{uri:'ramcp://audit',mimeType:'application/json',text:json(rows)}]};});
 const prompt=(name:string,title:string,description:string,text:string)=>server.registerPrompt(name,{title,description},async()=>({description,messages:[{role:'user',content:{type:'text',text}}]}));
 prompt('diagnose_prompt','Diagnose Server','Systematic server diagnosis','Inspect system health, failed services, processes, ports, logs, disk and network. Prefer read-only diagnostics first and summarize evidence before proposing mutations.');
 prompt('deploy_prompt','Deploy Project','Safe project deployment','Inspect the project, run tests/build, create a change snapshot, apply the smallest safe deployment steps, verify service health, and report rollback instructions.');
 prompt('security_audit_prompt','Security Audit','Local security review','Audit exposed ports, permissions, secrets, services and configuration. Do not reveal secrets; report masked findings and prioritize remediation.');
 prompt('inspect_project_prompt','Inspect Project','Developer project inspection','Analyze the project structure, framework, dependencies, Git state, tests and health. Return actionable findings with file paths.');
 server.registerTool('system_resource',{description:'Return the current system resource as structured JSON.',inputSchema:{}},async()=>{gate('system_resource');return{content:[{type:'text',text:json({hostname:os.hostname(),platform:process.platform,release:os.release(),cpus:os.cpus().length,totalMemory:os.totalmem(),freeMemory:os.freemem(),uptime:os.uptime()})}]};});
}
