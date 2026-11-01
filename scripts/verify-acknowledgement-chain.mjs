import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const genesis = "0".repeat(64);

function stableStringify(value) {
  function sort(item) {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
    return item;
  }
  return JSON.stringify(sort(value));
}

function recordHash(record) {
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

function verify(records) {
  const byPrev = new Map();
  for (const record of records) {
    if (byPrev.has(record.prevHash)) return record.id;
    byPrev.set(record.prevHash, record);
  }
  let prev = genesis;
  const seen = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = byPrev.get(prev);
    if (!record) return prev;
    if (record.ipCountry !== null && !/^[A-Z]{2}$/.test(record.ipCountry)) return record.id;
    if (record.hash !== recordHash(record)) return record.id;
    if (typeof record.ipCountry === "string" && record.ipCountry.includes(".")) return record.id;
    seen.add(record.id);
    prev = record.hash;
  }
  if (seen.size !== records.length) return prev;
  return null;
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/verify-acknowledgement-chain.mjs <evidence.json>");
  process.exit(2);
}
const pack = JSON.parse(await readFile(file, "utf8"));
const brokenAt = verify(pack.records ?? []);
if (brokenAt) {
  console.log(`chain-broken ${brokenAt}`);
  process.exit(1);
}
console.log("chain-ok");
