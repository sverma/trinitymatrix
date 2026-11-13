const maximumDiagnosticBytes = 16_384;
const keywords = {
  maxItems: ["maxItems", "max_items"], minItems: ["minItems", "min_items"],
  enum: ["enum"], type: ["type"], nullable: ["nullable"],
  response_schema: ["response_schema"], response_format: ["response_format"],
  reasoning: ["reasoning"], thinking: ["thinking"], max_tokens: ["max_tokens"],
  required: ["required"], additionalProperties: ["additionalProperties", "additional_properties"]
} as const;
const allowedCodes = new Set([
  "invalid_request", "invalid_request_error", "bad_request", "validation_error", "model_not_found",
  "insufficient_credits", "rate_limit_exceeded", "INVALID_ARGUMENT", "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "UNAUTHENTICATED", "NOT_FOUND", "INTERNAL",
  "UNAVAILABLE", "DEADLINE_EXCEEDED", "UNKNOWN"
]);
const pathSegments = new Map([
  ...["response_schema", "response_format", "json_schema", "schema", "properties", "action", "cardId", "groups", "memory", "items"].map((value) => [value, value] as const),
  ...Object.entries(keywords).flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical] as const))
]);

export type AiSchemaDiagnostic = {
  type: "ai-schema-diagnostic";
  status: number;
  keywords: string[];
  paths: string[];
  errorCode?: string | number;
  truncated?: true;
  unreadable?: true;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Only allowlisted classifications leave this function; source text stays in memory. */
function classify(status: number, source: string): AiSchemaDiagnostic {
  const diagnostic: AiSchemaDiagnostic = { type: "ai-schema-diagnostic", status, keywords: [], paths: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return { ...diagnostic, unreadable: true }; }
  const texts: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 2) return;
    const root = record(value);
    if (!root) return;
    const error = record(root.error) ?? root;
    for (const code of [error.code, error.status]) {
      if (diagnostic.errorCode !== undefined) break;
      if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) diagnostic.errorCode = code;
      else if (typeof code === "string" && allowedCodes.has(code)) diagnostic.errorCode = code;
    }
    if (typeof error.message === "string") texts.push(error.message);
    const raw = record(error.metadata)?.raw;
    if (typeof raw === "string") {
      texts.push(raw);
      try { visit(JSON.parse(raw), depth + 1); } catch { /* Classify only fixed keywords in non-JSON raw diagnostics. */ }
    } else if (record(raw)) {
      texts.push(JSON.stringify(raw));
      visit(raw, depth + 1);
    }
  };
  visit(parsed, 0);
  const text = texts.join("\n");
  diagnostic.keywords = Object.entries(keywords).filter(([_name, aliases]) =>
    aliases.some((alias) => new RegExp(`\\b${alias}\\b`, "i").test(text))
  ).map(([name]) => name);
  const paths = new Set<string>();
  const pathPattern = /\b(?:response_schema|response_format)(?:(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)|(?:\s*\[\s*(?:"[^"]*"|'[^']*'|[A-Za-z_][A-Za-z0-9_]*|[0-9]+)\s*\]))+/g;
  for (const match of text.matchAll(pathPattern)) {
    const parts = match[0].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    if (parts.length && parts.every((part) => pathSegments.has(part))) {
      paths.add(parts.map((part) => pathSegments.get(part)!).join("."));
    }
  }
  diagnostic.paths = [...paths].slice(0, 12);
  return diagnostic;
}

async function diagnose(response: Response): Promise<AiSchemaDiagnostic> {
  const base: AiSchemaDiagnostic = { type: "ai-schema-diagnostic", status: response.status, keywords: [], paths: [] };
  const reader = response.clone().body?.getReader();
  if (!reader) return { ...base, unreadable: true };
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let timer: NodeJS.Timeout | undefined;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const read = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximumDiagnosticBytes) { cancel(); return { ...base, truncated: true as const }; }
        chunks.push(value);
      }
      return classify(response.status, Buffer.concat(chunks, bytes).toString("utf8"));
    } catch { return { ...base, unreadable: true as const }; }
  };
  try {
    return await Promise.race([read(), new Promise<AiSchemaDiagnostic>((resolve) => {
      timer = setTimeout(() => { cancel(); resolve({ ...base, unreadable: true }); }, 1_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Used only by the operator CLI's opt-in flag, never by the public game runtime. */
export function createSchemaDiagnosticFetch(fetcher: typeof fetch, emit: (diagnostic: AiSchemaDiagnostic) => void): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.ok) {
      const diagnostic = await diagnose(response);
      try { emit(diagnostic); } catch { /* Diagnostic output cannot change the provider result. */ }
    }
    return response;
  };
}
