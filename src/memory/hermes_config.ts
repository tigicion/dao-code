import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_CURATED } from "./curated_store.js";
export function profileHome(name = "default", base = process.env.DAO_HOME ?? path.join(os.homedir(), ".dao")) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
        throw new Error("Invalid memory profile name");
    return name === "default" ? path.resolve(base) : path.resolve(base, "profiles", name);
}
const positive = z.number().int().positive();
const schema = z.object({
    memory: z.object({ memory_enabled: z.boolean().default(true), user_profile_enabled: z.boolean().default(true), memory_char_limit: positive.default(2200), user_char_limit: positive.default(1375), nudge_interval: positive.default(10), write_approval: z.boolean().default(false), provider: z.string().default(""), provider_module: z.string().optional() }).default(DEFAULT_CURATED),
    skills: z.object({ creation_nudge_interval: positive.default(10), write_approval: z.boolean().default(false) }).default({}),
    background_review: z.object({ enabled: z.boolean().default(true), max_iterations: positive.max(16).default(16) }).default({}),
    curator: z.object({ enabled: z.boolean().default(true), interval_hours: positive.default(168), min_idle_hours: z.number().nonnegative().default(2), stale_after_days: positive.default(14), archive_after_days: positive.default(30), consolidate: z.boolean().default(false) }).default({}),
    compression: z.object({ threshold: z.number().gt(0).lt(1).default(.5), protect_last_n: positive.default(20), min_tail_user_messages: positive.default(1), checkpoint_required: z.boolean().default(false) }).default({})
});
export type HermesConfig = z.infer<typeof schema>;
export function loadHermesConfig(home: string): HermesConfig { let raw: unknown = {}; try {
    raw = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
}
catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw e;
} return schema.parse(raw); }
