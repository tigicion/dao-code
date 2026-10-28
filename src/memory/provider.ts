import { redactSecrets } from "../permissions/secrets.js";
import type { ChatMessage } from "../client/types.js";
export interface MemoryIdentity {
    profile: string;
    workspace: string;
    session: string;
    actor: string;
}
export interface ExternalMemoryProvider {
    name: string;
    initialize(scope: MemoryIdentity): Promise<void>;
    systemPromptBlock(): string;
    onTurnStart(scope: MemoryIdentity): Promise<void>;
    prefetch(query: string, scope: MemoryIdentity): Promise<string>;
    syncTurn(messages: ChatMessage[], scope: MemoryIdentity): Promise<void>;
    queuePrefetch?(query: string, scope: MemoryIdentity): Promise<void>;
    onMemoryWrite?(write: unknown, scope: MemoryIdentity): Promise<void>;
    onPreCompress?(messages: ChatMessage[], scope: MemoryIdentity): Promise<boolean>;
    onSessionEnd?(scope: MemoryIdentity): Promise<void>;
    onSessionSwitch?(prior: MemoryIdentity, next: MemoryIdentity): Promise<void>;
    onDelegation?(result: string, scope: MemoryIdentity): Promise<void>;
    shutdown(): Promise<void>;
}
export function redact(text: string): string {
    return redactSecrets(text).replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]").replace(/((?:api[_-]?key|password|secret|authorization|access[_-]?token)\s*[=:]\s*["']?)([^\s"',;]+)/gi, "$1[REDACTED]");
}
export function redactValue(value: unknown): unknown {
    if (typeof value === "string")
        return redact(value);
    if (Array.isArray(value))
        return value.map(redactValue);
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).filter(([k]) => !["reasoningContent", "responseItems"].includes(k)).map(([k, v]) => [k, /^(?:api[_-]?key|password|secret|authorization|access[_-]?token)$/i.test(k) ? "[REDACTED]" : redactValue(v)]));
    return value;
}
const cleanMessages = (messages: ChatMessage[]): ChatMessage[] => redactValue(messages) as ChatMessage[];
export async function bounded<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([p, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export class MemoryProviderManager {
    private queue: Promise<unknown> = Promise.resolve();
    private recalling = false;
    private closed = false;
    private halted = false;
    pending = 0;
    lastError?: string;
    constructor(readonly provider: ExternalMemoryProvider, readonly timeout = 8000) { }
    private error(e: unknown) { this.lastError = String(e); }
    async initialize(scope: MemoryIdentity) { await this.provider.initialize({ ...scope }); }
    async turn(query: string, scope: MemoryIdentity) {
        if (this.closed || this.recalling)
            return "";
        this.recalling = true;
        const identity = { ...scope };
        const p = (async () => { await this.provider.onTurnStart(identity); if (query.trim().length < 3)
            return ""; return redact(await this.provider.prefetch(redact(query), identity)); })().catch(e => { this.error(e); return ""; }).finally(() => { this.recalling = false; });
        return (await bounded(p, this.timeout)) ?? "";
    }
    enqueue(fn: () => Promise<unknown>) { if (this.closed)
        return; this.pending++; this.queue = this.queue.then(() => this.halted ? undefined : fn()).catch(e => this.error(e)).finally(() => { this.pending--; }); }
    sync(messages: ChatMessage[], scope: MemoryIdentity) { const clean = cleanMessages(messages), identity = { ...scope }; this.enqueue(async () => { await this.provider.syncTurn(clean, identity); const user = clean.findLast(m => m.role === "user"); if (user && typeof user.content === "string")
        await this.provider.queuePrefetch?.(user.content, identity); }); }
    mirror(write: unknown, scope: MemoryIdentity) { const safe = redactValue(write); const identity = { ...scope }; this.enqueue(async () => this.provider.onMemoryWrite?.(safe, identity)); }
    async precompress(messages: ChatMessage[], scope: MemoryIdentity, required: boolean) { try {
        const result = await bounded(this.provider.onPreCompress?.(cleanMessages(messages), { ...scope }) ?? Promise.resolve(true), this.timeout);
        if (required && result !== true)
            throw new Error("Required provider checkpoint failed");
    }
    catch (e) {
        this.error(e);
        if (required)
            throw e;
    } }
    switch(prior: MemoryIdentity, next: MemoryIdentity) { const a = { ...prior }, b = { ...next }; this.enqueue(async () => { await this.provider.onSessionEnd?.(a); await this.provider.onSessionSwitch?.(a, b); }); }
    delegation(result: string, scope: MemoryIdentity) { const identity = { ...scope }; this.enqueue(async () => this.provider.onDelegation?.(redact(result), identity)); }
    async shutdown(scope: MemoryIdentity) { this.enqueue(async () => this.provider.onSessionEnd?.({ ...scope })); this.closed = true; const drained = await bounded(this.queue.then(() => true), 5000); if (!drained) {
        this.halted = true;
        this.lastError = "Provider queue did not drain before shutdown";
    } await bounded(this.provider.shutdown().catch(e => this.error(e)), 1000); }
}
