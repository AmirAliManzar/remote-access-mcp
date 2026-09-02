import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted, assertAllowed } from '../core/policy.js';

const MAX = 32 * 1024 * 1024;
export function registerTransferTools(server:McpServer,ctx:ToolContext):void {
 const policy=()=>({allowed_paths:ctx.token.allowed_paths,denied_paths:ctx.token.denied_paths,shell_enabled:ctx.token.shell_enabled});
 server.registerTool('download_file',{description:'Download a local file as base64 with size and SHA-256 metadata. Binary-safe and path-policy checked.',inputSchema:{path:z.string()}},async({path})=>{assertToolPermitted({tool:'download_file',scopes:ctx.token.scopes,readOnly:ctx.readOnly,policy:policy(),target:path});const st=await fs.stat(path);if(st.size>MAX)return{content:[{type:'text',text:`File exceeds ${MAX} bytes.`}],isError:true};const b=await fs.readFile(path);return{content:[{type:'text',text:JSON.stringify({path,size:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),encoding:'base64',data:b.toString('base64')})}]};});
 server.registerTool('upload_file',{description:'Upload base64 data to a local file. Binary-safe, size-limited and path-policy checked.',inputSchema:{path:z.string(),data:z.string().describe('Base64-encoded file content'),sha256:z.string().optional()}},async({path,data,sha256})=>{assertToolPermitted({tool:'upload_file',scopes:ctx.token.scopes,readOnly:ctx.readOnly,policy:policy(),target:path});const b=Buffer.from(data,'base64');if(b.length>MAX)return{content:[{type:'text',text:`Payload exceeds ${MAX} bytes.`}],isError:true};const actual=crypto.createHash('sha256').update(b).digest('hex');if(sha256&&sha256!==actual)return{content:[{type:'text',text:'SHA-256 mismatch; file was not written.'}],isError:true};await fs.writeFile(path,b,{mode:0o600});return{content:[{type:'text',text:JSON.stringify({path,size:b.length,sha256:actual})}]};});
}
