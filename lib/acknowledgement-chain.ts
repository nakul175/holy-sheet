import { createHash } from "node:crypto";
import { stableStringify } from "./document";

export const ACK_GENESIS = "0".repeat(64);

export type AcknowledgementChainRecord = {
  id: string;
  campaignId: string;
  assignmentId: string;
  pageId: string;
  versionId: string;
  userId: string;
  acknowledgedAt: string;
  contentHash: string;
  ipCountry: string | null;
  prevHash: string;
  hash: string;
};

export function acknowledgementRecordHash(record: Omit<AcknowledgementChainRecord, "hash">) {
  return createHash("sha256").update(stableStringify({
    acknowledgedAt: record.acknowledgedAt,
    assignmentId: record.assignmentId,
    campaignId: record.campaignId,
    contentHash: record.contentHash,
    id: record.id,
    ipCountry: record.ipCountry,
    pageId: record.pageId,
    prevHash: record.prevHash,
    userId: record.userId,
    versionId: record.versionId,
  })).digest("hex");
}

export function verifyAcknowledgementChain(records: AcknowledgementChainRecord[]) {
  const byPrev = new Map<string, AcknowledgementChainRecord>();
  for (const record of records) {
    if (byPrev.has(record.prevHash)) return { ok: false as const, brokenAt: record.id };
    byPrev.set(record.prevHash, record);
  }
  let prev = ACK_GENESIS;
  const seen = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = byPrev.get(prev);
    if (!record) return { ok: false as const, brokenAt: prev };
    if (record.ipCountry !== null && !/^[A-Z]{2}$/.test(record.ipCountry)) return { ok: false as const, brokenAt: record.id };
    if (record.hash !== acknowledgementRecordHash(record)) return { ok: false as const, brokenAt: record.id };
    seen.add(record.id);
    prev = record.hash;
  }
  if (seen.size !== records.length) return { ok: false as const, brokenAt: prev };
  return { ok: true as const };
}
