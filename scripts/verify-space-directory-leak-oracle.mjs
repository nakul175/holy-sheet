import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const SAFE_HEADERS = ["cache-control", "content-type", "vary"];
const RUNS = 20;
const STAGING_ORIGIN = "https://staging.holysheet.aplyd.org";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const members = [...new Set(value.map(jsonShape))].sort();
    return { array: members };
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonShape(value[key])]));
  }
  return typeof value;
}

export function bodyShape(body) {
  try {
    return { kind: "json", shape: jsonShape(JSON.parse(body)) };
  } catch {
    return { kind: "text", length: body.length };
  }
}

export function median(values) {
  if (!values.length) throw new Error("median requires at least one value");
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function safeHeaders(headers) {
  return {
    ...Object.fromEntries(SAFE_HEADERS.map(name => [name, headers.get(name) ?? null])),
    locationPresent: headers.has("location"),
  };
}

async function request(fetchImpl, clock, request, cookie, label) {
  const started = clock();
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: {
      accept: "application/json",
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      cookie,
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  return {
    label,
    durationMs: clock() - started,
    status: response.status,
    headers: safeHeaders(response.headers),
    bodyShape: bodyShape(body),
    bodySha256: digest(body),
  };
}

function stable(value) {
  return JSON.stringify(value);
}

function formatIst(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} IST`;
}

function uniform(samples, select) {
  return new Set(samples.map(sample => stable(select(sample)))).size === 1;
}

export async function runOracle({
  hidden,
  control,
  cookie,
  fetchImpl = fetch,
  clock = () => performance.now(),
  now = () => new Date(),
  runs = RUNS,
  candidateSha,
  executor,
}) {
  if (!cookie || cookie.length > 8192 || /[\r\n]/.test(cookie)) throw new Error("A valid session cookie is required");
  if (!/^[a-f0-9]{40}$/.test(candidateSha ?? "")) throw new Error("A full lowercase candidate SHA is required");
  if (!executor || executor.length > 120 || /[\r\n]/.test(executor)) throw new Error("A valid executor label is required");
  if (hidden.method !== control.method || !["GET", "POST"].includes(hidden.method)) throw new Error("Both requests must use the same GET or POST method");
  if (new URL(hidden.url).origin !== new URL(control.url).origin) throw new Error("Both requests must use the same origin");
  if (runs !== RUNS) throw new Error(`N47 leak-oracle evidence requires exactly ${RUNS} runs per target`);
  const samples = { hidden: [], control: [] };
  for (let index = 0; index < runs; index += 1) {
    // Alternate the first request to reduce ordering and warm-cache bias.
    const order = index % 2 ? [["control", control], ["hidden", hidden]] : [["hidden", hidden], ["control", control]];
    for (const [label, requestSpec] of order) samples[label].push(await request(fetchImpl, clock, requestSpec, cookie, label));
  }
  const firstHidden = samples.hidden[0];
  const firstControl = samples.control[0];
  const comparable = {
    hiddenStable: uniform(samples.hidden, sample => ({ status: sample.status, headers: sample.headers, bodyShape: sample.bodyShape, bodySha256: sample.bodySha256 })),
    controlStable: uniform(samples.control, sample => ({ status: sample.status, headers: sample.headers, bodyShape: sample.bodyShape, bodySha256: sample.bodySha256 })),
    status: firstHidden.status === firstControl.status,
    headers: stable(firstHidden.headers) === stable(firstControl.headers),
    bodyShape: stable(firstHidden.bodyShape) === stable(firstControl.bodyShape),
    bodyDigest: firstHidden.bodySha256 === firstControl.bodySha256,
  };
  const hiddenMedianMs = median(samples.hidden.map(sample => sample.durationMs));
  const controlMedianMs = median(samples.control.map(sample => sample.durationMs));
  return {
    revision: "HS-SF-N47-r1-20261104",
    candidateSha,
    environment: "staging",
    executor,
    executedAtIst: formatIst(now()),
    runsPerTarget: runs,
    method: hidden.method,
    hidden: {
      status: firstHidden.status,
      headers: firstHidden.headers,
      bodyShape: firstHidden.bodyShape,
      bodySha256: firstHidden.bodySha256,
      medianMs: Number(hiddenMedianMs.toFixed(3)),
    },
    control: {
      status: firstControl.status,
      headers: firstControl.headers,
      bodyShape: firstControl.bodyShape,
      bodySha256: firstControl.bodySha256,
      medianMs: Number(controlMedianMs.toFixed(3)),
    },
    medianDeltaMs: Number(Math.abs(hiddenMedianMs - controlMedianMs).toFixed(3)),
    comparable,
    pass: Object.values(comparable).every(Boolean),
  };
}

function parseJson(name, value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function requestFromEnv(prefix) {
  const url = process.env[`HS_N47_${prefix}_URL`];
  if (!url) throw new Error(`HS_N47_${prefix}_URL is required`);
  const parsed = new URL(url);
  if (parsed.origin !== STAGING_ORIGIN) throw new Error(`${prefix.toLowerCase()} URL must use ${STAGING_ORIGIN}`);
  return {
    url: parsed.toString(),
    method: (process.env.HS_N47_METHOD ?? "GET").toUpperCase(),
    body: parseJson(`HS_N47_${prefix}_BODY_JSON`, process.env[`HS_N47_${prefix}_BODY_JSON`]),
  };
}

async function main() {
  const hidden = requestFromEnv("HIDDEN");
  const control = requestFromEnv("CONTROL");
  if (hidden.method !== control.method || !["GET", "POST"].includes(hidden.method)) throw new Error("HS_N47_METHOD must be GET or POST");
  const result = await runOracle({
    hidden,
    control,
    cookie: process.env.HS_N47_COOKIE,
    candidateSha: process.env.HS_N47_CANDIDATE_SHA,
    executor: process.env.HS_N47_EXECUTOR,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.pass) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => {
    process.stderr.write(`HOLY-92 leak-oracle failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
