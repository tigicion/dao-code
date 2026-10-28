import type { StreamChatOptions, StreamDelta, AssistantMessage, ChatMessage } from "../client/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { ApprovalGate } from "../approval/types.js";
import { estimateTokens } from "../agent/compact.js";
export type ReviewStream = (options: StreamChatOptions) => AsyncGenerator<StreamDelta, AssistantMessage>;
export async function executeReview(opts: {
    request: StreamChatOptions;
    stream: ReviewStream;
    registry: ToolRegistry;
    ctx: ToolContext;
    gate: ApprovalGate;
    signal: AbortSignal;
    memory: boolean;
    skills: boolean;
    maxIterations: number;
    inputBudget: number;
    instruction?: string;
    onResult: (data: Record<string, unknown>) => void;
}) {
    const messages: ChatMessage[] = structuredClone(opts.request.messages);
    messages.push({ role: "user", origin: "background_review", content: opts.instruction ?? `Review this completed work privately. Save only durable learning; no change is a valid outcome. ${opts.memory ? "Use memory for compact facts applicable to EVERY session; use one atomic operations batch per target." : "Do not write memory in this skill-only review."} ${opts.skills ? "Use skills_list / skill_view before skill_manage. Put reusable task procedures, corrections and pitfalls in the appropriate skill; preserve supporting files. Do not store task diaries." : "Do not create or edit skills in this review."} Never execute code, send messages, delegate work, or perform the original task. Background deletions/patches to memory are proposals for human review.` });
    const allowed = new Set([...(opts.memory ? ["memory"] : []), ...(opts.skills ? ["skills_list", "skill_view", "skill_manage"] : [])]);
    let input = 0, output = 0, iterations = 0;
    try {
        for (; iterations < opts.maxIterations && !opts.signal.aborted; iterations++) {
            if (input + estimateTokens(messages) > opts.inputBudget)
                break;
            let charged = false;
            const stream = opts.stream({ ...opts.request, messages, signal: opts.signal, background: true, onUsage: u => {
                    charged = true;
                    input += u.prompt_tokens;
                    output += u.completion_tokens;
                    opts.request.onUsage?.(u);
                } });
            let r = await stream.next();
            while (!r.done) {
                if (opts.signal.aborted) {
                    await stream.return({ role: "assistant", content: null });
                    return;
                }
                r = await stream.next();
            }
            if (!charged)
                input += estimateTokens(messages);
            if (opts.signal.aborted)
                return;
            const assistant = r.value;
            messages.push(assistant);
            if (!assistant.tool_calls?.length)
                break;
            for (const call of assistant.tool_calls) {
                if (opts.signal.aborted)
                    return;
                let result: string;
                const tool = opts.registry.get(call.function.name);
                if (!tool || !allowed.has(call.function.name))
                    result = "Denied: tool not available to background review.";
                else if (opts.gate.decide(tool.name, call.function.arguments, tool) !== "allow")
                    result = "Denied: background review cannot obtain interactive permission.";
                else {
                    try {
                        result = await opts.registry.dispatch(tool.name, call.function.arguments, { ...opts.ctx, signal: opts.signal, memoryActor: "background_review", skillReadHashes: opts.ctx.skillReadHashes ?? new Map() });
                    }
                    catch (e) {
                        result = `Error: ${(e as Error).message}`;
                    }
                }
                messages.push({ role: "tool", tool_call_id: call.id, content: result, origin: "background_review" });
            }
        }
    }
    finally {
        opts.onResult({ event: "background_review", iterations, input_tokens: input, output_tokens: output, canceled: opts.signal.aborted });
    }
}
