// Behavior port of Hermes MemoryStore. MIT, Nous Research; see third_party/hermes-memory.
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSqlite, transaction, type SqlDatabase } from "../session/sqlite.js";
import { memoryThreat } from "./threat_patterns.js";
export type MemoryTarget = "memory" | "user";
export interface MemoryOperation {
    action: "add" | "patch" | "remove";
    content?: string;
    old_text?: string;
    matched_entry?: string;
}
export interface MemoryResult {
    success: boolean;
    done?: boolean;
    error?: string;
    staged?: boolean;
    pending_id?: string;
    [key: string]: unknown;
}
export const DELIMITER = "\n§\n";
export const codepoints = (s: string) => Array.from(s).length;
export const decodeEntries = (s: string) => [...new Set(s.replace(/^\uFEFF/, "").split(DELIMITER).map(x => x.trim()).filter(Boolean))];
export function atomicText(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
        writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
        const fd = openSync(tmp, "r");
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, file);
        if (process.platform !== "win32") {
            const dir = openSync(path.dirname(file), "r");
            try {
                fsyncSync(dir);
            }
            finally {
                closeSync(dir);
            }
        }
    }
    finally {
        try {
            unlinkSync(tmp);
        }
        catch {
            // Best-effort cleanup must not mask a write failure or committed rename.
        }
    }
}
const fold = (s: string) => s.replace(/\\n/g, " ").replace(/["`‘’‚‛“”„‟]/g, "'").replace(/[‐‑‒–—―−]/g, "-").replace(/\s+/g, " ").trim();
class MutationError extends Error {
    constructor(message: string, readonly kind = "invalid_args") { super(message); }
}
export function findEntry(entries: string[], needle: string): number {
    const exact = entries.indexOf(needle);
    if (exact >= 0)
        return exact;
    let hits = entries.map((s, i) => s.includes(needle) ? i : -1).filter(i => i >= 0);
    if (!hits.length && /[\p{L}\p{N}]/u.test(fold(needle)))
        hits = entries.map((s, i) => fold(s).includes(fold(needle)) ? i : -1).filter(i => i >= 0);
    if (hits.length !== 1)
        throw new MutationError(hits.length ? "Multiple entries matched; be more specific." : "No entry matched; inspect current entries.", hits.length ? "ambiguous" : "no_match");
    return hits[0]!;
}
export interface CuratedConfig {
    memory_char_limit: number;
    user_char_limit: number;
    memory_enabled: boolean;
    user_profile_enabled: boolean;
    write_approval: boolean;
}
export const DEFAULT_CURATED: CuratedConfig = { memory_char_limit: 2200, user_char_limit: 1375, memory_enabled: true, user_profile_enabled: true, write_approval: false };
export class CuratedMemoryStore {
    readonly db: SqlDatabase;
    private failures = 0;
    constructor(readonly home: string, readonly config: CuratedConfig = DEFAULT_CURATED) {
        mkdirSync(home, { recursive: true, mode: 0o700 });
        this.db = openSqlite(path.join(home, "memory-control.db"));
        this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_state(key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
    }
    close() { this.db.close(); }
    resetFailures() { this.failures = 0; }
    enabled(t: MemoryTarget) { return t === "memory" ? this.config.memory_enabled : this.config.user_profile_enabled; }
    limit(t: MemoryTarget) { return t === "memory" ? this.config.memory_char_limit : this.config.user_char_limit; }
    file(t: MemoryTarget) { return path.join(this.home, "memories", t === "memory" ? "MEMORY.md" : "USER.md"); }
    read(t: MemoryTarget): string[] {
        try {
            return decodeEntries(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(this.file(t))));
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT")
                return [];
            throw e;
        }
    }
    snapshot() {
        return (["memory", "user"] as const).filter(t => this.enabled(t)).map(t => {
            const entries = this.read(t).map(s => memoryThreat(s) ? "[BLOCKED: unsafe memory entry; review original file]" : s);
            return entries.length ? `${t === "memory" ? "MEMORY (your personal notes)" : "USER PROFILE (who the user is)"} [${codepoints(entries.join(DELIMITER))}/${this.limit(t)} chars]\n${entries.join(DELIMITER)}` : "";
        }).filter(Boolean).join("\n\n");
    }
    audit(event: Record<string, unknown>) { this.db.prepare("INSERT INTO audit(ts,json) VALUES (?,?)").run(Date.now(), JSON.stringify(event)); }
    state<T>(key: string, fallback: T): T { const row = this.db.prepare("SELECT json FROM learning_state WHERE key=?").get(key) as {
        json: string;
    } | undefined; return row ? JSON.parse(row.json) as T : fallback; }
    setState(key: string, value: unknown) { this.db.prepare("INSERT INTO learning_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json").run(key, JSON.stringify(value)); }
    private walk(t: MemoryTarget, operations: MemoryOperation[]) {
        if (!operations.length)
            throw new MutationError("operations must not be empty");
        const original = this.read(t), entries = [...original], pinned: MemoryOperation[] = [], changes: object[] = [];
        for (const op of operations) {
            const content = op.action === "patch" ? op.content ?? "" : (op.content ?? "").trim();
            const old = op.action === "patch" ? op.old_text ?? "" : (op.old_text ?? "").trim();
            if (op.action === "add") {
                if (!content)
                    throw new MutationError("content is required");
                if (memoryThreat(content))
                    throw new MutationError(`Blocked: ${memoryThreat(content)}`, "scan_blocked");
                if (!entries.includes(content))
                    entries.push(content);
                pinned.push({ ...op });
                continue;
            }
            if (!["patch", "remove"].includes(op.action) || !old.trim())
                throw new MutationError("Use add/patch/remove; old_text is required for edits.");
            const i = op.matched_entry !== undefined ? entries.indexOf(op.matched_entry) : findEntry(entries, old);
            if (i < 0)
                throw new MutationError("Entry changed since proposal was staged.", "stale_entry");
            const before = entries[i]!;
            pinned.push({ ...op, matched_entry: before });
            if (op.action === "remove") {
                entries.splice(i, 1);
                changes.push({ action: "remove", before });
                continue;
            }
            if (!content.trim())
                throw new MutationError("Patch content is required; remove deletes an entry.");
            let count = 0;
            for (let p = 0; p <= before.length - old.length; p++)
                if (before.startsWith(old, p))
                    count++;
            if (count !== 1)
                throw new MutationError("Patch span must occur exactly once, byte-exactly.", "ambiguous");
            const after = before.replace(old, () => content);
            if (after === before)
                throw new MutationError("Patch is a no-op");
            if (memoryThreat(after))
                throw new MutationError("Blocked: unsafe patched entry", "scan_blocked");
            entries[i] = after;
            changes.push({ action: "patch", before, after });
        }
        if (original.length && !entries.length && !(operations.length === 1 && operations[0]!.action === "remove"))
            throw new MutationError("Refusing consolidation that empties the store.", "would_empty");
        const grows = !(operations.every(o => o.action === "remove") || (operations.length === 1 && JSON.stringify(entries) === JSON.stringify(original)));
        if (grows && codepoints(entries.join(DELIMITER)) > this.limit(t))
            throw new MutationError("Final batch exceeds character budget; consolidate in one batch.", "overflow");
        return { entries, pinned, changes, original };
    }
    apply(t: MemoryTarget, operations: MemoryOperation[], opts: {
        background?: boolean;
        approved?: boolean;
        source?: string;
        signal?: AbortSignal;
    } = {}): MemoryResult {
        try {
            if (!["memory", "user"].includes(t) || !this.enabled(t))
                throw new MutationError("Memory target disabled or invalid.");
            if (opts.signal?.aborted)
                throw new MutationError("Canceled; no write.");
            return transaction(this.db, () => {
                const result = this.walk(t, operations);
                if (opts.signal?.aborted)
                    throw new MutationError("Canceled; no write.");
                if (!opts.approved && (this.config.write_approval || (opts.background && operations.some(o => o.action !== "add")))) {
                    const id = randomUUID();
                    this.db.prepare("INSERT INTO proposals VALUES (?,?,?)").run(id, JSON.stringify({ target: t, operations: result.pinned, source: opts.source, created_at: Date.now() }), "pending");
                    this.audit({ event: "staged", id, target: t });
                    return { success: true, staged: true, pending_id: id };
                }
                if (result.original.some(s => codepoints(s) > this.limit(t))) {
                    const backup = `${this.file(t)}.${randomUUID()}.bak`;
                    atomicText(backup, readFileSync(this.file(t), "utf8"));
                    if (!result.entries.every(e => result.original.includes(e)))
                        throw new MutationError(`External drift: oversized entry. Backup: ${backup}`, "drift");
                }
                atomicText(this.file(t), result.entries.join(DELIMITER));
                this.audit({ event: "write", target: t, source: opts.source, changes: result.changes });
                this.failures = 0;
                return { success: true, done: true, target: t, usage: `${codepoints(result.entries.join(DELIMITER))}/${this.limit(t)}`, entry_count: result.entries.length, changes: result.changes, note: "Write saved; do not repeat." };
            });
        }
        catch (e) {
            const kind = e instanceof MutationError ? e.kind : "io_error";
            if (!["scan_blocked", "io_error", "drift"].includes(kind) && operations.length > 0 && ++this.failures > 3)
                return { success: false, done: true, error: "Memory save skipped after repeated failures; continue replying to the user." };
            return { success: false, error: (e as Error).message, ...(["overflow", "no_match"].includes(kind) ? { current_entries: this.read(t), limit: this.limit(t) } : {}) };
        }
    }
    pending() { return this.db.prepare("SELECT id,json FROM proposals WHERE status='pending' ORDER BY rowid").all().map(r => { const x = r as {
        id: string;
        json: string;
    }; return { id: x.id, ...JSON.parse(x.json) }; }); }
    resolve(id: string, approve: boolean): MemoryResult {
        // One control transaction covers replay AND marking consumed. File/DB crash gap is journaled as applying.
        const row = this.db.prepare("SELECT json,status FROM proposals WHERE id=?").get(id) as {
            json: string;
            status: string;
        } | undefined;
        if (!row || row.status !== "pending")
            return { success: false, error: "Proposal missing or already handled; applying requires manual recovery." };
        if (!approve) {
            this.db.prepare("UPDATE proposals SET status='rejected' WHERE id=?").run(id);
            return { success: true };
        }
        const claimed = transaction(this.db, () => { const current = this.db.prepare("SELECT status FROM proposals WHERE id=?").get(id) as {
            status: string;
        }; if (current.status !== "pending")
            return false; this.db.prepare("UPDATE proposals SET status='applying' WHERE id=?").run(id); return true; });
        if (!claimed)
            return { success: false, error: "Proposal is already being applied" };
        const p = JSON.parse(row.json) as {
            target: MemoryTarget;
            operations: MemoryOperation[];
        };
        const result = this.apply(p.target, p.operations, { approved: true, source: `proposal:${id}` });
        this.db.prepare("UPDATE proposals SET status=? WHERE id=?").run(result.success ? "approved" : "pending", id);
        return result;
    }
}
