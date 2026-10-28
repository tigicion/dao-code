import { ARCHIVE_SCHEMA, archiveSnapshot } from "./archive.js";
import { randomUUID, createHash } from "node:crypto";
import { chmodSync, readFileSync, existsSync, mkdirSync, realpathSync, statfsSync } from "node:fs";
import path from "node:path";
import { openSqlite, transaction, type SqlDatabase } from "./sqlite.js";
import { identityAlive, processIdentity, type ProcessIdentity } from "./process_identity.js";
import type { PersistedState } from "./log.js";
import type { BackgroundEvent, ExecutionSnapshot, WaitHandle } from "../agent/background_types.js";
import type { ChatMessage, ToolMessage } from "../client/types.js";
export interface BackgroundCheckpoint {
    sessionId: string;
    state: "idle" | "running" | "waiting" | "paused";
    wait?: WaitHandle;
    runs: ExecutionSnapshot[];
    events: BackgroundEvent[];
    seq: number;
    consumed: string[];
}
export interface ToolRecord {
    scope: string;
    id: string;
    name: string;
    args: string;
    state: "started" | "result_committed" | "outcome_unknown";
    result?: ToolMessage;
}
export interface AgentRecord {
    taskId: string;
    runId: string;
    messages: ChatMessage[];
    metadata: Record<string, unknown>;
}
type Owner = {
    instanceId: string;
    identity: ProcessIdentity;
    epoch: number;
};
const SCHEMA_VERSION = 3;
const decode = <T>(row: unknown): T | undefined => row ? JSON.parse((row as {
    json: string;
}).json) as T : undefined;
/** All authoritative state shares one SQLite transaction domain. No JSON fallback on failure. */
export class DurableStore {
    readonly instanceId = randomUUID();
    readonly db: SqlDatabase;
    readonly epoch: number;
    private closed = false;
    private inTransaction = false;
    constructor(readonly dir: string, readonly sessionId: string, readonly cwd: string, private identities = { current: () => processIdentity()!, alive: identityAlive }) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir,0o700);
        // Network file systems cannot provide this design's same-host WAL/ownership guarantees.
        if ([0x6969, 0xff534d42, 0x517b].includes(Number(statfsSync(dir).type)))
            throw new Error("持久后台恢复不支持网络文件系统。");
        this.db = openSqlite(path.join(dir, "session.db"));
        try {
            const originalVersion = (this.db.prepare("PRAGMA user_version").get() as {
                user_version: number;
            }).user_version;
            if (originalVersion !== 0 && originalVersion !== 2 && originalVersion !== SCHEMA_VERSION)
                throw new Error(`不支持的会话存储版本 ${originalVersion}，未修改原数据。`);
            this.db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
            if ((this.db.prepare("PRAGMA journal_mode").get() as {
                journal_mode: string;
            }).journal_mode !== "wal" ||
                (this.db.prepare("PRAGMA synchronous").get() as {
                    synchronous: number;
                }).synchronous !== 2)
                throw new Error("SQLite 持久配置未生效。");
            const version = (this.db.prepare("PRAGMA user_version").get() as {
                user_version: number;
            }).user_version;
            if (version !== 0 && version !== 2 && version !== SCHEMA_VERSION)
                throw new Error(`不支持的会话存储版本 ${version}，未修改原数据。`);
            this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, json TEXT NOT NULL, delivered INTEGER);
        CREATE TABLE IF NOT EXISTS tools (scope TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(scope,id));
        CREATE TABLE IF NOT EXISTS agents (run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, json TEXT NOT NULL);
        `);
            const owner = transaction(this.db, () => {
                const existing = this.readMeta<{
                    sessionId: string;
                    cwd: string;
                }>("identity");
                const canonical = realpathSync(cwd);
                if (existing && (existing.sessionId !== sessionId || existing.cwd !== canonical))
                    throw new Error("会话身份或工作目录不匹配。");
                const prior = this.readMeta<Owner | null>("owner");
                if (prior && identities.alive(prior.identity))
                    throw new Error(`会话已由进程 ${prior.identity.pid} 使用，不能并发恢复。`);
                const epoch = (this.readMeta<number>("epoch") ?? 0) + 1;
                const next = { instanceId: this.instanceId, identity: identities.current(), epoch };
                this.putMeta("identity", { sessionId, cwd: canonical });
                this.putMeta("owner", next);
                this.putMeta("epoch", epoch);
                return next;
            });
            this.epoch = owner.epoch;
            if (originalVersion === 2) {
                const backup = path.join(dir, `session-v2-${randomUUID()}.db`);
                this.db.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'");
            }
            transaction(this.db, () => {
                this.db.exec(ARCHIVE_SCHEMA);
                const columns=this.db.prepare("PRAGMA table_info(memory_messages)").all() as {name:string}[];
                if(!columns.some(c=>c.name==="api_json"))this.db.exec("ALTER TABLE memory_messages ADD COLUMN api_json TEXT NOT NULL DEFAULT '{}' ");
                this.db.exec("PRAGMA user_version=3;");
            });
            chmodSync(path.join(dir, "session.db"), 0o600);
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    readMeta<T>(key: string): T | undefined { return decode<T>(this.db.prepare("SELECT json FROM meta WHERE key=?").get(key)); }
    private putMeta(key: string, value: unknown) { this.db.prepare("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json").run(key, JSON.stringify(value)); }
    assertOwner() {
        if (this.closed)
            throw new Error("会话存储已关闭。");
        const owner = this.readMeta<Owner | null>("owner");
        if (!owner || owner.instanceId !== this.instanceId || owner.epoch !== this.epoch)
            throw new Error("会话所有权已失效，停止执行。");
    }
    atomic<T>(fn: () => T): T {
        if (this.inTransaction) {
            this.assertOwner();
            return fn();
        }
        return transaction(this.db, () => {
            this.assertOwner();
            this.inTransaction = true;
            try {
                return fn();
            }
            finally {
                this.inTransaction = false;
            }
        });
    }
    afterSave?: () => void;
    bindMemoryProfile(profile: string): string {
        return this.atomic(() => {
            const prior = this.readMeta<string>("memory_profile");
            if(prior && prior !== profile) throw new Error("会话记忆 profile 不匹配");
            this.putMeta("memory_profile", profile);
            const id=this.readMeta<string>("archive_uuid") ?? randomUUID();
            this.putMeta("archive_uuid",id);return id;
        });
    }
    state() { return this.readMeta<PersistedState>("checkpoint"); }
    background() { return this.readMeta<BackgroundCheckpoint>("background"); }
    save(state: PersistedState, background?: BackgroundCheckpoint) {
        this.atomic(() => {
            const revision = (this.readMeta<number>("revision") ?? 0) + 1;
            if (background) {
                for (const id of background.consumed)
                    this.db.prepare("UPDATE events SET delivered=? WHERE id=? AND delivered IS NULL").run(revision, id);
                this.putMeta("background", { ...background, consumed: [], events: background.events.filter(e => !background.consumed.includes(e.eventId)) });
            }
            archiveSnapshot(this.db,state.messages,revision);
            this.putMeta("checkpoint", state);
            this.putMeta("revision", revision);
        });
        this.afterSave?.();
    }
    setState(state: BackgroundCheckpoint["state"]) {
        this.atomic(() => {
            const b = this.background();
            if (b)
                this.putMeta("background", { ...b, state, ...(state !== "waiting" ? { wait: undefined } : {}) });
        });
    }
    saveRun(run: ExecutionSnapshot) {
        this.atomic(() => this.db.prepare("INSERT INTO runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(run.runId, JSON.stringify(run)));
    }
    runs(): ExecutionSnapshot[] { return this.db.prepare("SELECT json FROM runs ORDER BY rowid").all().map(r => decode<ExecutionSnapshot>(r)!); }
    event(event: BackgroundEvent): BackgroundEvent {
        return this.atomic(() => {
            this.saveRun(event.snapshot);
            this.db.prepare("INSERT INTO events(id,json) VALUES (?,?) ON CONFLICT(id) DO NOTHING").run(event.eventId, JSON.stringify(event));
            const row = this.db.prepare("SELECT seq,json FROM events WHERE id=?").get(event.eventId) as {
                seq: number;
                json: string;
            };
            return { ...JSON.parse(row.json), seq: Number(row.seq) };
        });
    }
    pendingEvents(): BackgroundEvent[] {
        return this.db.prepare("SELECT seq,json FROM events WHERE delivered IS NULL ORDER BY seq").all().map(r => ({ ...decode<BackgroundEvent>(r)!, seq: Number((r as {
                seq: number;
            }).seq) }));
    }
    delivered(id: string) { return !!this.db.prepare("SELECT id FROM events WHERE id=? AND delivered IS NOT NULL").get(id); }
    addAttachment(file: string, hash: string) {
        this.atomic(() => { const files = this.readMeta<Record<string, string>>("attachments") ?? {}; files[file] = hash; this.putMeta("attachments", files); });
    }
    missingAttachments(): string[] {
        return Object.entries(this.readMeta<Record<string, string>>("attachments") ?? {}).filter(([file, hash]) => {
            try {
                return createHash("sha256").update(readFileSync(file)).digest("hex") !== hash;
            }
            catch {
                return true;
            }
        }).map(([file]) => file);
    }
    setLaunch(runId: string, data: Record<string, unknown>) { this.atomic(() => this.putMeta(`launch:${runId}`, { ...this.launch<Record<string, unknown>>(runId), ...data })); }
    launch<T>(runId: string) { return this.readMeta<T>(`launch:${runId}`); }
    beforeTool(record: Omit<ToolRecord, "state">, sideEffect: boolean): ToolMessage | undefined {
        return this.atomic(() => {
            const existing = decode<ToolRecord>(this.db.prepare("SELECT json FROM tools WHERE scope=? AND id=?").get(record.scope, record.id));
            if (existing?.state === "result_committed")
                return existing.result;
            if (existing || (sideEffect && (this.unresolved().length || this.runs().some(r => r.status === "unknown"))))
                throw new Error("存在结果未知的操作。请先通过 /recovery 查看并只读核实；未决工具由用户通过 /recovery resolve 处理，unknown 后台任务通过 /recovery decide 处理后再执行。");
            this.db.prepare("INSERT INTO tools VALUES (?,?,?)").run(record.scope, record.id, JSON.stringify({ ...record, state: "started" }));
            return undefined;
        });
    }
    afterTool(scope: string, id: string, result: ToolMessage) {
        this.atomic(() => {
            const record = decode<ToolRecord>(this.db.prepare("SELECT json FROM tools WHERE scope=? AND id=?").get(scope, id));
            if (!record)
                throw new Error("缺少工具执行意图。");
            this.db.prepare("UPDATE tools SET json=? WHERE scope=? AND id=?").run(JSON.stringify({ ...record, state: "result_committed", result }), scope, id);
        });
    }
    toolRecords(): ToolRecord[] { return this.db.prepare("SELECT json FROM tools").all().map(r => decode<ToolRecord>(r)!); }
    unresolved() { return this.toolRecords().filter(r => r.state === "outcome_unknown"); }
    markInterruptedTools(scope?: string) {
        this.atomic(() => { for (const r of this.toolRecords())
            if (r.state === "started" && (scope === undefined || r.scope === scope))
                this.db.prepare("UPDATE tools SET json=? WHERE scope=? AND id=?").run(JSON.stringify({ ...r, state: "outcome_unknown" }), r.scope, r.id); });
    }
    resolveTool(scope: string, id: string, explanation: string) {
        if (!explanation.trim())
            throw new Error("请明确填写核实结果或处理决定。");
        const record=this.toolRecords().find(r=>r.scope===scope&&r.id===id);
        if(record?.state!=="outcome_unknown")throw new Error("只允许处理尚未核实的操作。");
        this.afterTool(scope, id, { role: "tool", tool_call_id: id, content: `[用户处理未决操作] ${explanation}` });
    }
    saveAgent(record: AgentRecord) { this.atomic(() => this.db.prepare("INSERT INTO agents VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET json=excluded.json").run(record.runId, record.taskId, JSON.stringify(record))); }
    agents(): AgentRecord[] { return this.db.prepare("SELECT json FROM agents ORDER BY rowid").all().map(r => decode<AgentRecord>(r)!); }
    close() {
        if (this.closed)
            return;
        try {
            this.atomic(() => this.putMeta("owner", null));
        }
        finally {
            this.closed = true;
            this.db.close();
        }
    }
}
export function readDurableState(dir: string): PersistedState | undefined {
    const file = path.join(dir, "session.db");
    if (!existsSync(file))
        return undefined;
    const db = openSqlite(file, true);
    try {
        if ((db.prepare("PRAGMA user_version").get() as {
            user_version: number;
        }).user_version > SCHEMA_VERSION)
            throw new Error("会话版本不兼容。");
        const state = decode<PersistedState>(db.prepare("SELECT json FROM meta WHERE key='checkpoint'").get());
        if (!state)
            throw new Error("会话缺少可信检查点，不能恢复为空会话。");
        return state;
    }
    finally {
        db.close();
    }
}
