// Derived from NousResearch/hermes-agent tools/threat_patterns.py (MIT). See third_party/hermes-memory.
const patterns: [
    string,
    string
][] = [
    [
        "ignore\\s+(?:\\w+\\s+){0,8}(previous|all|above|prior)\\s+(?:\\w+\\s+){0,8}instructions",
        "prompt_injection"
    ],
    [
        "system\\s+prompt\\s+override",
        "sys_prompt_override"
    ],
    [
        "disregard\\s+(?:\\w+\\s+){0,8}(your|all|any)\\s+(?:\\w+\\s+){0,8}(instructions|rules|guidelines)",
        "disregard_rules"
    ],
    [
        "act\\s+as\\s+(if|though)\\s+(?:\\w+\\s+){0,8}you\\s+(?:\\w+\\s+){0,8}(have\\s+no|don\\'t\\s+have)\\s+(?:\\w+\\s+){0,8}(restrictions|limits|rules)",
        "bypass_restrictions"
    ],
    [
        "<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->",
        "html_comment_injection"
    ],
    [
        "<\\s*div\\s+style\\s*=\\s*[\"\\'][^>]{0,2048}display\\s*:\\s*none",
        "hidden_div"
    ],
    [
        "translate\\s+[^\\n]{0,512}\\s+into\\s+\\w+(?:[\\s-]+\\w+){0,2}\\s+and\\s+(execute|run|eval)\\b",
        "translate_execute"
    ],
    [
        "do\\s+not\\s+(?:\\w+\\s+){0,8}tell\\s+(?:\\w+\\s+){0,8}the\\s+user",
        "deception_hide"
    ],
    [
        "you\\s+are\\s+(?:\\w+\\s+){0,8}now\\s+(?:a|an|the)\\s+",
        "role_hijack"
    ],
    [
        "pretend\\s+(?:\\w+\\s+){0,8}(you\\s+are|to\\s+be)\\s+",
        "role_pretend"
    ],
    [
        "output\\s+(?:\\w+\\s+){0,8}(system|initial)\\s+prompt",
        "leak_system_prompt"
    ],
    [
        "(respond|answer|reply)\\s+without\\s+(?:\\w+\\s+){0,8}(restrictions|limitations|filters|safety)",
        "remove_filters"
    ],
    [
        "you\\s+have\\s+been\\s+(?:\\w+\\s+){0,8}(updated|upgraded|patched)\\s+to",
        "fake_update"
    ],
    [
        "\\bname\\s+yourself\\s+\\w+",
        "identity_override"
    ],
    [
        "register\\s+(as\\s+)?a?\\s*node",
        "c2_node_registration"
    ],
    [
        "(heartbeat|beacon|check[\\s\\-]?in)\\s+(to|with)\\s+",
        "c2_heartbeat"
    ],
    [
        "pull\\s+(down\\s+)?(?:new\\s+)?task(?:ing|s)?\\b",
        "c2_task_pull"
    ],
    [
        "connect\\s+to\\s+the\\s+network\\b",
        "c2_network_connect"
    ],
    [
        "you\\s+must\\s+(?:\\w+\\s+){0,3}(register|connect|report|beacon)\\b",
        "forced_action"
    ],
    [
        "only\\s+use\\s+one[\\s\\-]?liners?\\b",
        "anti_forensic_oneliner"
    ],
    [
        "never\\s+(?:\\w+\\s+){0,8}(?:create|write)\\s+(?:\\w+\\s+){0,8}(?:script|file)\\s+(?:\\w+\\s+){0,8}disk",
        "anti_forensic_disk"
    ],
    [
        "unset\\s+\\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\\w*",
        "env_var_unset_agent"
    ],
    [
        "\\b(?:cobalt\\s*strike|sliver|havoc|mythic|metasploit|brainworm)\\b",
        "known_c2_framework"
    ],
    [
        "\\bc2\\s+(?:server|channel|infrastructure|beacon)\\b",
        "c2_explicit"
    ],
    [
        "\\bcommand\\s+and\\s+control\\b",
        "c2_explicit_long"
    ],
    [
        "curl\\s+[^\\n]{0,2048}\\$\\{?\\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\\b",
        "exfil_curl"
    ],
    [
        "wget\\s+[^\\n]{0,2048}\\$\\{?\\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\\b",
        "exfil_wget"
    ],
    [
        "cat\\s+[^\\n]{0,2048}(\\.env|credentials|\\.netrc|\\.pgpass|\\.npmrc|\\.pypirc)",
        "read_secrets"
    ],
    [
        "(send|post|upload|transmit)\\s+[^\\n]{0,2048}\\s+(to|at)\\s+https?://",
        "send_to_url"
    ],
    [
        "(include|output|print|share)\\s+(?:\\w+\\s+){0,8}(conversation|chat\\s+history|previous\\s+messages|full\\s+context|entire\\s+context)",
        "context_exfil"
    ],
    [
        "authorized_keys",
        "ssh_backdoor"
    ],
    [
        "(?:\\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\\b|\\bopen\\s*\\(|>>?)[^\\n]{0,512}(?:\\$HOME/\\.ssh|~/\\.ssh)",
        "ssh_access"
    ],
    [
        "\\$HOME/\\.hermes/\\.env|\\~/\\.hermes/\\.env",
        "hermes_env"
    ],
    [
        "(update|modify|edit|write|change|append|add\\s+to)\\s+[^\\n]{0,2048}(?:AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules)",
        "agent_config_mod"
    ],
    [
        "(update|modify|edit|write|change|append|add\\s+to)\\s+[^\\n]{0,2048}\\.hermes/(config\\.yaml|SOUL\\.md)",
        "hermes_config_mod"
    ]
];
const compiled = patterns.map(([source, id]) => [new RegExp(source, "i"), id] as const);
export function memoryThreat(text: string): string | undefined {
    const raw = Array.from(text).slice(0, 65536).join("");
    if (/[\u200b-\u200d\u2060\u2062-\u2064\ufeff\u202a-\u202e\u2066-\u2069]/u.test(raw))
        return "invisible_unicode";
    const normal = raw.normalize("NFKC");
    for (const [re, id] of compiled)
        if (re.test(normal))
            return id;
    const secret = /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']([A-Za-z0-9+/=_-]{20,})/gi;
    for (const m of normal.matchAll(secret))
        if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(m[1]!))
            return "hardcoded_secret";
    return undefined;
}
