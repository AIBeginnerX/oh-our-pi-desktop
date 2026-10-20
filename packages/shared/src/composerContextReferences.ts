import {
  COMPOSER_CONTEXT_LABEL_MAX_CHARS,
  type ComposerContextId,
  type ComposerContextKind,
  type ComposerContextRecord,
  type ElementContextDetails,
  type KnownComposerContextRecord,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

/**
 * Canonical inline reference: `[label](t3-context://v1/<kind>/<contextId>)`, or the image
 * form `![label](...)`. The link carries position and identity only; the payload lives in the
 * message's context records. Labels are display text and never identity.
 */

const CONTEXT_PROTOCOL = "t3-context:";
const COMPOSER_CONTEXT_HREF_PREFIX = `${CONTEXT_PROTOCOL}//v1/`;
const CONTEXT_KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const CONTEXT_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;
const MAX_LINK_LABEL_LENGTH = 512;
const CONTEXT_LINK = new RegExp(
  String.raw`(!?)\[([^\]\n]{0,${MAX_LINK_LABEL_LENGTH}})\]\((${COMPOSER_CONTEXT_HREF_PREFIX}[^\s)]{1,200})\)`,
  "g",
);

export function formatComposerContextHref(kind: ComposerContextKind, contextId: ComposerContextId) {
  return `${COMPOSER_CONTEXT_HREF_PREFIX}${kind}/${contextId}`;
}

export function parseComposerContextHref(
  href: string,
): { kind: ComposerContextKind; contextId: ComposerContextId } | null {
  if (!href.startsWith(COMPOSER_CONTEXT_HREF_PREFIX)) return null;
  const rest = href.slice(COMPOSER_CONTEXT_HREF_PREFIX.length);
  const parts = rest.split("/");
  if (parts.length !== 2) return null;
  const [kind, contextId] = parts as [string, string];
  if (!CONTEXT_KIND_PATTERN.test(kind) || !CONTEXT_ID_PATTERN.test(contextId)) return null;
  return { kind, contextId: contextId as ComposerContextId };
}

/** Labels must survive a Markdown link: no brackets or line breaks, bounded, never empty. */
export function sanitizeComposerContextLabel(label: string, kind: ComposerContextKind): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, COMPOSER_CONTEXT_LABEL_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : kind;
}

export function formatComposerContextReference(reference: {
  kind: ComposerContextKind;
  contextId: ComposerContextId;
  label: string;
}): string {
  const label = sanitizeComposerContextLabel(reference.label, reference.kind);
  const href = formatComposerContextHref(reference.kind, reference.contextId);
  return `${reference.kind === "image" ? "!" : ""}[${label}](${href})`;
}

export interface ComposerContextReferenceOccurrence {
  kind: ComposerContextKind;
  contextId: ComposerContextId;
  label: string;
  /** Whether the occurrence used the `![...]` image form. */
  image: boolean;
  source: string;
  start: number;
  end: number;
}

export function collectComposerContextReferences(
  text: string,
): ComposerContextReferenceOccurrence[] {
  const occurrences: ComposerContextReferenceOccurrence[] = [];
  // No link can match without the protocol prefix; skip the scan entirely on
  // plain prose so long messages never pay for a regex walk per `[`.
  if (!text.includes("](t3-context:")) return occurrences;
  for (const match of text.matchAll(CONTEXT_LINK)) {
    const parsed = parseComposerContextHref(match[3]!);
    if (!parsed) continue;
    occurrences.push({
      ...parsed,
      label: sanitizeComposerContextLabel(match[2]!, parsed.kind),
      image: match[1] === "!",
      source: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return occurrences;
}

export function replaceComposerContextReferences(
  text: string,
  replace: (occurrence: ComposerContextReferenceOccurrence) => string,
): string {
  let result = "";
  let cursor = 0;
  for (const occurrence of collectComposerContextReferences(text)) {
    result += text.slice(cursor, occurrence.start) + replace(occurrence);
    cursor = occurrence.end;
  }
  return result + text.slice(cursor);
}

// ---------------------------------------------------------------------------
// Reserved project-memory identities
// ---------------------------------------------------------------------------

export const PROJECT_MEMORY_REFERENCE_LABEL = "Project memory";

const PROJECT_MEMORY_REFERENCE_KIND = "memory";
const PROJECT_MEMORY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Union of "memory" link ids and "memory" record ids, computed before any
 * deduplication. Once an id is reserved it is never reclassified by another
 * kind's link or record claiming the same id.
 */
function collectProjectMemoryContextIds(input: {
  text: string;
  records: ReadonlyArray<ComposerContextRecord>;
}) {
  const occurrences = collectComposerContextReferences(input.text);
  const ids = new Set<ComposerContextId>();
  for (const occurrence of occurrences) {
    if (occurrence.kind === PROJECT_MEMORY_REFERENCE_KIND) ids.add(occurrence.contextId);
  }
  for (const record of input.records) {
    if (record.kind === PROJECT_MEMORY_REFERENCE_KIND) ids.add(record.contextId);
  }
  return { occurrences, ids };
}

/** Labels only. No throws, no validation, no envelope, payloads untouched. */
export function normalizeProjectMemoryReferenceLabels(input: {
  text: string;
  records: ReadonlyArray<ComposerContextRecord>;
}): string {
  const { occurrences, ids } = collectProjectMemoryContextIds(input);
  if (occurrences.length === 0 || ids.size === 0) return input.text;
  return replaceComposerContextReferences(input.text, (occurrence) =>
    ids.has(occurrence.contextId)
      ? formatComposerContextReference({
          kind: PROJECT_MEMORY_REFERENCE_KIND,
          contextId: occurrence.contextId,
          label: PROJECT_MEMORY_REFERENCE_LABEL,
        })
      : occurrence.source,
  );
}

/**
 * Persistence-time normalization for newly stored user messages. Rejects
 * ambiguous or malformed memory identities with `ok:false`; on success the
 * record keeps only `memoryId`/`selectedVersion` behind the generic label.
 */
export function canonicalizeProjectMemoryReferences(input: {
  text: string;
  context: OrchestrationMessageContext | undefined;
}): { ok: true; text: string; context: OrchestrationMessageContext | undefined } | { ok: false } {
  const records = input.context?.records ?? [];
  const { occurrences, ids } = collectProjectMemoryContextIds({
    text: input.text,
    records,
  });
  if (ids.size === 0) return { ok: true, text: input.text, context: input.context };

  const canonicalPayloadById = new Map<
    ComposerContextId,
    { memoryId: string; selectedVersion: number }
  >();
  for (const contextId of ids) {
    for (const occurrence of occurrences) {
      if (occurrence.contextId === contextId && occurrence.kind !== PROJECT_MEMORY_REFERENCE_KIND) {
        return { ok: false };
      }
    }
    let seen: ComposerContextRecord | undefined;
    for (const record of records) {
      if (record.contextId !== contextId) continue;
      if (record.kind !== PROJECT_MEMORY_REFERENCE_KIND || seen !== undefined) {
        return { ok: false };
      }
      seen = record;
    }
    if (seen !== undefined) {
      const payload = "payload" in seen ? seen.payload : undefined;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false };
      }
      const { memoryId, selectedVersion } = payload as Record<string, unknown>;
      if (typeof memoryId !== "string" || !PROJECT_MEMORY_ID_PATTERN.test(memoryId)) {
        return { ok: false };
      }
      if (
        typeof selectedVersion !== "number" ||
        !Number.isSafeInteger(selectedVersion) ||
        selectedVersion <= 0
      ) {
        return { ok: false };
      }
      canonicalPayloadById.set(contextId, { memoryId, selectedVersion });
    }
  }

  const nextRecords = records.map((record) => {
    const canonical = canonicalPayloadById.get(record.contextId);
    if (canonical === undefined || record.kind !== PROJECT_MEMORY_REFERENCE_KIND) return record;
    return {
      version: 1 as const,
      contextId: record.contextId,
      kind: PROJECT_MEMORY_REFERENCE_KIND,
      label: PROJECT_MEMORY_REFERENCE_LABEL,
      payload: { memoryId: canonical.memoryId, selectedVersion: canonical.selectedVersion },
    } satisfies ComposerContextRecord;
  });
  return {
    ok: true,
    text: normalizeProjectMemoryReferenceLabels({ text: input.text, records }),
    context: input.context === undefined ? undefined : { ...input.context, records: nextRecords },
  };
}

export interface ResolvedProjectMemoryReference {
  readonly contextId: ComposerContextId;
  readonly memoryId: string;
  readonly selectedVersion: number;
}

/**
 * Send-path resolution of the reserved memory identities actually referenced in
 * the text. Unlike `canonicalizeProjectMemoryReferences` this only validates —
 * nothing is rewritten. Unreferenced reserved records are ignored. A referenced
 * reserved id is `invalid` when a non-memory link or record claims it, when it
 * has anything but exactly one memory record, or when the payload is not a
 * well-formed `{memoryId, selectedVersion}` selection. Two context ids selecting
 * the same memory at different versions is a `version-conflict`.
 */
export function resolveProjectMemoryReferences(input: {
  text: string;
  records: ReadonlyArray<ComposerContextRecord>;
}):
  | {
      readonly ok: true;
      readonly references: ReadonlyArray<ResolvedProjectMemoryReference>;
      readonly items: ReadonlyArray<{
        readonly memoryId: string;
        readonly selectedVersion: number;
      }>;
    }
  | { readonly ok: false; readonly reason: "invalid" | "version-conflict" } {
  const { occurrences, ids } = collectProjectMemoryContextIds(input);
  const referencedIds: ComposerContextId[] = [];
  const seen = new Set<ComposerContextId>();
  for (const occurrence of occurrences) {
    if (!ids.has(occurrence.contextId) || seen.has(occurrence.contextId)) continue;
    seen.add(occurrence.contextId);
    referencedIds.push(occurrence.contextId);
  }

  const references: ResolvedProjectMemoryReference[] = [];
  for (const contextId of referencedIds) {
    for (const occurrence of occurrences) {
      if (occurrence.contextId === contextId && occurrence.kind !== PROJECT_MEMORY_REFERENCE_KIND) {
        return { ok: false, reason: "invalid" };
      }
    }
    let record: ComposerContextRecord | undefined;
    let recordCount = 0;
    for (const candidate of input.records) {
      if (candidate.contextId !== contextId) continue;
      recordCount += 1;
      if (candidate.kind !== PROJECT_MEMORY_REFERENCE_KIND) {
        return { ok: false, reason: "invalid" };
      }
      record = candidate;
    }
    if (recordCount !== 1 || record === undefined) {
      return { ok: false, reason: "invalid" };
    }
    const payload = "payload" in record ? record.payload : undefined;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, reason: "invalid" };
    }
    const { memoryId, selectedVersion } = payload as Record<string, unknown>;
    if (typeof memoryId !== "string" || !PROJECT_MEMORY_ID_PATTERN.test(memoryId)) {
      return { ok: false, reason: "invalid" };
    }
    if (
      typeof selectedVersion !== "number" ||
      !Number.isSafeInteger(selectedVersion) ||
      selectedVersion <= 0
    ) {
      return { ok: false, reason: "invalid" };
    }
    references.push({ contextId, memoryId, selectedVersion });
  }

  const items: Array<{ memoryId: string; selectedVersion: number }> = [];
  const selectedVersionByMemoryId = new Map<string, number>();
  for (const reference of references) {
    const selected = selectedVersionByMemoryId.get(reference.memoryId);
    if (selected !== undefined && selected !== reference.selectedVersion) {
      return { ok: false, reason: "version-conflict" };
    }
    if (selected === undefined) {
      selectedVersionByMemoryId.set(reference.memoryId, reference.selectedVersion);
      items.push({ memoryId: reference.memoryId, selectedVersion: reference.selectedVersion });
    }
  }
  return { ok: true, references, items };
}

export interface HydratedProjectMemory {
  readonly memoryId: string;
  readonly version: number;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
}

// ---------------------------------------------------------------------------
// Provider projection
// ---------------------------------------------------------------------------

const CONTEXT_ENVELOPE_TAG = "t3_context";
const CONTEXT_ENTRY_TAG = "context";

function kindDisplayName(kind: ComposerContextKind): string {
  const spaced = kind.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `[Image: shot.png; ref=ctx_1]` — readable in place, with the id the payload is keyed by. */
export function formatComposerContextProviderMarker(
  kind: ComposerContextKind,
  label: string,
  contextId: ComposerContextId,
): string {
  const cleanLabel = label
    .replace(/[\r\n;\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `[${kindDisplayName(kind)}: ${escapeComposerContextPayloadText(cleanLabel)}; ref=${contextId}]`;
}

/**
 * Captured text is data. A terminal line or PR comment that contains `</t3_context>` or
 * `</context>` must not be able to close the envelope and forge a record.
 */
function escapeComposerContextPayloadText(text: string): string {
  return text.replace(
    new RegExp(String.raw`<(?=/?(?:${CONTEXT_ENVELOPE_TAG}|${CONTEXT_ENTRY_TAG})\b)`, "gi"),
    "&lt;",
  );
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function formatSourceLocation(source: {
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}): string | null {
  if (!source.fileName) return null;
  if (source.lineNumber == null) return source.fileName;
  return `${source.fileName}:${source.lineNumber}${source.columnNumber != null ? `:${source.columnNumber}` : ""}`;
}

function formatElementDetails(element: ElementContextDetails): string[] {
  const lines = [`url: ${element.pageUrl}`, `tag: ${element.tagName}`];
  if (element.pageTitle) lines.push(`title: ${element.pageTitle}`);
  if (element.selector) lines.push(`selector: ${element.selector}`);
  if (element.componentName) lines.push(`component: ${element.componentName}`);
  const location = element.source ? formatSourceLocation(element.source) : null;
  if (location) lines.push(`source: ${location}`);
  if (element.htmlPreview.trim()) lines.push("html:", indent(element.htmlPreview.trim()));
  if (element.styles.trim()) lines.push("styles:", indent(element.styles.trim()));
  return lines;
}

/** Body lines for one payload, including authoritative paths and names behind display labels. */
function formatComposerContextProviderPayload(record: KnownComposerContextRecord): string {
  switch (record.kind) {
    case "image":
    case "file":
      return [
        `name: ${record.name}`,
        `mimeType: ${record.mimeType}`,
        `sizeBytes: ${record.sizeBytes}`,
        `attachmentId: ${record.attachmentId}`,
      ].join("\n");
    case "terminal": {
      const lines = record.text
        .split("\n")
        .slice(0, record.lineEnd - record.lineStart + 1)
        .map((line, index) => `${record.lineStart + index} | ${line}`);
      return [`terminal: ${record.terminalLabel}`, ...lines].join("\n");
    }
    case "element":
      return formatElementDetails(record).join("\n");
    case "preview-annotation": {
      const lines = [
        `page: ${record.pageTitle?.trim() || record.pageUrl}`,
        `url: ${record.pageUrl}`,
      ];
      if (record.comment.trim()) lines.push(`comment: ${record.comment.trim()}`);
      if (record.targetSummary) lines.push(`targets: ${record.targetSummary}`);
      if (record.styleChanges.length > 0) {
        lines.push(
          "requested visual changes:",
          ...record.styleChanges.map((change) => `- ${change}`),
        );
      }
      if (record.screenshotContextId) lines.push(`screenshot: ref=${record.screenshotContextId}`);
      for (const [index, element] of (record.elements ?? []).entries()) {
        lines.push(`element ${index + 1}:`, indent(formatElementDetails(element).join("\n")));
      }
      return lines.join("\n");
    }
    case "review-comment": {
      const lines = [
        `file: ${record.filePath}`,
        `range: ${record.rangeLabel} (${record.startIndex}-${record.endIndex})`,
        `section: ${record.sectionTitle}`,
      ];
      if (record.text.trim()) lines.push("comment:", indent(record.text.trim()));
      if (record.diff.trim()) {
        lines.push(`${record.fenceLanguage ?? "diff"}:`, indent(record.diff.trimEnd()));
      }
      return lines.join("\n");
    }
    case "mention":
      return `path: ${record.path}`;
    case "skill":
      return `name: ${record.name}`;
  }
}

function formatEnvelopeEntry(
  kind: ComposerContextKind,
  contextId: ComposerContextId,
  record: ComposerContextRecord | undefined,
): string {
  const open = `<${CONTEXT_ENTRY_TAG} kind="${escapeAttribute(kind)}" id="${escapeAttribute(contextId)}"`;
  if (!record) return `${open} unavailable="true"/>`;
  const body =
    "payload" in record
      ? JSON.stringify(record.payload)
      : formatComposerContextProviderPayload(record);
  return `${open}>\n${escapeComposerContextPayloadText(body)}\n</${CONTEXT_ENTRY_TAG}>`;
}

function formatHydratedMemoryEntry(
  contextId: ComposerContextId,
  memory: HydratedProjectMemory,
): string {
  const open = `<${CONTEXT_ENTRY_TAG} kind="${escapeAttribute(PROJECT_MEMORY_REFERENCE_KIND)}" id="${escapeAttribute(contextId)}"`;
  const body = `memory: ${memory.memoryId} v${memory.version} (${memory.kind})\ntitle: ${memory.title}\n${memory.body}`;
  return `${open}>\n${escapeComposerContextPayloadText(body)}\n</${CONTEXT_ENTRY_TAG}>`;
}

/**
 * What the provider reads: every reference becomes an in-place marker, and each unique
 * referenced payload appears once in a trailing envelope, in first-reference order.
 * Unreferenced records are not emitted. Binary attachments travel on their own channel.
 *
 * `hydrated` carries send-committed memory content. A referenced memory id only
 * gets its envelope entry filled when the full reference set resolves and a
 * hydrated row matches both the selected `memoryId` and `selectedVersion`;
 * anything else stays `unavailable`. Without `hydrated` the output is identical
 * to the projection that never carried memory content.
 */
export function projectComposerContextForProvider(input: {
  text: string;
  records: ReadonlyArray<ComposerContextRecord>;
  hydrated?: ReadonlyArray<HydratedProjectMemory>;
}): string {
  const { occurrences, ids: reservedMemoryIds } = collectProjectMemoryContextIds(input);
  if (occurrences.length === 0) return input.text;
  const recordsById = new Map<ComposerContextId, ComposerContextRecord | undefined>();
  for (const record of input.records) {
    // Even callers that bypass the wire schema must not silently select an ambiguous payload.
    recordsById.set(record.contextId, recordsById.has(record.contextId) ? undefined : record);
  }
  const hydratedByContextId = new Map<ComposerContextId, HydratedProjectMemory>();
  if (input.hydrated !== undefined) {
    const resolved = resolveProjectMemoryReferences(input);
    if (resolved.ok) {
      for (const reference of resolved.references) {
        const hydrated = input.hydrated.find(
          (entry) =>
            entry.memoryId === reference.memoryId && entry.version === reference.selectedVersion,
        );
        if (hydrated !== undefined) hydratedByContextId.set(reference.contextId, hydrated);
      }
    }
  }
  const body = replaceComposerContextReferences(input.text, (occurrence) =>
    formatComposerContextProviderMarker(
      reservedMemoryIds.has(occurrence.contextId)
        ? PROJECT_MEMORY_REFERENCE_KIND
        : (recordsById.get(occurrence.contextId)?.kind ?? occurrence.kind),
      reservedMemoryIds.has(occurrence.contextId)
        ? PROJECT_MEMORY_REFERENCE_LABEL
        : occurrence.label,
      occurrence.contextId,
    ),
  );
  const seen = new Set<ComposerContextId>();
  const entries: string[] = [];
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.contextId)) continue;
    seen.add(occurrence.contextId);
    if (reservedMemoryIds.has(occurrence.contextId)) {
      const hydrated = hydratedByContextId.get(occurrence.contextId);
      entries.push(
        hydrated === undefined
          ? formatEnvelopeEntry(PROJECT_MEMORY_REFERENCE_KIND, occurrence.contextId, undefined)
          : formatHydratedMemoryEntry(occurrence.contextId, hydrated),
      );
      continue;
    }
    const record = recordsById.get(occurrence.contextId);
    const entry = formatEnvelopeEntry(
      record?.kind ?? occurrence.kind,
      occurrence.contextId,
      record,
    );
    entries.push(entry);
  }
  if (entries.length === 0) return body;
  return `${body}\n\n<${CONTEXT_ENVELOPE_TAG} version="1">\n${entries.join("\n")}\n</${CONTEXT_ENVELOPE_TAG}>`;
}
