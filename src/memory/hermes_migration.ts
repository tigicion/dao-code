import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicText, codepoints, DELIMITER, CuratedMemoryStore } from "./curated_store.js";
import { parseMemoryFile } from "./frontmatter.js";
import { memoryThreat } from "./threat_patterns.js";
import { openSqlite, transaction } from "../session/sqlite.js";
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export interface MigrationRecord {
    id: string;
    source: string;
    raw: string;
    metadata: unknown;
    destination: "user" | "memory" | "skill" | "archive" | "pending";
    text?: string;
    skill?: string;
    reason: string;
}
export interface MigrationPlan {
    version: 1;
    id: string;
    workspace: string;
    home: string;
    created: string;
    sources: {
        file: string;
        hash: string;
        kind: "file" | "sqlite";
    }[];
    records: MigrationRecord[];
    targets: {
        memory: string;
        user: string;
        skills: Record<string, string>;
    };
    targetBefore: Record<string, string | null>;
}
function mem0Rows(file: string) { const db = openSqlite(file, true); try {
    return db.prepare("SELECT id,payload FROM vectors ORDER BY id").all() as {
        id: string;
        payload: string;
    }[];
}
finally {
    db.close();
} }
export function planMigration(home: string, workspace: string, legacyHome = home): MigrationPlan {
    const records: MigrationRecord[] = [], sources: MigrationPlan["sources"] = [];
    for (const dir of [path.join(legacyHome, "memory"), path.join(legacyHome, "knowledge"), path.join(workspace, ".dao", "memory")]) {
        if (!existsSync(dir))
            continue;
        for (const file of readdirSync(dir).filter(f => f.endsWith(".md") || f.endsWith(".json")).sort()) {
            const source = path.join(dir, file), raw = readFileSync(source, "utf8");
            sources.push({ file: source, hash: sha256(raw), kind: "file" });
            const metadata = file.endsWith(".md") ? parseMemoryFile(file.slice(0, -3), raw) : undefined;
            records.push({ id: sha256(source + "\0" + raw), source, raw, metadata: metadata ?? null, destination: "archive", text: metadata?.text, reason: metadata?.locked ? "Protected legacy record; retained unchanged, requires explicit mapping" : "Preserved in full; review destination before activating" });
        }
    }
    const vectors = path.join(legacyHome, "mem0", "vectors.db");
    if (existsSync(vectors)) {
        const rows = mem0Rows(vectors);
        sources.push({ file: vectors, hash: sha256(JSON.stringify(rows)), kind: "sqlite" });
        for (const row of rows) {
            const metadata = JSON.parse(row.payload);
            records.push({ id: sha256(vectors + "\0" + row.id), source: `${vectors}#${row.id}`, raw: row.payload, metadata, destination: "archive", reason: "Mem0 payload preserved, including identity and metadata; explicit mapping required" });
        }
    }
    const targets = { memory: "", user: "", skills: {} };
    const targetBefore: Record<string, string | null> = {};
    for (const [name, file] of [["memory", "MEMORY.md"], ["user", "USER.md"]] as const) {
        const f = path.join(home, "memories", file);
        const raw = existsSync(f) ? readFileSync(f, "utf8") : null;
        targetBefore[f] = raw;
        targets[name] = raw ?? "";
    }
    return { version: 1, id: randomUUID(), workspace, home, created: new Date().toISOString(), sources, records, targets, targetBefore };
}
export function migrationDigest(plan: MigrationPlan) { return sha256(JSON.stringify(plan)); }
function checkPlan(plan: MigrationPlan, store: CuratedMemoryStore) {
    const exportFile = path.join(plan.home, "migrations", "hermes-memory", plan.id, "export.json");
    if (existsSync(exportFile)) {
        const original = JSON.parse(readFileSync(exportFile, "utf8")) as {
            records: MigrationRecord[];
        };
        if (original.records.length !== plan.records.length || original.records.some(r => !plan.records.some(p => p.id === r.id && p.raw === r.raw)))
            throw new Error("Migration source coverage changed; retain every original record");
    }
    if (path.resolve(plan.home) !== path.resolve(store.home))
        throw new Error("Migration profile mismatch");
    if (new Set(plan.records.map(r => r.id)).size !== plan.records.length)
        throw new Error("Duplicate source mapping");
    for (const source of plan.sources) {
        const raw = source.kind === "sqlite" ? JSON.stringify(mem0Rows(source.file)) : readFileSync(source.file, "utf8");
        if (sha256(raw) !== source.hash)
            throw new Error(`Source changed: ${source.file}`);
    }
    for (const t of ["memory", "user"] as const) {
        if (codepoints(plan.targets[t]) > store.limit(t))
            throw new Error(`${t} exceeds budget`);
        if (memoryThreat(plan.targets[t]))
            throw new Error(`Unsafe ${t} contents`);
    }
    for (const r of plan.records) {
        if (r.destination === "pending")
            throw new Error(`Unresolved record: ${r.id}`);
        if ((r.destination === "memory" || r.destination === "user") && (!r.text || !plan.targets[r.destination].split(DELIMITER).includes(r.text)))
            throw new Error(`Activated record not present in target: ${r.id}`);
        if (r.destination === "skill" && (!r.skill || !plan.targets.skills[r.skill]))
            throw new Error(`Missing skill mapping: ${r.id}`);
    }
    for (const [name, content] of Object.entries(plan.targets.skills)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name) || memoryThreat(content) || !content.startsWith("---\n"))
            throw new Error("Invalid migration skill");
    }
}
export function saveMigrationPlan(plan: MigrationPlan) { const dir = path.join(plan.home, "migrations", "hermes-memory", plan.id); mkdirSync(dir, { recursive: true, mode: 0o700 }); const file = path.join(dir, "plan.json"); atomicText(file, JSON.stringify(plan, null, 2)); atomicText(path.join(dir, "export.json"), JSON.stringify({ sources: plan.sources, records: plan.records }, null, 2)); return { file, digest: migrationDigest(plan), records: plan.records.length }; }
export function applyMigration(plan: MigrationPlan, accepted: string, store: CuratedMemoryStore, offline: boolean) {
    if (!offline)
        throw new Error("Stop old Dao writers first, then pass --offline");
    if (accepted !== migrationDigest(plan))
        throw new Error("Accept the exact reviewed plan digest; plan changed or digest missing");
    const dir = path.join(plan.home, "migrations", "hermes-memory", plan.id), journalFile = path.join(dir, "journal.json");
    return transaction(store.db, () => {
        const leaseTable = store.db.prepare("SELECT name FROM sqlite_master WHERE name='memory_leases'").get();
        if (leaseTable)
            for (const row of store.db.prepare("SELECT id,pid FROM memory_leases").all() as {
                id: string;
                pid: number;
            }[]) {
                let alive = true;
                try {
                    process.kill(row.pid, 0);
                }
                catch (e) {
                    alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
                }
                if (alive)
                    throw new Error(`Dao runtime ${row.pid} is still active; stop it before migration`);
                store.db.prepare("DELETE FROM memory_leases WHERE id=?").run(row.id);
            }
        checkPlan(plan, store);
        const items: Record<string, string> = { [store.file("memory")]: plan.targets.memory, [store.file("user")]: plan.targets.user };
        for (const [name, content] of Object.entries(plan.targets.skills))
            items[path.join(store.home, "skills", name, "SKILL.md")] = content;
        let journal: {
            digest: string;
            status: string;
            before: Record<string, string | null>;
            after: Record<string, string>;
            done: string[];
        } = { digest: accepted, status: "applying", before: { ...plan.targetBefore }, after: items, done: [] };
        if (existsSync(journalFile)) {
            journal = JSON.parse(readFileSync(journalFile, "utf8"));
            if (journal.digest !== accepted)
                throw new Error("Existing journal belongs to a different plan");
            if (journal.status === "complete")
                return { alreadyApplied: true };
            if (journal.status !== "applying")
                throw new Error("Migration journal is not resumable");
        }
        // Verify ALL destinations before touching ANY of them; on recovery permit only before/after bytes.
        for (const [file, after] of Object.entries(items)) {
            const current = existsSync(file) ? readFileSync(file, "utf8") : null;
            if (!(file in journal.before))
                journal.before[file] = null;
            if (current !== journal.before[file] && current !== after)
                throw new Error(`Destination drift: ${file}`);
        }
        atomicText(journalFile, JSON.stringify(journal, null, 2));
        for (const [file, after] of Object.entries(items)) {
            atomicText(file, after);
            if (!journal.done.includes(file))
                journal.done.push(file);
            atomicText(journalFile, JSON.stringify(journal, null, 2));
        }
        for (const name of Object.keys(plan.targets.skills))
            store.setState(`skill:${name}`, { source: "user", created: Date.now(), lastUsed: Date.now(), pinned: false });
        store.setState("legacy_migration_complete", true);
        journal.status = "complete";
        atomicText(journalFile, JSON.stringify(journal, null, 2));
        store.audit({ event: "migration", id: plan.id, digest: accepted, records: plan.records.length });
        return { success: true, records: plan.records.length, archived: plan.records.filter(r => r.destination === "archive").length };
    });
}
export function verifyMigration(plan: MigrationPlan, store: CuratedMemoryStore) { checkPlan(plan, store); for (const t of ["memory", "user"] as const)
    if (readFileSync(store.file(t), "utf8") !== plan.targets[t])
        throw new Error(`Target differs: ${t}`); for (const [name, content] of Object.entries(plan.targets.skills))
    if (readFileSync(path.join(store.home, "skills", name, "SKILL.md"), "utf8") !== content)
        throw new Error(`Skill differs: ${name}`); return { success: true, total: plan.records.length, activated: plan.records.filter(r => ["user", "memory", "skill"].includes(r.destination)).length }; }
export function rollbackMigration(plan: MigrationPlan, store: CuratedMemoryStore, accepted: string, offline: boolean) {
    if (!offline || accepted !== migrationDigest(plan))
        throw new Error("Rollback requires --offline and the accepted plan digest");
    const dir = path.join(plan.home, "migrations", "hermes-memory", plan.id), file = path.join(dir, "journal.json");
    return transaction(store.db, () => {
        const journal = JSON.parse(readFileSync(file, "utf8")) as {
            status: string;
            before: Record<string, string | null>;
            after: Record<string, string>;
        };
        if (journal.status !== "complete")
            throw new Error("Only a completed migration can be rolled back");
        const delta = Object.fromEntries(Object.keys(journal.after).map(f => [f, existsSync(f) ? readFileSync(f, "utf8") : null]));
        atomicText(path.join(dir, `post-migration-${Date.now()}.json`), JSON.stringify(delta, null, 2));
        // Retain all new state; rollback produces a separate snapshot for an operator-selected old binary.
        atomicText(path.join(dir, "rollback-snapshot.json"), JSON.stringify(journal.before, null, 2));
        store.audit({ event: "rollback_export", id: plan.id });
        return { success: true, snapshot: path.join(dir, "rollback-snapshot.json"), note: "New state retained. Restore the separate old-version snapshot with the old binary; upgraded sessions cannot be downgraded." };
    });
}
