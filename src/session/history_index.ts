import { createHash } from "node:crypto";
import { readDurableState } from "./durable_store.js";
import { messageText } from "./archive.js";
import type { ChatMessage } from "../client/types.js";
import path from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { openSqlite, transaction, type SqlDatabase } from "./sqlite.js";
import type { ArchivedMessage } from "./archive.js";
export interface SearchOptions {
    query?: string;
    session_id?: string;
    around_message_id?: string;
    limit?: number;
    role?: string;
    after?: number;
    before?: number;
    workspace?: string;
    currentSession?: string;
}
export class HistoryIndex {
    readonly db: SqlDatabase;
    lastError?: string;
    constructor(readonly home: string) {
        mkdirSync(home, { recursive: true, mode: 0o700 });
        this.db = openSqlite(path.join(home, "history.db"));
        this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL, revision INTEGER NOT NULL, lineage TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'main');
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created INTEGER NOT NULL, active INTEGER NOT NULL, compacted INTEGER NOT NULL, origin TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_session_seq ON messages(session,seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(id UNINDEXED,content,tokenize='unicode61');`);
        const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as {
            name: string;
        }[];
        if (!cols.some(c => c.name === "lineage"))
            this.db.exec("ALTER TABLE sessions ADD COLUMN lineage TEXT NOT NULL DEFAULT ''");
        if (!cols.some(c => c.name === "kind"))
            this.db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'main'");
    }
    close() { this.db.close(); }
    sync(source: SqlDatabase, info: {
        id: string;
        workspace: string;
        source: string;
        title: string;
        lineage?: string;
        kind?: string;
    }, acknowledge = true) {
        const indexed = this.db.prepare("SELECT id FROM sessions WHERE id=?").get(info.id);
        const pending = source.prepare(`SELECT MAX(id) id, MAX(revision) revision FROM history_outbox ${indexed && acknowledge ? "WHERE delivered=0" : ""}`).get() as {
            id: number | null;
            revision: number | null;
        };
        if (!pending.id)
            return;
        const rows = source.prepare("SELECT * FROM memory_messages ORDER BY seq").all() as ArchivedMessage[];
        transaction(this.db, () => {
            const prior = this.db.prepare("SELECT revision FROM sessions WHERE id=?").get(info.id) as {
                revision: number;
            } | undefined;
            if (prior && prior.revision > (pending.revision ?? 0))
                return;
            this.db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated=excluded.updated,revision=excluded.revision,lineage=excluded.lineage,kind=excluded.kind").run(info.id, info.workspace, info.source, info.title, Date.now(), pending.revision ?? 0, info.lineage ?? info.id, info.kind ?? "main");
            for (const r of rows) {
                const exists = this.db.prepare("SELECT id FROM messages WHERE id=?").get(r.message_id);
                this.db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,compacted=excluded.compacted").run(r.message_id, info.id, r.seq, r.role, r.content, r.created_at, r.active, r.compacted, r.origin);
                if (!exists)
                    this.db.prepare("INSERT INTO messages_fts(id,content) VALUES (?,?)").run(r.message_id, r.content);
            }
        });
        if (acknowledge)
            source.prepare("UPDATE history_outbox SET delivered=1 WHERE id<=?").run(pending.id);
        this.lastError = undefined;
    }
    importLegacy(dir: string) {
        const state = existsSync(path.join(dir, "session.db")) ? readDurableState(dir) : existsSync(path.join(dir, "state.json")) ? JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as import("./log.js").PersistedState : undefined;
        if (!state)
            throw new Error("No readable legacy session checkpoint");
        const sourceId = createHash("sha256").update(path.resolve(dir)).digest("hex"), messages: ChatMessage[] = [];
        const events = path.join(dir, "events.jsonl");
        if (existsSync(events))
            for (const line of readFileSync(events, "utf8").split("\n")) {
                if (!line.trim())
                    continue;
                try {
                    const e = JSON.parse(line) as {
                        t: string;
                        text?: string;
                        content?: string;
                        ts?: number;
                    };
                    if (e.t === "user" && e.text)
                        messages.push({ role: "user", content: e.text, createdAt: e.ts, origin: "imported" });
                    else if (e.t === "assistant" && e.content)
                        messages.push({ role: "assistant", content: e.content, createdAt: e.ts, origin: "imported" });
                }
                catch { /* A truncated legacy JSONL line is explicitly reported below. */ }
            }
        // Preserve checkpoint evidence absent from best-effort event logs, without inventing tool associations.
        for (const m of state.messages)
            if ((m.role === "user" || m.role === "assistant") && !messages.some(x => x.role === m.role && messageText(x) === messageText(m)))
                messages.push({ ...m, origin: "imported" });
        transaction(this.db, () => {
            this.db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,title=excluded.title").run(sourceId, state.cwd, dir, state.title ?? state.taskTitle ?? state.id, state.updatedAt, 0, sourceId, "main");
            messages.forEach((m, i) => {
                const text = messageText(m);
                const id = createHash("sha256").update(sourceId + ":" + i + ":" + text).digest("hex");
                if (this.db.prepare("SELECT id FROM messages WHERE id=?").get(id))
                    return;
                this.db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)").run(id, sourceId, i, m.role, text, m.createdAt ?? state.updatedAt, 0, 1, "imported");
                this.db.prepare("INSERT INTO messages_fts VALUES (?,?)").run(id, text);
            });
        });
        return { session_id: sourceId, imported: messages.length, limitation: "Legacy events were best-effort; missing originals and tool-call associations cannot be reconstructed." };
    }
    search(o: SearchOptions = {}) {
        const limit = Math.min(20, Math.max(1, o.limit ?? 3));
        const filters = ["m.origin IN ('conversation','imported')", "s.kind NOT IN ('subagent','background_review','kanban')", "NOT (m.session=? AND m.active=1 AND m.compacted=0)"];
        const args: unknown[] = [o.currentSession ?? ""];
        if (o.role) {
            filters.push("m.role=?");
            args.push(o.role);
        }
        else
            filters.push("m.role IN ('user','assistant')");
        if (o.after !== undefined) {
            filters.push("m.created>=?");
            args.push(o.after);
        }
        if (o.before !== undefined) {
            filters.push("m.created<=?");
            args.push(o.before);
        }
        if (o.workspace) {
            filters.push("s.workspace=?");
            args.push(o.workspace);
        }
        const where = filters.join(" AND ");
        const hydrate = (session: string, around?: number) => {
            const rows = this.db.prepare(`SELECT m.* FROM messages m JOIN sessions s ON s.id=m.session WHERE ${where} AND m.session=? ORDER BY seq`).all(...args, session) as Record<string, unknown>[];
            const selected = around !== undefined ? rows.filter(r => Math.abs(Number(r.seq) - around) <= 5) : rows.length > 30 ? [...rows.slice(0, 20), ...rows.slice(-10)] : rows;
            return { session_id: session, total_messages: rows.length, truncated: selected.length < rows.length, messages: selected.map(r => ({ message_id: r.id, role: r.role, created_at: r.created, content: Array.from(String(r.content)).slice(0, 2000).join(""), compacted: !!r.compacted })) };
        };
        if (o.around_message_id) {
            const row = this.db.prepare(`SELECT m.session,m.seq FROM messages m JOIN sessions s ON s.id=m.session WHERE ${where} AND m.id=?`).get(...args, o.around_message_id) as {
                session: string;
                seq: number;
            } | undefined;
            return { index_error: this.lastError, ...(row ? hydrate(row.session, row.seq) : { error: "Message unavailable in this profile or excluded live context" }) };
        }
        if (o.session_id)
            return { index_error: this.lastError, ...hydrate(o.session_id) };
        let candidates: Record<string, unknown>[];
        if (o.query?.trim()) {
            const query = o.query.trim();
            if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(query)) {
                const terms = query.split(/\s+/).slice(0, 12);
                const like = terms.map(() => "(m.content LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')").join(" AND ");
                const escape = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;
                candidates = this.db.prepare(`SELECT m.*,s.title,s.lineage,s.kind FROM messages m JOIN sessions s ON s.id=m.session WHERE ${where} AND ${like} ORDER BY m.created DESC LIMIT 300`).all(...args, ...terms.flatMap(t => [escape(t), escape(t)])) as Record<string, unknown>[];
            }
            else {
                const q = query.split(/\s+/).slice(0, 12).map(s => '"' + s.replace(/"/g, '""') + '"').join(" OR ");
                candidates = this.db.prepare(`SELECT m.*,s.title,s.lineage,s.kind,bm25(messages_fts) rank FROM messages_fts f JOIN messages m ON m.id=f.id JOIN sessions s ON s.id=m.session WHERE ${where} AND messages_fts MATCH ? ORDER BY rank LIMIT 300`).all(...args, q) as Record<string, unknown>[];
            }
        }
        else
            candidates = this.db.prepare(`SELECT m.*,s.title,s.lineage,s.kind FROM messages m JOIN sessions s ON s.id=m.session WHERE ${where} ORDER BY m.created DESC LIMIT 300`).all(...args) as Record<string, unknown>[];
        if (o.query?.trim()) {
            const q = o.query.trim().toLowerCase();
            const titleHits = this.db.prepare(`SELECT m.*,s.title,s.lineage,s.kind FROM messages m JOIN sessions s ON s.id=m.session WHERE ${where} AND instr(lower(s.title),?)>0 ORDER BY m.created DESC LIMIT 300`).all(...args, q) as Record<string, unknown>[];
            candidates = [...titleHits, ...candidates];
        }
        candidates.sort((a, b) => Number(a.kind === "cron") - Number(b.kind === "cron"));
        const seen = new Set<string>();
        const results = [];
        for (const r of candidates) {
            const id = String(r.session);
            const lineage = String(r.lineage || id);
            if (seen.has(lineage))
                continue;
            seen.add(lineage);
            results.push(results.length === 0 ? { ...hydrate(id), title: r.title, match: { message_id: r.id, snippet: String(r.content).slice(0, 2000) } } : { session_id: id, title: r.title, message_id: r.id, snippet: String(r.content).slice(0, 500) });
            if (results.length >= limit)
                break;
        }
        return { results, index_error: this.lastError, search: "FTS5; CJK literal fallback (no semantic embeddings)" };
    }
}
