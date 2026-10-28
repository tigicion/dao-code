import { randomUUID, createHash } from "node:crypto";
import type { ChatMessage } from "../client/types.js";
import type { SqlDatabase } from "./sqlite.js";
export const ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_messages(message_id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, json TEXT NOT NULL, api_json TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS memory_compactions(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, before_ids TEXT NOT NULL, after_ids TEXT NOT NULL);`;
export function messageText(m: ChatMessage) { return typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter(p => p.type === "text").map(p => (p as {
    text: string;
}).text).join("\n") : ""; }
/** Called inside DurableStore.atomic, alongside its recovery checkpoint. IDs live outside API wire fields. */
export function archiveSnapshot(db: SqlDatabase, messages: ChatMessage[], revision: number) {
    const identity = JSON.parse((db.prepare("SELECT json FROM meta WHERE key='identity'").get() as {
        json: string;
    }).json) as {
        cwd: string;
        sessionId: string;
    };
    const scope = workspaceId(identity.cwd) + ":" + identity.sessionId;
    let seq = Number((db.prepare("SELECT COALESCE(MAX(seq),0) n FROM memory_messages").get() as {
        n: number;
    }).n);
    const before = (db.prepare("SELECT message_id FROM memory_messages WHERE active=1 ORDER BY seq").all() as {
        message_id: string;
    }[]).map(r => r.message_id);
    db.prepare("UPDATE memory_messages SET active=0 WHERE active=1").run();
    for (const m of messages) {
        if (m.archiveSession && m.archiveSession !== scope)
            m.archiveId = undefined;
        m.archiveSession = scope;
        m.archiveId ??= randomUUID();
        m.createdAt ??= Date.now();
        const existing = db.prepare("SELECT message_id,json FROM memory_messages WHERE message_id=?").get(m.archiveId) as {
            message_id: string;
            json: string;
        } | undefined;
        // Tool-result pruning changes API content, never the archived source evidence.
        if (existing) {
            db.prepare("UPDATE memory_messages SET active=1,api_json=? WHERE message_id=?").run(JSON.stringify(m), m.archiveId);
            continue;
        }
        const origin = m.origin ?? (m.role === "system" ? "system" : "conversation");
        const source = m.rawContent !== undefined ? { ...m, content: m.rawContent } as ChatMessage : m;
        db.prepare("INSERT INTO memory_messages(message_id,seq,role,content,json,api_json,created_at,active,compacted,origin) VALUES (?,?,?,?,?,?,?,1,0,?)").run(m.archiveId, ++seq, m.role, messageText(source), JSON.stringify(source), JSON.stringify(m), m.createdAt, origin);
    }
    const after = messages.map(m => m.archiveId!);
    const missing = before.filter(id => !after.includes(id));
    if (missing.length) {
        db.prepare("UPDATE memory_messages SET compacted=1 WHERE active=0").run();
        db.prepare("INSERT INTO memory_compactions VALUES (?,?,?,?)").run(randomUUID(), revision, JSON.stringify(before), JSON.stringify(after));
    }
    db.prepare("INSERT INTO history_outbox(revision) VALUES (?)").run(revision);
}
export const workspaceId = (cwd: string) => createHash("sha256").update(cwd).digest("hex").slice(0, 20);
export interface ArchivedMessage {
    message_id: string;
    seq: number;
    role: string;
    content: string;
    json: string;
    created_at: number;
    active: number;
    compacted: number;
    origin: string;
}
