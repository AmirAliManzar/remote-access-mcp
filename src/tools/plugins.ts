import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted, assertAllowed } from '../core/policy.js';
import { dataDir } from '../core/platform.js';
interface Manifest{name:string;version:string;description?:string;entry?:string;permissions?:string[];trusted?:boolean}
const root=()=>path.join(dataDir(),'plugins');
function manifests():Manifest[]{if(!fs.existsSync(root()))return[];return fs.readdirSync(root(),{withFileTypes:true}).flatMap(d=>{if(!d.isDirectory())return[];try{return[JSON.parse(fs.readFileSync(path.join(root(),d.name,'manifest.json'),'utf8'))]}catch{return[]}})}
function pluginDir(name:string):string{return path.join(root(),name.replace(/[^a-zA-Z0-9._-]/g,'_'));}
function pluginEntry(m:Manifest):string|null{
  if (!m.entry || !m.trusted) return null;
  const dir=pluginDir(m.name);
  const resolved=path.resolve(dir,m.entry);
  const rel=path.relative(dir,resolved);
  if (!rel || rel.startsWith('..'+path.sep) || path.isAbsolute(rel)) return null;
  return resolved;
}
export async function registerInstalledPlugins(server:McpServer,ctx:ToolContext):Promise<void>{
  for (const m of manifests()) {
    const entry=pluginEntry(m);
    if (!entry) continue;
    const dir = pluginDir(m.name);
    const allowed = (m.permissions || []).every(p => !ctx.token.scopes.length || ctx.token.scopes.includes(p));
    if (!allowed) continue;
    try { const mod = await import(pathToFileURL(entry).href); if (typeof mod.register === 'function') await mod.register(server, ctx); } catch { /* a broken plugin must not prevent gateway startup */ }
  }
}
export function registerPluginTools(server:McpServer,ctx:ToolContext):void{
 server.registerTool('plugin_list',{description:'List installed local Remote Access MCP plugins and their declared permissions.',inputSchema:{}},async()=>{assertToolPermitted({tool:'plugin_list',scopes:ctx.token.scopes,readOnly:ctx.readOnly});return{content:[{type:'text',text:JSON.stringify(manifests(),null,2)}]};});
 server.registerTool('plugin_install',{description:'Install a trusted local plugin directory containing manifest.json. The source must already exist on the machine.',inputSchema:{source:z.string()}},async({source})=>{assertToolPermitted({tool:'plugin_install',scopes:ctx.token.scopes,readOnly:ctx.readOnly});const src=path.resolve(source);assertAllowed({allowed_paths:ctx.token.allowed_paths,denied_paths:ctx.token.denied_paths,shell_enabled:ctx.token.shell_enabled},src);const mf=path.join(src,'manifest.json');if(!fs.existsSync(mf))return{content:[{type:'text',text:'manifest.json not found.'}],isError:true};const m=JSON.parse(fs.readFileSync(mf,'utf8')) as Manifest;if(!m.name||!m.version)return{content:[{type:'text',text:'Invalid plugin manifest.'}],isError:true};if(m.trusted!==true)return{content:[{type:'text',text:'Plugin manifest must explicitly set trusted=true before installation.'}],isError:true};const dest=pluginDir(m.name);fs.mkdirSync(root(),{recursive:true});fs.cpSync(src,dest,{recursive:true});return{content:[{type:'text',text:`Plugin ${m.name}@${m.version} installed. Declared permissions: ${(m.permissions||[]).join(', ')||'none'}.`}]};});
 server.registerTool('plugin_remove',{description:'Remove an installed local plugin.',inputSchema:{name:z.string().regex(/^[a-zA-Z0-9._-]+$/)}},async({name})=>{assertToolPermitted({tool:'plugin_remove',scopes:ctx.token.scopes,readOnly:ctx.readOnly});const p=path.join(root(),name);if(!fs.existsSync(p))return{content:[{type:'text',text:'Plugin not found.'}],isError:true};fs.rmSync(p,{recursive:true,force:true});return{content:[{type:'text',text:`Plugin ${name} removed.`}]};});
}
