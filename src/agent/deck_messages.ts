// Shared by the dashboard and the Dao bridge; this module has no application dependencies.
type Raw = { role?: string; content?: unknown; tool_calls?: {id?: string; function: {name: string; arguments: string}}[];
  toolCalls?: {id?: string; name: string; args: string;argsTruncated?:boolean}[]; tool_call_id?: string; toolCallId?: string; index?: number;
  contentTruncated?:boolean;contentLength?:number;toolCallsTruncated?:boolean };
export function contentText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim()==='[图片或多模态消息]' ? '' : value;
  if (Array.isArray(value)) return value.map(part => {
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (['image', 'image_url', 'input_image'].includes(part.type)) return '[图片附件 · 请在原终端查看]';
    return `[附件：${typeof part.type === 'string' ? part.type : '未知类型'}]`;
  }).filter(Boolean).join('\n');
  return '[暂不支持的消息内容]';
}
export function normalizeMessage(message: Raw, index?: number) {
  const text = contentText(message.content), calls = message.toolCalls || message.tool_calls?.map(c => ({id:c.id,name:c.function.name,args:c.function.arguments}));
  return { role: message.role, content: text.slice(0, 24000), index: index ?? message.index,
    contentTruncated: !!message.contentTruncated || text.length > 24000, contentLength: message.contentLength || text.length,
    toolCallId: message.toolCallId || message.tool_call_id,
    toolCalls: calls?.slice(0, 16).map(c => ({ ...c, args: String(c.args || '').slice(0, 12000), argsTruncated: !!('argsTruncated' in c && c.argsTruncated) || String(c.args || '').length > 12000 })),
    toolCallsTruncated: !!message.toolCallsTruncated || (!!calls && calls.length > 16) };
}
export function messageRevision(messages: Raw[]) {
  const prefix=JSON.stringify(messages.filter(m=>m.role!=='system').slice(0,3).map(m=>[
    m.role,contentText(m.content).slice(0,512),m.toolCalls?.map(t=>[t.id,t.name])||m.tool_calls?.map(t=>[t.id,t.function.name]),
  ]));
  let hash=2166136261;for(const ch of prefix)hash=Math.imul(hash^ch.charCodeAt(0),16777619);
  return String(hash);
}
export function messagePage(all: Raw[], before?: number, limit = 100) {
  const messages = all.filter(m => m.role !== 'system'), total = messages.length;
  const end = before === undefined ? total : Math.min(total, Math.max(0, before));
  let start = end, bytes = 0;
  const page: ReturnType<typeof normalizeMessage>[] = [];
  while (start > 0 && page.length < Math.min(100, Math.max(1, limit))) {
    const value = normalizeMessage(messages[start - 1]!, start - 1);
    const size = Buffer.byteLength(JSON.stringify(value));
    if (page.length && bytes + size > 1_200_000) break;
    bytes += size; page.unshift(value); start--;
  }
  return { messages: page, pagination: { total, start, end, hasMore: start > 0, nextBefore: start,revision:messageRevision(messages) } };
}
