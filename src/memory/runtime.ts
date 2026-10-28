import { openSqlite } from "../session/sqlite.js";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ChatMessage, StreamChatOptions } from "../client/types.js";
import type { Session } from "../session/session.js";
import type { DurableStore } from "../session/durable_store.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { ApprovalGate } from "../approval/types.js";
import { CuratedMemoryStore, type MemoryTarget, type MemoryOperation } from "./curated_store.js";
import { loadHermesConfig, type HermesConfig } from "./hermes_config.js";
import { HistoryIndex } from "../session/history_index.js";
import { SkillRepository } from "../skills/manage.js";
import { executeReview, type ReviewStream } from "../learning/background_review.js";
import { bounded, MemoryProviderManager, type MemoryIdentity, type ExternalMemoryProvider } from "./provider.js";
import { memoryThreat } from "./threat_patterns.js";
export const MEMORY_START = "<!-- dao-curated-memory:start -->", MEMORY_END = "<!-- dao-curated-memory:end -->";
export class MemoryRuntime {
    readonly store: CuratedMemoryStore;
    readonly history: HistoryIndex;
    readonly skills: SkillRepository;
    readonly config: HermesConfig;
    identity: MemoryIdentity;
    provider?: MemoryProviderManager;
    private controller?: AbortController;
    private review?: Promise<void>;
    private request?: StreamChatOptions;
    private reviewOptions?: Parameters<MemoryRuntime["afterTurn"]>[0];
    private dueMemory = false;
    private dueSkills = false;
    private lastActivity = Date.now();
    private bound?: DurableStore;
    private closed = false;
    private lease = randomUUID();
    private active = false;
    private timer?: ReturnType<typeof setInterval>;
    constructor(readonly home: string, workspace: string, readonly profile = "default", config?: HermesConfig) {
        this.config = config ?? loadHermesConfig(home);
        this.store = new CuratedMemoryStore(home, this.config.memory);
        this.history = new HistoryIndex(home);
        this.skills = new SkillRepository(this.store);
        this.lastActivity=this.store.state<number>("last_activity",0);
        this.identity = { profile: home, workspace, session: "", actor: "main" };
    }
    async initialize() {
        this.store.db.exec("CREATE TABLE IF NOT EXISTS memory_leases(id TEXT PRIMARY KEY,pid INTEGER NOT NULL)");
        this.store.db.prepare("INSERT INTO memory_leases VALUES (?,?)").run(this.lease, process.pid);
        if (this.config.curator.enabled) {
            this.curator(false);
            this.timer = setInterval(() => { if (!this.active)
                try {
                    this.curator(false);
                }
                catch (e) {
                    this.store.audit({ event: "curator_error", error: String(e) });
                } }, 600000);
            this.timer.unref();
        }
        if (this.config.memory.provider) {
            const file = this.config.memory.provider_module;
            if (!file || !path.isAbsolute(file))
                throw new Error("External memory provider requires an explicit absolute provider_module path; Python plugins are not directly compatible.");
            const module = await import(pathToFileURL(file).href) as {
                createMemoryProvider: () => Promise<ExternalMemoryProvider>;
            };
            this.provider = new MemoryProviderManager(await module.createMemoryProvider());
            await this.provider.initialize(this.identity);
        }
    }
    prompt() { return `${MEMORY_START}\n${this.store.snapshot()}\n${this.provider?.provider.systemPromptBlock() ?? ""}\n${MEMORY_END}`; }
    refreshPrompt(messages: ChatMessage[]) { const first = messages[0]; if (first?.role !== "system")
        return messages; const text = first.content; const start = text.indexOf(MEMORY_START), end = text.indexOf(MEMORY_END); if (start < 0 || end < start)
        return messages; return [{ ...first, archiveId: undefined, content: text.slice(0, start) + this.prompt() + text.slice(end + MEMORY_END.length) }, ...messages.slice(1)]; }
    bind(store: DurableStore) {
        this.controller?.abort();
        const previous = { ...this.identity };
        const sources = this.store.state<string[]>("history_sources", []);
        if (!sources.includes(store.dir))
            this.store.setState("history_sources", [...sources, store.dir]);
        const id = store.bindMemoryProfile(this.home);
        this.identity = { ...this.identity, session: id };
        this.bound = store;
        if (previous.session && previous.session !== id)
            this.provider?.switch(previous, this.identity);
        store.afterSave = () => { try {
            this.history.sync(store.db, { id, workspace: store.cwd, source: store.dir, title: store.state()?.title ?? store.state()?.taskTitle ?? store.sessionId, lineage: store.readMeta<string>("history_lineage"), kind: process.env.DAO_CRON === "1" ? "cron" : "main" });
        }
        catch (e) {
            this.history.lastError = String(e);
        } };
        store.afterSave();
    }
    private counters() { return this.store.state<{
        turns: number;
        iterations: number;
        lastUser?: string;
    }>(`counters:${this.identity.session}`, { turns: 0, iterations: 0 }); }
    async beforeTurn(session: Session) {
        await this.cancel();
        this.active = true;
        this.lastActivity = Date.now();
        this.store.setState("last_activity",this.lastActivity);
        this.store.resetFailures();
        const user = session.messages.findLast(m => m.role === "user" && !m.origin);
        if (!user)
            return;
        user.archiveId ??= randomUUID();
        const c = this.counters();
        if (c.lastUser === user.archiveId)
            return;
        c.lastUser = user.archiveId;
        c.turns++;
        this.dueMemory = c.turns % this.config.memory.nudge_interval === 0;
        this.store.setState(`counters:${this.identity.session}`, c);
        if (this.dueMemory)
            session.messages.push({ role: "system", origin: "memory_nudge", content: "Consider whether this conversation revealed stable facts that apply to every session. Save only high-signal facts with memory; task-specific lessons belong in skills. Nothing to save is valid." });
        if (this.provider && typeof user.content === "string") {
            const recall = await this.provider.turn(user.content, this.identity);
            if (recall && !memoryThreat(recall)) {
                user.rawContent = user.content;
                user.content += `\n\n<memory-context>\nRetrieved reference data, subordinate to current instructions and evidence:\n${[...new Set(recall.split("\n"))].join("\n")}\n</memory-context>`;
            }
        }
    }
    rememberRequest(request: StreamChatOptions) { this.request = { ...request, messages: structuredClone(request.messages), tools: structuredClone(request.tools) }; const c = this.counters(); c.iterations++; this.dueSkills ||= c.iterations % this.config.skills.creation_nudge_interval === 0; this.store.setState(`counters:${this.identity.session}`, c); }
    async afterTurn(options: {
        session: Session;
        registry: ToolRegistry;
        ctx: ToolContext;
        gate: ApprovalGate;
        stream: ReviewStream;
        contextWindow: number;
        oneShot: boolean;
    }) {
        const { session } = options;
        this.reviewOptions = options;
        if(!options.registry.get("skill_manage"))this.dueSkills=false;
        const last = session.messages.findLastIndex(m => m.role === "user" && !m.origin);
        if (last >= 0)
            this.provider?.sync(session.messages.slice(last).map(m => m.rawContent !== undefined ? { ...m, content: m.rawContent } as ChatMessage : m), this.identity);
        if (options.oneShot || session.mode === "plan" || !this.config.background_review.enabled || (!this.dueMemory && !this.dueSkills) || !this.request)
            return;
        const model = this.request.model;
        const request = { ...this.request, onUsage: (u: import("../client/types.js").Usage) => { const prior = session.lastPromptTokens; session.addUsage(u, model); session.lastPromptTokens = prior; } };
        const controller = new AbortController();
        this.controller = controller;
        const memory = this.dueMemory, skills = this.dueSkills;
        this.dueMemory = false;
        this.dueSkills = false;
        // The advertised tools stay byte-identical; execution uses the review whitelist.
        this.review = executeReview({ request: { ...request, messages: structuredClone(session.messages) }, stream: options.stream, registry: options.registry, ctx: { ...options.ctx, skillReadHashes: new Map() }, gate: options.gate, signal: controller.signal, memory, skills, maxIterations: this.config.background_review.max_iterations, inputBudget: options.contextWindow > 0 ? Math.min(600000, .75 * options.contextWindow) : 120000, onResult: data => { if (!this.closed)
                this.store.audit(data); } }).catch(e => { if (!this.closed)
            this.store.audit({ event: "review_error", error: String(e) }); });
    }
    async refine(options: Parameters<MemoryRuntime["afterTurn"]>[0]) { if (!this.request)
        throw new Error("Complete a model turn before requesting review"); await this.cancel(); this.dueMemory = true; this.dueSkills = true; await this.afterTurn({ ...options, oneShot: false }); await this.review; }
    endTurn() { this.active = false; this.lastActivity = Date.now();
        this.store.setState("last_activity",this.lastActivity); }
    requestCancel(){this.controller?.abort();}
    async cancel() { this.controller?.abort(); if (this.review)
        await bounded(this.review, 2000); this.review = undefined; }
    write(target: MemoryTarget, operations: MemoryOperation[], ctx: {
        background?: boolean;
        signal?: AbortSignal;
    } = {}) { const result = this.store.apply(target, operations, { ...ctx, source: this.identity.session }); if (result.success && !result.staged)
        this.provider?.mirror({ target, operations, result }, { ...this.identity, actor: ctx.background ? "background_review" : "main" }); return result; }
    async precompress(messages: ChatMessage[]) { await this.cancel(); await this.provider?.precompress(messages, this.identity, this.config.compression.checkpoint_required); }
    rebuildHistory() {
        const results: unknown[] = [];
        for (const dir of this.store.state<string[]>("history_sources", [])) {
            const db = openSqlite(path.join(dir, "session.db"), true);
            try {
                const meta = (key: string) => { const r = db.prepare("SELECT json FROM meta WHERE key=?").get(key) as {
                    json: string;
                } | undefined; return r ? JSON.parse(r.json) : undefined; };
                if (meta("memory_profile") !== this.home)
                    throw new Error("History source belongs to a different profile");
                const state = meta("checkpoint");
                this.history.sync(db, { id: meta("archive_uuid"), workspace: state.cwd, source: dir, title: state.title ?? state.taskTitle ?? state.id, lineage: meta("history_lineage") }, false);
                results.push({ source: dir, success: true });
            }
            catch (e) {
                results.push({ source: dir, error: String(e) });
            }
            finally {
                db.close();
            }
        }
        for (const dir of this.store.state<string[]>("legacy_history_sources", []))
            try {
                results.push(this.history.importLegacy(dir));
            }
            catch (e) {
                results.push({ source: dir, error: String(e) });
            }
        return results;
    }
    status() { return { engine: "hermes", profile: this.profile, home: this.home, session: this.identity.session, memory: this.store.read("memory"), user: this.store.read("user"), pending: [...this.store.pending(), ...this.skills.pending()], index_error: this.history.lastError, provider: this.config.memory.provider || null, provider_pending: this.provider?.pending ?? 0 }; }
    command(args: string[]) { const [verb, id] = args; if (verb === "pending")
        return [...this.store.pending(), ...this.skills.pending()]; if (verb === "approve" || verb === "reject") {
        if (!id)
            throw new Error("Proposal ID required");
        if (this.skills.pending().some(p => p.id === id))
            return this.skills.resolve(id, verb === "approve");
        const proposal = this.store.pending().find(p => p.id === id);
        const result = this.store.resolve(id, verb === "approve");
        if (verb === "approve" && result.success)
            this.provider?.mirror({ proposal, result }, this.identity);
        return result;
    } return this.status(); }
    curator(dryRun = true, references?: string[]) {
        const c = this.config.curator;
        if (!references) {
            const cron = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 2000 });
            if (cron.status === 0)
                references = cron.stdout.split("\n");
            else if (/no crontab/i.test(cron.stderr ?? ""))
                references = [];
            else
                return { skipped: true, reason: "Could not verify scheduled skill references; maintenance deferred" };
        }
        const result = this.skills.curate({ lastActivity: Math.max(this.lastActivity,this.store.state<number>("last_activity",0)), references, dryRun, intervalHours: c.interval_hours, idleHours: c.min_idle_hours, staleDays: c.stale_after_days, archiveDays: c.archive_after_days });
        if (c.consolidate && !dryRun && "actions" in result && result.actions.length && this.reviewOptions && this.request && !this.active) {
            const eligible = this.skills.list().filter(s => s.source === "agent" && !s.pinned && !references?.some(ref => ref.includes(s.name))).map(s => s.name);
            if (eligible.length >= 2) {
                const controller = new AbortController();
                this.controller?.abort();
                this.controller = controller;
                const session = this.reviewOptions.session, model = this.request.model;
                const request = { ...this.request, onUsage: (u: import("../client/types.js").Usage) => { const prior = session.lastPromptTokens; session.addUsage(u, model); session.lastPromptTokens = prior; } };
                this.review = executeReview({ request, stream: this.reviewOptions.stream, registry: this.reviewOptions.registry, ctx: { ...this.reviewOptions.ctx, skillReadHashes: new Map() }, gate: this.reviewOptions.gate, signal: controller.signal, memory: false, skills: true, maxIterations: this.config.background_review.max_iterations, inputBudget: 120000, instruction: `Maintain these eligible skills only: ${eligible.join(", ")}. Read them with skill_view. If genuinely overlapping, use skill_manage action consolidate with a NEW target name, sources list and merged SKILL.md content. Complete source packages are preserved under merged/. Read and verify the new package before separately archiving redundant sources. Never consolidate unrelated skills; no changes is valid. Do not write global memory or perform the original user task.`, onResult: event => { if (!this.closed)
                        this.store.audit({ ...event, origin: "curator" }); } }).catch(e => { if (!this.closed)
                    this.store.audit({ event: "curator_error", error: String(e) }); });
            }
        }
        return result;
    }
    async close() { if (this.timer)
        clearInterval(this.timer); await this.cancel(); await this.provider?.shutdown(this.identity); this.closed = true; try {
        this.store.db.prepare("DELETE FROM memory_leases WHERE id=?").run(this.lease);
    }
    catch { } if (this.bound)
        this.bound.afterSave = undefined; this.history.close(); this.store.close(); }
}
