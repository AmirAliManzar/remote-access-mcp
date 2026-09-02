import os from 'node:os';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted } from '../core/policy.js';
import { AuditLog } from '../core/audit.js';
import { notifyWebhooks } from '../core/webhooks.js';
const watches=new Map<string,NodeJS.Timeout>();
export function registerMonitoringTools(server:McpServer,ctx:ToolContext):void{
 const tid=AuditLog.fingerprint(ctx.token.token);
 server.registerTool('health_watch',{description:'Start a periodic health watcher for CPU/memory thresholds. Alerts are emitted through configured webhooks.',inputSchema:{interval_seconds:z.number().min(10).max(3600).default(60),cpu_percent:z.number().min(1).max(100).optional(),memory_percent:z.number().min(1).max(100).optional()}},async({interval_seconds,cpu_percent,memory_percent})=>{assertToolPermitted({tool:'health_watch',scopes:ctx.token.scopes,readOnly:ctx.readOnly});const id=cryptoRandom();const timer=setInterval(()=>{const cpu=os.loadavg()[0]/Math.max(1,os.cpus().length)*100;const mem=(1-os.freemem()/os.totalmem())*100;if((cpu_percent&&cpu>=cpu_percent)||(memory_percent&&mem>=memory_percent))notifyWebhooks(ctx.cfg,{ts:Date.now(),token_fingerprint:tid,tool:'health_watch',args_json:JSON.stringify({cpu,memory:mem}),ok:0,is_error:1,duration_ms:0});},interval_seconds*1000);watches.set(`${tid}:${id}`,timer);return{content:[{type:'text',text:JSON.stringify({id,interval_seconds})}]};});
 server.registerTool('health_status',{description:'List active health watchers for the current token.',inputSchema:{}},async()=>{assertToolPermitted({tool:'health_status',scopes:ctx.token.scopes,readOnly:ctx.readOnly});return{content:[{type:'text',text:JSON.stringify([...watches.keys()].filter(k=>k.startsWith(tid+':')))}]};});
 server.registerTool('health_stop',{description:'Stop a health watcher.',inputSchema:{id:z.string()}},async({id})=>{assertToolPermitted({tool:'health_stop',scopes:ctx.token.scopes,readOnly:ctx.readOnly});const k=`${tid}:${id}`,t=watches.get(k);if(!t)return{content:[{type:'text',text:'Watcher not found.'}],isError:true};clearInterval(t);watches.delete(k);return{content:[{type:'text',text:`Stopped ${id}.`}]};});
}
function cryptoRandom(){return Math.random().toString(36).slice(2,12)}
