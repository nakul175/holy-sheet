export type OracleRequest = {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
};

export type OracleResult = {
  revision: string;
  candidateSha: string;
  environment: "staging";
  executor: string;
  executedAtIst: string;
  runsPerTarget: number;
  method: string;
  hidden: Record<string, unknown>;
  control: Record<string, unknown>;
  medianDeltaMs: number;
  comparable: {
    hiddenStable: boolean;
    controlStable: boolean;
    status: boolean;
    headers: boolean;
    bodyShape: boolean;
    bodyDigest: boolean;
  };
  pass: boolean;
};

export function bodyShape(body: string): unknown;
export function median(values: number[]): number;
export function runOracle(options: {
  hidden: OracleRequest;
  control: OracleRequest;
  cookie: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  clock?: () => number;
  now?: () => Date;
  runs?: number;
  candidateSha: string;
  executor: string;
}): Promise<OracleResult>;
