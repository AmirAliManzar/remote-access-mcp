import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted } from '../core/policy.js';
import { isWindows } from '../core/platform.js';
const exec=promisify(execFile);
export function registerDiagnosticsTools(server:McpServer,ctx:ToolContext):void{
 server.registerTool('system_diagnostics',{description:'Collect a structured system diagnostic snapshot: CPU, memory, load, uptime and disk summary.',inputSchema:{}},async()=>{assertToolPermitted({tool:'system_diagnostics',scopes:ctx.token.scopes,readOnly:ctx.readOnly});let disk='';try{const r=isWindows()?await exec('wmic',['logicaldisk','get','size,freespace,caption']):await exec('df',['-h','/']);disk=String(r.stdout)}catch{}return{content:[{type:'text',text:JSON.stringify({platform:process.platform,release:os.release(),arch:os.arch(),cpus:os.cpus().length,totalMemory:os.totalmem(),freeMemory:os.freemem(),load:os.loadavg(),uptime:os.uptime(),disk})}]};});
 server.registerTool('diagnose_service',{description:'Diagnose a service using status and recent journal/log output.',inputSchema:{name:z.string()}},async({name})=>{assertToolPermitted({tool:'diagnose_service',scopes:ctx.token.scopes,readOnly:ctx.readOnly});if(isWindows())return{content:[{type:'text',text:'Use Windows service diagnostics through run_command on this platform.'}]};try{const status=await exec('systemctl',['status',name,'--no-pager','-n','30'],{maxBuffer:200000});return{content:[{type:'text',text:status.stdout+status.stderr}]};}catch(e:any){return{content:[{type:'text',text:e.stdout||e.stderr||e.message}],isError:true};}});
}
