import { z } from "zod";
import { defineTool } from "./types.js";
const operations = z.array(z.object({ action: z.enum(["add", "patch", "remove"]), content: z.string().optional(), old_text: z.string().optional() }).strict()).min(1);
export const memoryTool = defineTool({ name: "memory", description: "Save compact durable facts applying to EVERY session. target user: user profile; memory: environment and standing conventions. One atomic operations batch per target, final character budget. patch replaces one exact old_text span; remove deletes its entry. Task-specific procedures/corrections belong in skill_manage; progress belongs in session_search. Do not repeat a successful write.", schema: z.object({ target: z.enum(["memory", "user"]), operations }).strict(), capability: "write", approval: "auto", async handler(a, ctx) { if (!ctx.memoryRuntime)
        throw new Error("Memory disabled"); return JSON.stringify(ctx.memoryRuntime.write(a.target, a.operations, { background: ctx.memoryActor === "background_review", signal: ctx.signal })); } });
export const sessionSearchTool = defineTool({ name: "session_search", description: "Recall original prior conversation evidence. query discovers sessions; session_id reads first 20 / last 10; around_message_id reads a bounded window; no arguments browses recent sessions. Current active context excluded; compacted history searchable. Keyword/Chinese literal search, not semantic embeddings.", schema: z.object({ query: z.string().optional(), session_id: z.string().optional(), around_message_id: z.string().optional(), limit: z.number().int().min(1).max(20).optional(), role: z.enum(["user", "assistant", "tool"]).optional(), after: z.number().optional(), before: z.number().optional(), workspace: z.string().optional() }).strict(), capability: "read", approval: "auto", async handler(a, ctx) { if (!ctx.memoryRuntime)
        throw new Error("Memory disabled"); return JSON.stringify(ctx.memoryRuntime.history.search({ ...a, currentSession: ctx.memoryRuntime.identity.session })); } });
export const skillsListTool = defineTool({ name: "skills_list", description: "List available skills and agent-managed experience packages before choosing a task skill.", schema: z.object({}), capability: "read", approval: "auto", async handler(_, ctx) { return JSON.stringify({ available: (ctx.skills ?? []).map(s => ({ name: s.name, description: s.description })), managed: ctx.memoryRuntime?.skills.list() ?? [] }); } });
export const skillViewTool = defineTool({ name: "skill_view", description: "Read an agent-managed skill or its supporting file before editing. For installed/project skills use Skill to load their instructions.", schema: z.object({ name: z.string(), file: z.string().default("SKILL.md") }).strict(), capability: "read", approval: "auto", async handler(a, ctx) { if (!ctx.memoryRuntime)
        throw new Error("Memory disabled"); ctx.skillReadHashes ??= new Map(); const text = ctx.memoryRuntime.skills.hashRead(a.name, a.file, ctx.skillReadHashes); ctx.memoryRuntime.skills.used(a.name); return text; } });
export const skillManageTool = defineTool({ name: "skill_manage", description: "Create/update reusable task procedures in a skill package. Read files first. Keep supporting files under this package. delete archives recoverably. Never store task diaries or unrelated global facts. SKILL.md needs YAML name/description frontmatter.", schema: z.object({ action: z.enum(["create", "write", "patch", "remove_file", "delete", "consolidate"]), name: z.string(), sources: z.array(z.string()).optional(), file: z.string().optional(), content: z.string().optional(), old_text: z.string().optional() }).strict(), capability: "write", approval: "auto", async handler(a, ctx) {
        if (!ctx.memoryRuntime)
            throw new Error("Memory disabled");
        if (a.action === "consolidate") {
            if (ctx.memoryRuntime.config.skills.write_approval)
                throw new Error("Consolidation requires operator-reviewed writes; create a reviewed skill proposal instead");
            const result = ctx.memoryRuntime.skills.consolidate(a.name, a.sources ?? [], a.content ?? "", ctx.skillReadHashes ?? new Map(), ctx.signal);
            await ctx.loadInstalledSkills?.("user");
            return JSON.stringify(result);
        }
        if (ctx.memoryRuntime.config.skills.write_approval)
            return JSON.stringify(ctx.memoryRuntime.skills.propose(a as Parameters<typeof ctx.memoryRuntime.skills.propose>[0], ctx.skillReadHashes));
        const result = ctx.memoryRuntime.skills.mutate(a as Parameters<typeof ctx.memoryRuntime.skills.mutate>[0], { background: ctx.memoryActor === "background_review", signal: ctx.signal, readHashes: ctx.skillReadHashes });
        await ctx.loadInstalledSkills?.("user");
        return JSON.stringify(result);
    } });
