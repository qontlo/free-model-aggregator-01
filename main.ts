// free-model-aggregator-01 — one server, two client wires, ten simulated providers.
//
// The server reads the trial brief (MAKEFUN_PROMPT_FILE), probes every
// provider's own catalog route, registers the catalog with the env, then
// answers the env client's 20 requests one at a time. Each request is
// served by the highest-rated free model that meets its requirements,
// dialled in that provider's own wire (OpenAI, Anthropic or Gemini); a
// refusal fails over to the next candidate. The provider's answer text,
// stop reason and usage counts travel back to the client untouched, in
// the wire the client used.
//
// Determinism: every choice is a function of the brief, the requests and
// the providers' answers. No wall clock, no unseeded randomness anywhere.
//
// Run it:  node main.ts            (reads the brief, registers, serves)
//          node main.ts --list     (prints the catalog document, exits 0)

import http from "node:http";
import fs from "node:fs";

const FIXED_CREATED = 1767225600;
const MAX_DIALS_PER_REQUEST = 8;
const DIAL_TIMEOUT_MS = 20000;
const REGISTER_RETRIES = 5;
const REGISTER_RETRY_MS = 500;
const WORK_POLL_MS = 100;

type Wire = "openai" | "anthropic" | "gemini";

type Provider = {
  id: string;
  name: string;
  wire: Wire;
  auth: string;
  keyEnv: string;
  key: string;
  path: string;
};

type Rating = {
  model: string;
  provider: string;
  rating: number;
  context: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
  order: number;
};

type ManifestRow = {
  id: string;
  api: string;
  stream: boolean;
  weight: number;
  requires: {
    tools?: boolean;
    vision?: boolean;
    json?: boolean;
    minContext?: number;
  };
};

type Brief = {
  providers: Provider[];
  ratings: Rating[];
  manifest: ManifestRow[];
};

type CatalogModel = { id: string; free: boolean; context_length: number | null };
type CatalogProvider = {
  id: string;
  base_url: string;
  key_env: string;
  wire: Wire;
  models: CatalogModel[];
};
type Catalog = { providers: CatalogProvider[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBool(v: unknown): boolean {
  return v === true;
}

// Find one JSON document inside the brief text by its schema marker: the
// marker sits inside the document, so scan back to its opening brace and
// brace-match forward, respecting strings and escapes.
function findDoc(text: string, schema: string): unknown {
  const marker = `"schema":"${schema}"`;
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`brief has no ${schema} document`);
  const open = text.lastIndexOf("{", at);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(open, i + 1));
    }
  }
  throw new Error(`brief ${schema} document never closes`);
}

function parseBrief(text: string): Brief {
  const dirDoc = findDoc(text, "free-model-aggregator-01/providers/v1") as Record<string, unknown>;
  const ratingsDoc = findDoc(text, "free-model-aggregator-01/ratings/v1") as Record<string, unknown>;
  const workloadDoc = findDoc(text, "free-model-aggregator-01/workload/v1") as Record<string, unknown>;
  const providers: Provider[] = [];
  const dirList = Array.isArray(dirDoc.providers) ? dirDoc.providers : [];
  for (const p of dirList) {
    if (!isRecord(p)) continue;
    const wire = asString(p.wire);
    if (wire !== "openai" && wire !== "anthropic" && wire !== "gemini") continue;
    providers.push({
      id: asString(p.id) ?? "",
      name: asString(p.name) ?? "",
      wire,
      auth: asString(p.auth) ?? "none",
      keyEnv: asString(p.key_env) ?? "",
      key: asString(p.key) ?? "",
      path: asString(p.path) ?? "",
    });
  }
  const ratings: Rating[] = [];
  const ratingList = Array.isArray(ratingsDoc.ratings) ? ratingsDoc.ratings : [];
  ratingList.forEach((r, i) => {
    if (!isRecord(r)) return;
    ratings.push({
      model: asString(r.model) ?? "",
      provider: asString(r.provider) ?? "",
      rating: asNumber(r.rating_milli) ?? 0,
      context: asNumber(r.context_length),
      tools: asBool(r.tools),
      vision: asBool(r.vision),
      json: asBool(r.json),
      free: asBool(r.free),
      order: i,
    });
  });
  const manifest: ManifestRow[] = [];
  const manifestList = Array.isArray(workloadDoc.manifest) ? workloadDoc.manifest : [];
  for (const m of manifestList) {
    if (!isRecord(m)) continue;
    const req = isRecord(m.requires) ? m.requires : {};
    manifest.push({
      id: asString(m.id) ?? "",
      api: asString(m.api) ?? "",
      stream: m.stream === true,
      weight: asNumber(m.weight) ?? 1,
      requires: {
        tools: req.tools === true ? true : undefined,
        vision: req.vision === true ? true : undefined,
        json: req.json === true ? true : undefined,
        minContext: asNumber(req.min_context) ?? undefined,
      },
    });
  }
  return { providers, ratings, manifest };
}

// The header that carries a provider's key. The wire never decides it:
// the brief's auth field does.
function authHeaders(p: Provider): Record<string, string> {
  if (p.auth === "bearer") return { Authorization: `Bearer ${p.key}` };
  if (p.auth === "x-api-key") return { "x-api-key": p.key };
  if (p.auth === "x-goog-api-key") return { "x-goog-api-key": p.key };
  return {};
}

function providerBase(envUrl: string, p: Provider): string {
  return envUrl.replace(/\/$/, "") + p.path;
}

// GET one provider's catalog route. Returns its models in the route's
// own order, each with its free flag and context length, or null when
// the probe fails.
async function probeProvider(envUrl: string, p: Provider): Promise<CatalogModel[] | null> {
  const base = providerBase(envUrl, p);
  const url = p.wire === "gemini" ? `${base}/v1beta/models` : `${base}/v1/models`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: authHeaders(p),
      signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!isRecord(body)) return null;
    const out: CatalogModel[] = [];
    if (p.wire === "gemini") {
      const list = Array.isArray(body.models) ? body.models : [];
      for (const m of list) {
        if (!isRecord(m)) continue;
        const name = asString(m.name) ?? "";
        const id = name.startsWith("models/") ? name.slice("models/".length) : name;
        if (id === "") continue;
        out.push({ id, free: m.free !== false, context_length: asNumber(m.context_length) });
      }
      return out;
    }
    const list = Array.isArray(body.data) ? body.data : [];
    for (const m of list) {
      if (!isRecord(m)) continue;
      const id = asString(m.id) ?? "";
      if (id === "") continue;
      out.push({ id, free: m.free !== false, context_length: asNumber(m.context_length) });
    }
    return out;
  } catch {
    return null;
  }
}

// The catalog from the brief alone: every free model the ratings table
// names, in the brief's order. Used when a probe fails, and by --list
// outside a trial where there is no env to probe.
function catalogFromBrief(brief: Brief): Catalog {
  const byProvider = new Map<string, CatalogModel[]>();
  for (const r of brief.ratings) {
    if (!r.free) continue;
    const list = byProvider.get(r.provider) ?? [];
    if (!list.some((m) => m.id === r.model)) {
      list.push({ id: r.model, free: true, context_length: r.context });
    }
    byProvider.set(r.provider, list);
  }
  return {
    providers: brief.providers.map((p) => ({
      id: p.id,
      base_url: p.path,
      key_env: p.keyEnv,
      wire: p.wire,
      models: byProvider.get(p.id) ?? [],
    })),
  };
}

// The catalog from live probes, falling back to the brief per provider.
async function buildCatalog(envUrl: string, brief: Brief): Promise<Catalog> {
  const fallback = catalogFromBrief(brief);
  const providers: CatalogProvider[] = [];
  for (let i = 0; i < brief.providers.length; i++) {
    const p = brief.providers[i];
    const probed = await probeProvider(envUrl, p);
    providers.push({
      id: p.id,
      base_url: p.path,
      key_env: p.keyEnv,
      wire: p.wire,
      models: probed ?? fallback.providers[i].models,
    });
  }
  return { providers };
}

// ---- client request, normalized -------------------------------------------

type UserPart =
  | { kind: "text"; text: string }
  | { kind: "image-data"; mime: string; data: string }
  | { kind: "image-url"; url: string };

type NormTool = { name: string; description: string; parameters: Record<string, unknown> };

type NormRequest = {
  clientApi: "openai" | "anthropic";
  stream: boolean;
  systemText: string;
  userParts: UserPart[];
  tools: NormTool[];
  maxTokens: number | null;
  temperature: number | null;
  stops: string[];
  jsonMode: boolean;
  anthropicVersion: string;
  row: ManifestRow | null;
};

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (isRecord(b) && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function parseDataUrl(url: string): UserPart | null {
  const m = /^data:([^;,]+)?;base64,(.*)$/s.exec(url);
  if (m) return { kind: "image-data", mime: m[1] === "" || m[1] === undefined ? "image/png" : m[1], data: m[2] };
  if (url !== "") return { kind: "image-url", url };
  return null;
}

function openAIUserParts(messages: unknown[]): UserPart[] {
  let last: unknown = null;
  for (const m of messages) if (isRecord(m) && m.role === "user") last = m.content;
  if (typeof last === "string") return last === "" ? [] : [{ kind: "text", text: last }];
  if (!Array.isArray(last)) return [];
  const parts: UserPart[] = [];
  for (const b of last) {
    if (!isRecord(b)) continue;
    if (b.type === "text" && typeof b.text === "string") parts.push({ kind: "text", text: b.text });
    else if (b.type === "image_url" && isRecord(b.image_url) && typeof b.image_url.url === "string") {
      const img = parseDataUrl(b.image_url.url);
      if (img) parts.push(img);
    }
  }
  return parts;
}

function anthropicUserParts(messages: unknown[]): UserPart[] {
  let last: unknown = null;
  for (const m of messages) if (isRecord(m) && m.role === "user") last = m.content;
  if (typeof last === "string") return last === "" ? [] : [{ kind: "text", text: last }];
  if (!Array.isArray(last)) return [];
  const parts: UserPart[] = [];
  for (const b of last) {
    if (!isRecord(b)) continue;
    if (b.type === "text" && typeof b.text === "string") parts.push({ kind: "text", text: b.text });
    else if (b.type === "image" && isRecord(b.source)) {
      if (b.source.type === "base64" && typeof b.source.data === "string") {
        parts.push({
          kind: "image-data",
          mime: typeof b.source.media_type === "string" ? b.source.media_type : "image/png",
          data: b.source.data,
        });
      } else if (b.source.type === "url" && typeof b.source.url === "string") {
        parts.push({ kind: "image-url", url: b.source.url });
      }
    }
  }
  return parts;
}

function userTextOf(parts: UserPart[]): string {
  return parts
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
}

function hasImage(parts: UserPart[]): boolean {
  return parts.some((p) => p.kind === "image-data" || p.kind === "image-url");
}

// Requirements the request itself shows, on top of the manifest row.
function bodyRequirements(api: "openai" | "anthropic", body: Record<string, unknown>): { tools: boolean; vision: boolean; json: boolean } {
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  let vision = false;
  let json = false;
  if (api === "openai") {
    if (isRecord(body.response_format)) {
      const t = body.response_format.type;
      json = t === "json_object" || t === "json_schema";
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    vision = hasImage(openAIUserParts(messages));
  } else {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    vision = hasImage(anthropicUserParts(messages));
  }
  return { tools, vision, json };
}

function normalizeRequest(
  api: "openai" | "anthropic",
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  row: ManifestRow | null
): NormRequest {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let systemText = "";
  let userParts: UserPart[] = [];
  let tools: NormTool[] = [];
  let stops: string[] = [];
  let maxTokens: number | null = null;
  let jsonMode = false;
  let temperature: number | null = null;
  if (api === "openai") {
    const sys: string[] = [];
    for (const m of messages) {
      if (isRecord(m) && m.role === "system") {
        const t = textBlocks(m.content);
        if (t !== "") sys.push(t);
      }
    }
    systemText = sys.join("\n");
    userParts = openAIUserParts(messages);
    if (Array.isArray(body.tools)) {
      for (const t of body.tools) {
        if (isRecord(t) && isRecord(t.function) && typeof t.function.name === "string") {
          tools.push({
            name: t.function.name,
            description: typeof t.function.description === "string" ? t.function.description : "",
            parameters: isRecord(t.function.parameters) ? t.function.parameters : {},
          });
        }
      }
    }
    if (typeof body.stop === "string") stops = [body.stop];
    else if (Array.isArray(body.stop)) stops = body.stop.filter((s): s is string => typeof s === "string");
    maxTokens = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens);
    if (isRecord(body.response_format)) {
      const t = body.response_format.type;
      jsonMode = t === "json_object" || t === "json_schema";
    }
    temperature = asNumber(body.temperature);
  } else {
    systemText = textBlocks(body.system);
    userParts = anthropicUserParts(messages);
    if (Array.isArray(body.tools)) {
      for (const t of body.tools) {
        if (isRecord(t) && typeof t.name === "string") {
          tools.push({
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            parameters: isRecord(t.input_schema) ? t.input_schema : {},
          });
        }
      }
    }
    if (typeof body.stop_sequences === "string") stops = [body.stop_sequences];
    else if (Array.isArray(body.stop_sequences)) stops = body.stop_sequences.filter((s): s is string => typeof s === "string");
    maxTokens = asNumber(body.max_tokens);
    temperature = asNumber(body.temperature);
  }
  // The manifest row's requirements join the body's own: the union is
  // what the serving model must meet.
  if (row) {
    if (row.requires.json) jsonMode = true;
  }
  const version = headers["anthropic-version"];
  return {
    clientApi: api,
    stream: body.stream === true,
    systemText,
    userParts,
    tools,
    maxTokens,
    temperature,
    stops,
    jsonMode,
    anthropicVersion: typeof version === "string" && version !== "" ? version : "2023-06-01",
    row,
  };
}

// ---- routing ---------------------------------------------------------------

type Candidate = { rating: Rating; provider: Provider };

// Free models meeting every requirement, best rating first, brief order
// breaking ties. A JSON-mode request sorts providers whose wire can
// carry JSON mode (OpenAI, Gemini) ahead of Anthropic-wire ones, which
// cannot echo it.
function rankCandidates(brief: Brief, req: NormRequest, byId: Map<string, Provider>): Candidate[] {
  const row = req.row;
  const needTools = req.tools.length > 0 || row?.requires.tools === true;
  const needVision = hasImage(req.userParts) || row?.requires.vision === true;
  const needJson = req.jsonMode;
  const needCtx = row?.requires.minContext ?? null;
  const out: Candidate[] = [];
  for (const r of brief.ratings) {
    if (!r.free) continue;
    if (needTools && !r.tools) continue;
    if (needVision && !r.vision) continue;
    if (needJson && !r.json) continue;
    if (needCtx !== null && (r.context === null || r.context < needCtx)) continue;
    const provider = byId.get(r.provider);
    if (!provider) continue;
    out.push({ rating: r, provider });
  }
  out.sort((a, b) => {
    if (needJson) {
      const aJson = a.provider.wire === "anthropic" ? 1 : 0;
      const bJson = b.provider.wire === "anthropic" ? 1 : 0;
      if (aJson !== bJson) return aJson - bJson;
    }
    if (b.rating.rating !== a.rating.rating) return b.rating.rating - a.rating.rating;
    return a.rating.order - b.rating.order;
  });
  return out;
}

// ---- provider request bodies ------------------------------------------------

function userPartsToOpenAI(parts: UserPart[]): unknown {
  const texts = parts.filter((p) => p.kind === "text");
  const hasImg = parts.some((p) => p.kind !== "text");
  if (!hasImg) return userTextOf(parts);
  const blocks: Record<string, unknown>[] = [];
  for (const p of parts) {
    if (p.kind === "text") blocks.push({ type: "text", text: p.text });
    else if (p.kind === "image-data") blocks.push({ type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } });
    else blocks.push({ type: "image_url", image_url: { url: p.url } });
  }
  return blocks;
}

function userPartsToAnthropic(parts: UserPart[]): unknown {
  const hasImg = parts.some((p) => p.kind !== "text");
  if (!hasImg) return userTextOf(parts);
  const blocks: Record<string, unknown>[] = [];
  for (const p of parts) {
    if (p.kind === "text") blocks.push({ type: "text", text: p.text });
    else if (p.kind === "image-data") blocks.push({ type: "image", source: { type: "base64", media_type: p.mime, data: p.data } });
    else blocks.push({ type: "image", source: { type: "url", url: p.url } });
  }
  return blocks;
}

function userPartsToGemini(parts: UserPart[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const p of parts) {
    if (p.kind === "text") out.push({ text: p.text });
    else if (p.kind === "image-data") out.push({ inlineData: { mimeType: p.mime, data: p.data } });
    else out.push({ fileData: { fileUri: p.url } });
  }
  return out;
}

function buildProviderBody(provider: Provider, modelId: string, req: NormRequest): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const envUrl = process.env.MAKEFUN_ENV_URL ?? "";
  const base = providerBase(envUrl, provider);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeaders(provider) };
  if (provider.wire === "openai") {
    const messages: Record<string, unknown>[] = [];
    if (req.systemText !== "") messages.push({ role: "system", content: req.systemText });
    messages.push({ role: "user", content: userPartsToOpenAI(req.userParts) });
    const body: Record<string, unknown> = { model: modelId, messages };
    if (req.maxTokens !== null) body.max_tokens = req.maxTokens;
    if (req.temperature !== null) body.temperature = req.temperature;
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }
    if (req.stops.length > 0) body.stop = req.stops;
    if (req.stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    if (req.jsonMode) body.response_format = { type: "json_object" };
    return { url: `${base}/v1/chat/completions`, headers, body };
  }
  if (provider.wire === "anthropic") {
    const body: Record<string, unknown> = { model: modelId, messages: [{ role: "user", content: userPartsToAnthropic(req.userParts) }] };
    if (req.maxTokens !== null) body.max_tokens = req.maxTokens;
    else body.max_tokens = 1024;
    if (req.systemText !== "") body.system = req.systemText;
    if (req.temperature !== null) body.temperature = req.temperature;
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    if (req.stops.length > 0) body.stop_sequences = req.stops;
    if (req.stream) body.stream = true;
    headers["anthropic-version"] = req.anthropicVersion;
    return { url: `${base}/v1/messages`, headers, body };
  }
  // Gemini wire.
  const config: Record<string, unknown> = {};
  if (req.temperature !== null) config.temperature = req.temperature;
  if (req.maxTokens !== null) config.maxOutputTokens = req.maxTokens;
  if (req.stops.length > 0) config.stopSequences = req.stops;
  if (req.jsonMode) config.responseMimeType = "application/json";
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: userPartsToGemini(req.userParts) }],
    generationConfig: config,
  };
  if (req.systemText !== "") body.systemInstruction = { parts: [{ text: req.systemText }] };
  if (req.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      },
    ];
  }
  const path = req.stream ? ":streamGenerateContent?alt=sse" : ":generateContent";
  return { url: `${base}/v1beta/models/${encodeURIComponent(modelId)}${path}`, headers, body };
}

// ---- provider answers --------------------------------------------------------

type ProviderResult = {
  ok: boolean;
  status: number;
  text: string;
  input: number | null;
  output: number | null;
  stop: string | null;
};

function failResult(status: number): ProviderResult {
  return { ok: false, status, text: "", input: null, output: null, stop: null };
}

function splitFrames(raw: string): { event: string | null; data: string }[] {
  const frames: { event: string | null; data: string }[] = [];
  for (const chunk of raw.replace(/\r\n/g, "\n").split("\n\n")) {
    if (chunk.trim() === "") continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  return frames;
}

function parseOpenAIAnswer(raw: string, stream: boolean): ProviderResult {
  if (!stream) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return failResult(502);
    }
    if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) return failResult(502);
    const choice = value.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message)) return failResult(502);
    const content = choice.message.content;
    const text = typeof content === "string" ? content : "";
    const usage = isRecord(value.usage) ? value.usage : null;
    return {
      ok: true,
      status: 200,
      text,
      input: usage ? asNumber(usage.prompt_tokens) : null,
      output: usage ? asNumber(usage.completion_tokens) : null,
      stop: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
    };
  }
  let text = "";
  let input: number | null = null;
  let output: number | null = null;
  let stop: string | null = null;
  let sawFinish = false;
  for (const frame of splitFrames(raw)) {
    if (frame.data.trim() === "[DONE]") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (!isRecord(chunk) || !Array.isArray(chunk.choices)) continue;
    if (isRecord(chunk.usage)) {
      input = asNumber(chunk.usage.prompt_tokens) ?? input;
      output = asNumber(chunk.usage.completion_tokens) ?? output;
    }
    if (chunk.choices.length === 0) continue;
    const choice = chunk.choices[0];
    if (!isRecord(choice)) continue;
    if (isRecord(choice.delta) && typeof choice.delta.content === "string") text += choice.delta.content;
    // The finish reason may arrive on more than one chunk; keep the first.
    if (typeof choice.finish_reason === "string" && !sawFinish) {
      sawFinish = true;
      stop = choice.finish_reason;
    }
  }
  if (!sawFinish) return failResult(502);
  return { ok: true, status: 200, text, input, output, stop: stop ?? "stop" };
}

function parseAnthropicAnswer(raw: string, stream: boolean): ProviderResult {
  if (!stream) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return failResult(502);
    }
    if (!isRecord(value) || !Array.isArray(value.content)) return failResult(502);
    let text = "";
    for (const b of value.content) {
      if (isRecord(b) && b.type === "text" && typeof b.text === "string") text += b.text;
    }
    const usage = isRecord(value.usage) ? value.usage : null;
    return {
      ok: true,
      status: 200,
      text,
      input: usage ? asNumber(usage.input_tokens) : null,
      output: usage ? asNumber(usage.output_tokens) : null,
      stop: typeof value.stop_reason === "string" ? value.stop_reason : "end_turn",
    };
  }
  let text = "";
  let input: number | null = null;
  let output: number | null = null;
  let stop: string | null = null;
  for (const frame of splitFrames(raw)) {
    if (frame.event === null) continue;
    let data: unknown;
    try {
      data = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (!isRecord(data)) continue;
    if (frame.event === "message_start" && isRecord(data.message) && isRecord(data.message.usage)) {
      input = asNumber(data.message.usage.input_tokens) ?? input;
    } else if (frame.event === "content_block_delta" && isRecord(data.delta) && data.delta.type === "text_delta" && typeof data.delta.text === "string") {
      text += data.delta.text;
    } else if (frame.event === "message_delta") {
      if (isRecord(data.delta) && typeof data.delta.stop_reason === "string") stop = data.delta.stop_reason;
      if (isRecord(data.usage)) output = asNumber(data.usage.output_tokens) ?? output;
    }
  }
  if (stop === null) return failResult(502);
  return { ok: true, status: 200, text, input, output, stop };
}

function parseGeminiAnswer(raw: string, stream: boolean): ProviderResult {
  if (!stream) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return failResult(502);
    }
    if (!isRecord(value) || !Array.isArray(value.candidates) || value.candidates.length === 0) return failResult(502);
    const cand = value.candidates[0];
    if (!isRecord(cand) || !isRecord(cand.content) || !Array.isArray(cand.content.parts)) return failResult(502);
    let text = "";
    for (const part of cand.content.parts) {
      if (isRecord(part) && typeof part.text === "string") text += part.text;
    }
    const meta = isRecord(value.usageMetadata) ? value.usageMetadata : null;
    return {
      ok: true,
      status: 200,
      text,
      input: meta ? asNumber(meta.promptTokenCount) : null,
      output: meta ? asNumber(meta.candidatesTokenCount) : null,
      stop: typeof cand.finishReason === "string" ? cand.finishReason : "STOP",
    };
  }
  let text = "";
  let input: number | null = null;
  let output: number | null = null;
  let stop: string | null = null;
  for (const frame of splitFrames(raw)) {
    let value: unknown;
    try {
      value = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (!isRecord(value) || !Array.isArray(value.candidates) || value.candidates.length === 0) continue;
    const cand = value.candidates[0];
    if (!isRecord(cand)) continue;
    if (isRecord(cand.content) && Array.isArray(cand.content.parts)) {
      for (const part of cand.content.parts) {
        if (isRecord(part) && typeof part.text === "string") text += part.text;
      }
    }
    if (typeof cand.finishReason === "string") stop = cand.finishReason;
    if (isRecord(value.usageMetadata)) {
      input = asNumber(value.usageMetadata.promptTokenCount) ?? input;
      output = asNumber(value.usageMetadata.candidatesTokenCount) ?? output;
    }
  }
  if (stop === null) return failResult(502);
  return { ok: true, status: 200, text, input, output, stop };
}

async function dialProvider(provider: Provider, modelId: string, req: NormRequest): Promise<ProviderResult> {
  const built = buildProviderBody(provider, modelId, req);
  let res: Response;
  try {
    res = await fetch(built.url, {
      method: "POST",
      headers: built.headers,
      body: JSON.stringify(built.body),
      signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
    });
  } catch {
    return failResult(0);
  }
  if (!res.ok) return failResult(res.status);
  const raw = await res.text();
  if (provider.wire === "openai") return parseOpenAIAnswer(raw, req.stream);
  if (provider.wire === "anthropic") return parseAnthropicAnswer(raw, req.stream);
  return parseGeminiAnswer(raw, req.stream);
}

// ---- translation back to the client wire ------------------------------------

function stopFamily(stop: string | null): number {
  if (stop === "length" || stop === "max_tokens" || stop === "MAX_TOKENS") return 1;
  if (stop === "tool_calls" || stop === "tool_use") return 2;
  if (stop === "content_filter" || stop === "refusal" || stop === "SAFETY") return 3;
  return 0;
}

function clientStop(api: "openai" | "anthropic", family: number): string {
  if (api === "openai") return ["stop", "length", "tool_calls", "content_filter"][family];
  return ["end_turn", "max_tokens", "tool_use", "refusal"][family];
}

function fallbackUsage(req: NormRequest, text: string): { input: number; output: number } {
  const toolsLen = req.tools.map((t) => t.name).join(",").length;
  const input = 1 + Math.floor((req.systemText.length + userTextOf(req.userParts).length + toolsLen) / 4);
  const output = 1 + Math.floor(text.length / 4);
  return { input, output };
}

function chunksOf(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  if (out.length === 0) out.push("");
  return out;
}

function openAIAnswer(modelId: string, result: ProviderResult, usage: { input: number; output: number }): Record<string, unknown> {
  return {
    id: "chatcmpl-sim",
    object: "chat.completion",
    created: FIXED_CREATED,
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: clientStop("openai", stopFamily(result.stop)) }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
  };
}

function openAIStream(modelId: string, result: ProviderResult, usage: { input: number; output: number }): string {
  const stop = clientStop("openai", stopFamily(result.stop));
  const frames: string[] = [];
  const base = { id: "chatcmpl-sim", object: "chat.completion.chunk", created: FIXED_CREATED, model: modelId };
  frames.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
  for (const piece of chunksOf(result.text, 13)) {
    frames.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
  }
  frames.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: stop }] }));
  frames.push(
    JSON.stringify({
      ...base,
      choices: [],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    })
  );
  return frames.map((f) => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n";
}

function anthropicAnswer(modelId: string, result: ProviderResult, usage: { input: number; output: number }): Record<string, unknown> {
  return {
    id: "msg_sim",
    type: "message",
    role: "assistant",
    model: modelId,
    content: [{ type: "text", text: result.text }],
    stop_reason: clientStop("anthropic", stopFamily(result.stop)),
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
}

function anthropicStream(modelId: string, result: ProviderResult, usage: { input: number; output: number }): string {
  const stop = clientStop("anthropic", stopFamily(result.stop));
  const frames: { event: string; data: Record<string, unknown> }[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_sim",
          type: "message",
          role: "assistant",
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.input, output_tokens: 0 },
        },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  ];
  for (const piece of chunksOf(result.text, 13)) {
    frames.push({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
  }
  frames.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
  frames.push({
    event: "message_delta",
    data: { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output } },
  });
  frames.push({ event: "message_stop", data: { type: "message_stop" } });
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("");
}

// ---- serving one request -----------------------------------------------------

type ServerState = {
  brief: Brief;
  catalog: Catalog;
  byId: Map<string, Provider>;
  modelInfo: Map<string, Rating>;
  nextIndex: number;
  queue: Promise<void>;
};

function serveRequest(state: ServerState, api: "openai" | "anthropic", body: Record<string, unknown>, headers: Record<string, string | string[] | undefined>): Promise<{ status: number; contentType: string; payload: string }> {
  const run = async (): Promise<{ status: number; contentType: string; payload: string }> => {
    const idx = state.nextIndex++;
    const row = state.brief.manifest[idx] ?? null;
    const req = normalizeRequest(api, body, headers, row);
    const candidates = rankCandidates(state.brief, req, state.byId);
    let dials = 0;
    for (const c of candidates) {
      if (dials >= MAX_DIALS_PER_REQUEST) break;
      dials++;
      const result = await dialProvider(c.provider, c.rating.model, req);
      if (!result.ok) continue;
      const fb = fallbackUsage(req, result.text);
      const usage = {
        input: result.input ?? fb.input,
        output: result.output ?? fb.output,
      };
      if (api === "openai") {
        if (req.stream) return { status: 200, contentType: "text/event-stream", payload: openAIStream(c.rating.model, result, usage) };
        return { status: 200, contentType: "application/json", payload: JSON.stringify(openAIAnswer(c.rating.model, result, usage)) };
      }
      if (req.stream) return { status: 200, contentType: "text/event-stream", payload: anthropicStream(c.rating.model, result, usage) };
      return { status: 200, contentType: "application/json", payload: JSON.stringify(anthropicAnswer(c.rating.model, result, usage)) };
    }
    return {
      status: 502,
      contentType: "application/json",
      payload: JSON.stringify({ error: { message: "all providers failed", type: "server_error" } }),
    };
  };
  // One provider serves one call at a time, so serve strictly in order.
  const p = state.queue.then(run);
  state.queue = p.then(
    () => undefined,
    () => undefined
  );
  return p;
}

function modelsList(state: ServerState, headers: Record<string, string | string[] | undefined>): Record<string, unknown> {
  const auth = typeof headers.authorization === "string" ? headers.authorization : "";
  const xApiKey = headers["x-api-key"];
  const freeIds: string[] = [];
  for (const p of state.catalog.providers) {
    for (const m of p.models) if (m.free) freeIds.push(m.id);
  }
  if (typeof xApiKey === "string" && xApiKey !== "") {
    return {
      data: freeIds.map((id) => {
        const info = state.modelInfo.get(id);
        return {
          type: "model",
          id,
          display_name: id,
          created_at: "2026-01-01T00:00:00Z",
          free: true,
          context_length: info?.context ?? null,
          tools: info?.tools ?? false,
          vision: info?.vision ?? false,
          json: info?.json ?? false,
        };
      }),
      has_more: false,
    };
  }
  void auth;
  return {
    object: "list",
    data: freeIds.map((id) => {
      const info = state.modelInfo.get(id);
      return {
        id,
        object: "model",
        created: FIXED_CREATED,
        owned_by: "aggregator",
        free: true,
        context_length: info?.context ?? null,
        tools: info?.tools ?? false,
        vision: info?.vision ?? false,
        json: info?.json ?? false,
      };
    }),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function register(envUrl: string, port: number, catalog: Catalog): Promise<number> {
  const url = envUrl.replace(/\/$/, "") + "/register";
  let lastError = "";
  for (let attempt = 0; attempt < REGISTER_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, port, catalog }),
        signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastError = `register HTTP ${res.status}`;
      } else {
        const body = (await res.json()) as unknown;
        if (isRecord(body) && body.ok === true) return asNumber(body.requests) ?? 20;
        lastError = "register response not ok";
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (attempt < REGISTER_RETRIES - 1) await sleep(REGISTER_RETRY_MS);
  }
  throw new Error(`register failed: ${lastError}`);
}

async function waitDone(envUrl: string): Promise<void> {
  const url = envUrl.replace(/\/$/, "") + "/work";
  for (;;) {
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as unknown;
        if (isRecord(body) && body.done === true) return;
      }
    } catch {
      // The env may not answer yet; keep polling.
    }
    await sleep(WORK_POLL_MS);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const promptFile = process.env.MAKEFUN_PROMPT_FILE ?? "";
  if (promptFile === "") throw new Error("MAKEFUN_PROMPT_FILE is not set");
  const briefText = fs.readFileSync(promptFile, "utf8");
  const brief = parseBrief(briefText);
  if (args.includes("--list")) {
    process.stdout.write(JSON.stringify(catalogFromBrief(brief)) + "\n");
    return;
  }
  const envUrl = process.env.MAKEFUN_ENV_URL ?? "";
  if (envUrl === "") throw new Error("MAKEFUN_ENV_URL is not set");
  const catalog = await buildCatalog(envUrl, brief);
  const byId = new Map<string, Provider>();
  for (const p of brief.providers) byId.set(p.id, p);
  const modelInfo = new Map<string, Rating>();
  for (const r of brief.ratings) {
    if (r.free && !modelInfo.has(r.model)) modelInfo.set(r.model, r);
  }
  const state: ServerState = { brief, catalog, byId, modelInfo, nextIndex: 0, queue: Promise.resolve() };
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(modelsList(state, req.headers)));
          return;
        }
        if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages")) {
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "invalid JSON", type: "invalid_request_error" } }));
            return;
          }
          if (!isRecord(body)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "body must be an object", type: "invalid_request_error" } }));
            return;
          }
          const api = url.pathname === "/v1/messages" ? "anthropic" : "openai";
          const out = await serveRequest(state, api, body, req.headers);
          res.writeHead(out.status, { "Content-Type": out.contentType });
          res.end(out.payload);
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e), type: "server_error" } }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const requests = await register(envUrl, port, catalog);
  void requests;
  await waitDone(envUrl);
  server.close();
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
