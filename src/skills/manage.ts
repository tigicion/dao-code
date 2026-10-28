import { mkdirSync, existsSync, readFileSync, readdirSync, lstatSync, cpSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicText, type CuratedMemoryStore } from "../memory/curated_store.js";
import { memoryThreat } from "../memory/threat_patterns.js";
import { transaction } from "../session/sqlite.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export interface SkillMeta {
    created: number;
    lastUsed: number;
    source: "agent" | "user" | "external";
    pinned: boolean;
    archived?: string;
    stale?: boolean;
}
export class SkillRepository {
    readonly root: string;
    constructor(readonly control: CuratedMemoryStore) { this.root = path.join(control.home, "skills"); mkdirSync(this.root, { recursive: true, mode: 0o700 }); control.db.exec("CREATE TABLE IF NOT EXISTS skill_proposals(id TEXT PRIMARY KEY,json TEXT NOT NULL,status TEXT NOT NULL)"); }
    private safeName(name: string) { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name))
        throw new Error("Invalid skill slug"); return name; }
    private location(name: string, file = "SKILL.md") {
        const root = path.resolve(this.root, this.safeName(name));
        if (path.isAbsolute(file) || file.split(/[\\/]/).some(s => s === ".." || s.startsWith(".")))
            throw new Error("Invalid skill relative path");
        const result = path.resolve(root, file);
        if (!result.startsWith(root + path.sep))
            throw new Error("Skill path escape");
        let dir = result;
        while (dir.startsWith(this.root) && dir !== this.root) {
            if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
                throw new Error("Symlink skill paths are not writable");
            dir = path.dirname(dir);
        }
        if (lstatSync(this.root).isSymbolicLink())
            throw new Error("Managed skills root must not be a symlink");
        return result;
    }
    metadata(name: string) { return this.control.state<SkillMeta | undefined>(`skill:${name}`, undefined); }
    list() { return readdirSync(this.root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith(".") && existsSync(path.join(this.root, d.name, "SKILL.md"))).map(d => ({ name: d.name, ...this.metadata(d.name) })); }
    view(name: string, file = "SKILL.md") { return readFileSync(this.location(name, file), "utf8"); }
    used(name: string, now = Date.now()) { const m = this.metadata(name); if (m)
        this.control.setState(`skill:${name}`, { ...m, lastUsed: now, stale: false }); }
    mutate(args: {
        action: "create" | "write" | "patch" | "remove_file" | "delete";
        name: string;
        file?: string;
        content?: string;
        old_text?: string;
    }, opts: {
        background?: boolean;
        readHashes?: Map<string, string>;
        signal?: AbortSignal;
    } = {}) {
        return transaction(this.control.db, () => {
            if (opts.signal?.aborted)
                throw new Error("Canceled");
            const file = args.file ?? "SKILL.md", target = this.location(args.name, file), root = path.dirname(this.location(args.name));
            const meta = this.metadata(args.name), exists = existsSync(root);
            if (args.action === "create" && exists)
                throw new Error("Skill already exists; read it before editing");
            if (args.action !== "create" && !exists)
                throw new Error("Skill not found");
            if (args.action === "delete" && meta?.pinned)
                throw new Error("Pinned skill cannot be deleted");
            if (opts.background && exists && meta?.source !== "agent")
                throw new Error("Background review may only edit agent-created skills");
            const before = existsSync(target) ? readFileSync(target, "utf8") : "";
            if (exists && args.action !== "create" && opts.readHashes?.get(`${args.name}/${file}`) !== hash(before))
                throw new Error("Read the current skill file before editing (content changed or not read)");
            let after = args.content ?? "";
            if (args.action === "patch") {
                const old = args.old_text;
                if (!old || before.indexOf(old) < 0 || before.indexOf(old) !== before.lastIndexOf(old))
                    throw new Error("Patch must match one exact span");
                after = before.replace(old, () => after);
            }
            if (["create", "write", "patch"].includes(args.action)) {
                if (!after.trim())
                    throw new Error("Empty skill content");
                if (memoryThreat(after))
                    throw new Error(`Blocked skill content: ${memoryThreat(after)}`);
                if (file === "SKILL.md" && (!after.startsWith("---\n") || !/\nname:\s*\S/.test(after) || !/\ndescription:\s*\S/.test(after)))
                    throw new Error("SKILL.md requires name and description frontmatter");
            }
            if (args.action === "remove_file" && file === "SKILL.md")
                throw new Error("Use delete to archive a whole skill");
            const id = randomUUID(), backup = path.join(this.root, ".curator_backups", id);
            if (exists) {
                this.assertPackage(root);
                mkdirSync(path.dirname(backup), { recursive: true });
                cpSync(root, backup, { recursive: true });
            }
            this.control.audit({ event: "skill_intent", id, action: args.action, name: args.name, file, backup: exists ? backup : undefined, before: hash(before) });
            if (args.action === "delete") {
                const archived = path.join(this.root, ".archive", id);
                mkdirSync(path.dirname(archived), { recursive: true });
                renameSync(root, archived);
                this.control.setState(`skill:${args.name}`, { ...meta, archived });
            }
            else if (args.action === "remove_file")
                rmSync(target);
            else {
                atomicText(target, after);
                this.control.setState(`skill:${args.name}`, meta ?? { created: Date.now(), lastUsed: Date.now(), source: "agent", pinned: false });
            }
            this.control.audit({ event: "skill_commit", id, name: args.name, file, after: hash(after) });
            return { success: true, id, name: args.name };
        });
    }
    consolidate(name: string, sources: string[], content: string, reads: Map<string, string>, signal?: AbortSignal) {
        this.safeName(name);
        if (sources.length < 2 || new Set(sources).size !== sources.length || sources.includes(name))
            throw new Error("Choose a new target and at least two distinct source skills");
        if (existsSync(path.join(this.root, name)))
            throw new Error("Consolidation target must be new");
        if (memoryThreat(content) || !content.startsWith("---\n"))
            throw new Error("Invalid consolidation content");
        return transaction(this.control.db, () => {
            for (const source of sources) {
                const meta = this.metadata(source);
                if (!meta || meta.source !== "agent" || meta.pinned || meta.archived)
                    throw new Error("Only unpinned agent-created skills may be consolidated");
                if (reads.get(`${source}/SKILL.md`) !== hash(this.view(source)))
                    throw new Error("Read every source skill before consolidation");
                this.assertPackage(path.dirname(this.location(source)));
            }
            if (signal?.aborted)
                throw new Error("Canceled");
            const id = randomUUID(), staging = path.join(this.root, `.merge-${id}`), backup = path.join(this.root, ".curator_backups", id);
            mkdirSync(staging, { recursive: true });
            mkdirSync(backup, { recursive: true });
            try {
                for (const source of sources) {
                    cpSync(path.dirname(this.location(source)), path.join(staging, "merged", source), { recursive: true });
                    cpSync(path.dirname(this.location(source)), path.join(backup, source), { recursive: true });
                }
                const links = sources.map(source => `- [${source}](merged/${source}/SKILL.md)`).join("\n");
                atomicText(path.join(staging, "SKILL.md"), `${content}\n\n## Preserved source packages\n${links}\n`);
                renameSync(staging, path.join(this.root, name));
                this.control.setState(`skill:${name}`, { source: "agent", created: Date.now(), lastUsed: Date.now(), pinned: false });
                this.control.audit({ event: "skill_consolidate", id, name, sources, backup });
            }
            finally {
                if (existsSync(staging))
                    rmSync(staging, { recursive: true });
            }
            return { success: true, name, sources_preserved: true, note: "All source packages retained, including relative supporting-file links. Read and verify the new skill before separately archiving redundant source skills." };
        });
    }
    propose(args: Parameters<SkillRepository["mutate"]>[0], reads?: Map<string, string>) {
        const target = this.location(args.name, args.file ?? "SKILL.md");
        const before = existsSync(target) ? readFileSync(target, "utf8") : null;
        const id = randomUUID();
        this.control.db.prepare("INSERT INTO skill_proposals VALUES (?,?,?)").run(id, JSON.stringify({ args, before, reads: [...(reads ?? new Map())] }), "pending");
        return { success: true, staged: true, pending_id: id };
    }
    pending() { return (this.control.db.prepare("SELECT id,json,status FROM skill_proposals WHERE status IN ('pending','applying') ORDER BY rowid").all() as {
        id: string;
        json: string;
        status: string;
    }[]).map(r => ({ id: r.id, kind: "skill", status: r.status, ...JSON.parse(r.json) })); }
    resolve(id: string, approve: boolean) {
        const row = this.control.db.prepare("SELECT json,status FROM skill_proposals WHERE id=?").get(id) as {
            json: string;
            status: string;
        } | undefined;
        if (!row || row.status !== "pending")
            throw new Error("Skill proposal missing or already applying");
        if (!approve) {
            this.control.db.prepare("UPDATE skill_proposals SET status='rejected' WHERE id=?").run(id);
            return { success: true };
        }
        const p = JSON.parse(row.json) as {
            args: Parameters<SkillRepository["mutate"]>[0];
            before: string | null;
            reads: [
                string,
                string
            ][];
        };
        const target = this.location(p.args.name, p.args.file ?? "SKILL.md"), now = existsSync(target) ? readFileSync(target, "utf8") : null;
        if (now !== p.before)
            throw new Error("Skill changed after proposal was staged");
        const claimed = transaction(this.control.db, () => { const r = this.control.db.prepare("SELECT status FROM skill_proposals WHERE id=?").get(id) as {
            status: string;
        }; if (r.status !== "pending")
            return false; this.control.db.prepare("UPDATE skill_proposals SET status='applying' WHERE id=?").run(id); return true; });
        if (!claimed)
            throw new Error("Skill proposal already claimed");
        const reads = new Map(p.reads);
        reads.set(`${p.args.name}/${p.args.file ?? "SKILL.md"}`, hash(now ?? ""));
        try {
            const result = this.mutate(p.args, { readHashes: reads });
            this.control.db.prepare("UPDATE skill_proposals SET status='approved' WHERE id=?").run(id);
            return result;
        }
        catch (e) {
            this.control.db.prepare("UPDATE skill_proposals SET status='pending' WHERE id=?").run(id);
            throw e;
        }
    }
    hashRead(name: string, file: string, reads: Map<string, string>) { const text = this.view(name, file); reads.set(`${name}/${file}`, hash(text)); return text; }
    private assertPackage(root: string) { for (const d of readdirSync(root, { withFileTypes: true })) {
        if (d.isSymbolicLink())
            throw new Error("Cannot manage skill package containing symlinks");
        if (d.isDirectory())
            this.assertPackage(path.join(root, d.name));
    } }
    pin(name: string, pinned: boolean) { this.safeName(name); const m = this.metadata(name); if (!m)
        throw new Error("Unknown provenance; cannot auto-manage this skill"); this.control.setState(`skill:${name}`, { ...m, pinned }); }
    restore(name: string, backup?: string) {
        this.safeName(name);
        const m = this.metadata(name);
        const source = backup ? path.join(this.root, ".curator_backups", this.safeName(backup)) : m?.archived;
        if (!source || !existsSync(source))
            throw new Error("No recoverable archive/backup");
        const dest = path.join(this.root, name);
        if (existsSync(dest))
            throw new Error("Restore destination exists; preserve it before restoring");
        this.assertPackage(source);
        cpSync(source, dest, { recursive: true });
        this.control.setState(`skill:${name}`, { ...m, archived: undefined, lastUsed: Date.now() });
        this.control.audit({ event: "skill_restore", name, source });
    }
    curate(opts: {
        now?: number;
        lastActivity: number;
        references?: string[];
        dryRun?: boolean;
        intervalHours?: number;
        idleHours?: number;
        staleDays?: number;
        archiveDays?: number;
    }) {
        const now = opts.now ?? Date.now(), last = this.control.state<number>("curator_last", 0), day = 86400000;
        if (!last) {
            if (!opts.dryRun)
                this.control.setState("curator_last", now);
            return { seeded: true, actions: [] };
        }
        if (now - last < (opts.intervalHours ?? 168) * 3600000 || now - opts.lastActivity < (opts.idleHours ?? 2) * 3600000)
            return { actions: [], waiting: true };
        const actions: object[] = [];
        for (const item of this.list()) {
            const m = this.metadata(item.name);
            if (!m || m.source !== "agent" || m.pinned || opts.references?.some(s => s.includes(item.name)))
                continue;
            const age = now - m.lastUsed;
            if (age >= (opts.archiveDays ?? 30) * day) {
                actions.push({ name: item.name, action: "archive" });
                if (!opts.dryRun) {
                    const reads = new Map<string, string>();
                    this.hashRead(item.name, "SKILL.md", reads);
                    this.mutate({ action: "delete", name: item.name }, { readHashes: reads });
                }
            }
            else if (age >= (opts.staleDays ?? 14) * day) {
                actions.push({ name: item.name, action: "stale" });
                if (!opts.dryRun)
                    this.control.setState(`skill:${item.name}`, { ...m, stale: true });
            }
        }
        if (!opts.dryRun)
            this.control.setState("curator_last", now);
        return { actions };
    }
}
