# Hermes memory provenance

Upstream: https://github.com/NousResearch/hermes-agent
Pinned commit: `1ae3c55e4bb16f495ebf0536a5672782d903e15e`.
License: MIT, copyright Nous Research; see LICENSE in this directory.

Behavior and patterns ported from:

- tools/memory_tool.py and tools/memory_tool_store.py
- tools/threat_patterns.py
- tools/session_search_tool.py and hermes_state_search.py
- agent/background_review.py, turn_context.py, turn_finalizer.py
- agent/conversation_compression.py, system_prompt.py
- agent/memory_provider.py, memory_manager.py
- skills management and Curator lifecycle

Dao runs the implementation natively in TypeScript. The sibling Python checkout is a development reference and differential-test oracle, not a runtime dependency.

## Explicit Dao adaptations

- Managed file writers serialize with SQLite BEGIN IMMEDIATE; Markdown remains the source of truth. Arbitrary external editors do not participate in the lock.
- Per-session SQLite archives retain Dao execution ownership/tool recovery. A profile-wide FTS projection supports recall; there is no cross-database transaction.
- Internal archive IDs and API/raw message copies are stripped from model wire fields.
- CJK queries use the upstream-style literal fallback; the optional native Hermes tokenizer is not shipped. Ranking is FTS/title/recency with lineage deduplication, not an embedding index.
- Curated memory and skill package changes use Dao's permission gate. Current user instructions and fresh evidence outrank memories. The broad --no-memory flag also disables retrieval and automatic learning.
- Background skills can modify agent-created managed packages; unknown/user/external packages require foreground/operator handling. Skills remain at Dao's existing project/profile locations.
- External plugins use an explicitly configured JavaScript module implementing ExternalMemoryProvider. Python plugins and arbitrary remote services are not automatically compatible. The default provider is disabled.
- Model-assisted consolidation is opt-in. Maintenance never permanently deletes archived packages.
- Existing legacy source readers remain for explicit migration and historical inspection; the production agent does not register MemoryRead/MemoryWrite or invoke the old extraction/GC/merge chain.

## Verification

`src/memory/hermes_differential.test.ts` invokes the pinned upstream Python MemoryStore through `scripts/hermes/store-reference.py`. Only filesystem/config/registration seams are shimmed; operation/matching/budget/scanning logic runs from the upstream source. Set HERMES_SOURCE and HERMES_PYTHON when the sibling checkout or Python executable differs.

Run `npm test`, `npm run typecheck`, `npm run build`, and the isolated Bun smoke check. Tests never activate or migrate the operator's actual memory profile.
