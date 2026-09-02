import crypto from 'node:crypto';
export interface Approval { id: string; tokenId: string; command: string; cwd?: string; created: string; status: 'pending'|'approved'|'rejected'; }
const rows = new Map<string, Approval>();
export function requestApproval(tokenId: string, command: string, cwd?: string): Approval { const a={id:crypto.randomUUID().slice(0,12),tokenId,command,cwd,created:new Date().toISOString(),status:'pending' as const}; rows.set(a.id,a); return a; }
export function getApproval(id:string, tokenId?:string): Approval|undefined { const a=rows.get(id); return a && (!tokenId || a.tokenId===tokenId) ? a : undefined; }
export function decideApproval(id:string, tokenId:string|undefined, approved:boolean): Approval|undefined { const a=getApproval(id,tokenId); if(!a || a.status!=='pending') return a; a.status=approved?'approved':'rejected'; return a; }
