import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url!, "http://core.local").pathname;
    if (req.method === "POST") requests.push({ path, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        path === "/v1/payment-demo/chat"
          ? {
              handled: body.text === "/payment investigate PAY-1042",
              paymentCase: true,
              caseStatus: "investigating",
              reply: "Investigation started",
            }
          : { status: "queued", runId: "ordinary-run" },
      ),
    );
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "turn-idempotency-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "turn-idempotency-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("personal chat routes the demo with a stable send key and ordinary questions still reach QM", async () => {
  const send = async (text: string, threadRef = "web:alice:payment") =>
    fetch(`${base}/api/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text,
        threadRef,
        scopeId: "personal:alice",
        clientTurnId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    });
  const report = await send("/payment investigate PAY-1042");
  assert.equal(report.status, 200);
  assert.equal((await report.json()).paymentCase, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, "/v1/payment-demo/chat");
  assert.equal(requests[0]!.body.sendKey, "web:alice:123e4567-e89b-42d3-a456-426614174000");
  const question = await send("What is PAY-1042?");
  assert.equal((await question.json()).runId, "ordinary-run");
  assert.equal(requests.at(-1)!.path, "/v1/turns");
  const count = requests.length;
  assert.equal((await send("/payment investigate PAY-1042", "web:bob:payment")).status, 403);
  assert.equal(requests.length, count);
});
