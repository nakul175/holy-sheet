import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { isTransientSocket, retryTransient } from "./acceptance-transient";

const exec = promisify(execFile);

it("retries a dropped socket and does not retry a real assertion failure", async () => {
  expect(isTransientSocket(new Error("apiRequestContext.get: read ECONNRESET"))).toBe(true);
  expect(isTransientSocket(new Error("expect(received).toBe(expected)"))).toBe(false);
  let attempts = 0;
  const value = await retryTransient(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("read ECONNRESET");
    return "saved";
  });
  expect(value).toBe("saved");
  expect(attempts).toBe(3);
  await expect(retryTransient(async () => { throw new Error("heading missing"); }, 4)).rejects.toThrow("heading missing");
});

it("closes a keep-alive acceptance socket after pipe listeners stack", async () => {
  const { stdout } = await exec(process.execPath, ["--import", "./scripts/acceptance-socket-guard.mjs", "--input-type=module", "-e", `
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    const server = createServer((request, response) => {
      const socket = request.socket;
      for (let i = 0; i < 21; i++) socket.on('unpipe', () => {});
      response.on('finish', () => { setTimeout(() => { console.log(socket.destroyed ? 'destroyed' : 'open'); server.close(); }, 20); });
      response.end('ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const response = await fetch('http://127.0.0.1:' + address.port + '/');
    if (await response.text() !== 'ok') process.exitCode = 1;
  `], { cwd: process.cwd(), timeout: 5000 });
  expect(stdout.trim()).toBe("destroyed");
});
