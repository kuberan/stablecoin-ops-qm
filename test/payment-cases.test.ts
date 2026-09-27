import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import {
  evidenceFor,
  casePrincipal,
  caseTurn,
  createPaymentCaseService,
  parseCaseReply,
  type PaymentCase,
} from "../src/payment-cases/demo.ts";
import { createCanReadScope } from "../src/resolution/scope-membership.ts";
import type { TurnRequest, TurnResult } from "../src/types.ts";

function fixture() {
  const store = createMemoryMap<PaymentCase>();
  const turns: TurnRequest[] = [];
  const results = new Map<string, { status: string; result: TurnResult | null }>();
  const deps = {
    store,
    lock: createMemoryAdvisoryLock(),
    turn: async (t: TurnRequest): Promise<TurnResult> => {
      turns.push(t);
      const id = String(turns.length);
      results.set(id, { status: "running", result: null });
      return { status: "queued", runId: id, sessionId: "session-" + id };
    },
    run: async (id: string) => results.get(id) ?? null,
  };
  return { store, turns, results, deps, service: createPaymentCaseService(deps) };
}
const sender = JSON.stringify({
  findings: [{ text: "Sent and finalized.", evidenceIds: ["S-INSTRUCTION", "S-SETTLEMENT"] }],
  requests: [{ to: "receiver", question: "Confirm receipt and beneficiary credit." }],
});
const receiver = JSON.stringify({
  findings: [{ text: "Received 500000, credited 487000; adjustment PA-218.", evidenceIds: ["R-RECEIPT", "R-CREDIT"] }],
  requests: [],
});

test("separate identities and own evidence; cross-institution scope reads are denied", async () => {
  const f = fixture();
  await f.service.advance("alice", true);
  const c = (await f.store.get("PAY-1042:alice"))!;
  const s = casePrincipal(c, "sender"),
    r = casePrincipal(c, "receiver");
  assert.notEqual(s, r);
  assert.ok(f.turns[0]!.text.includes("S-INSTRUCTION"));
  assert.ok(!f.turns[0]!.text.includes("R-CREDIT"));
  assert.ok(!f.turns[0]!.text.includes("487000"));
  const canRead = createCanReadScope({});
  assert.equal(await canRead(s, `personal:${r}`), false);
  assert.equal(await canRead(r, `personal:${s}`), false);
  assert.equal(await canRead(s, `personal:${s}`), true);
  const rTurn = caseTurn(c, { id: "r", institution: "receiver", question: "Verify", status: "pending" });
  assert.ok(!rTurn.text.includes("S-INSTRUCTION"));
  assert.equal(await f.service.get("bob"), null);
  await assert.rejects(f.service.advance(s, true), /Human case owner/);
});

test("requests drive real turn queue; restart and repeated polling preserve evidence without duplicates", async () => {
  const f = fixture();
  await Promise.all([f.service.advance("alice", true), f.service.advance("alice", true)]);
  assert.equal(f.turns.length, 1);
  f.results.set("1", { status: "done", result: { status: "ok", reply: sender, sessionId: "s" } });
  await f.service.advance("alice", false);
  const restored = createPaymentCaseService(f.deps);
  await restored.advance("alice", false);
  assert.equal(f.turns.length, 2);
  assert.ok(f.turns[1]!.text.includes("S-SETTLEMENT"));
  f.results.set("2", { status: "done", result: { status: "ok", reply: receiver, sessionId: "r" } });
  await restored.advance("alice", false);
  const result = await restored.advance("alice", false);
  assert.equal(result!.status, "review");
  assert.equal(result!.reconciliation.difference, 13000);
  assert.equal(result!.reconciliation.adjustmentReference, "PA-218");
  assert.equal(result!.events.length, 3);
  await restored.advance("alice", true);
  assert.equal(f.turns.length, 2);
  assert.equal((await restored.get("alice"))!.events.length, 3);
});

test("citations cannot cross institution boundary or invent evidence", () => {
  assert.throws(() => parseCaseReply(receiver, "sender"), /not available to its institution/);
  assert.throws(() =>
    parseCaseReply(JSON.stringify({ findings: [{ text: "x", evidenceIds: ["FAKE"] }], requests: [] }), "receiver"),
  );
  assert.throws(() => parseCaseReply("not json", "sender"));
});

test("failed or malformed agent result becomes visible attention state, never a fabricated success", async () => {
  const f = fixture();
  await f.service.advance("alice", true);
  f.results.set("1", { status: "done", result: { status: "ok", reply: "I did it." } });
  const c = await f.service.advance("alice", false);
  assert.equal(c!.status, "needs_attention");
  assert.equal(c!.events.length, 0);
  assert.equal(c!.reconciliation.difference, null);
});

test("replay uses stable idempotency key across a failure to persist queue result", async () => {
  const f = fixture();
  await f.service.advance("alice", true);
  const saved = (await f.store.get("PAY-1042:alice"))!;
  const first = f.turns[0]!.idempotencyKey;
  delete saved.jobs[0]!.runId;
  saved.jobs[0]!.status = "pending";
  await f.store.put("PAY-1042:alice", saved);
  await f.service.advance("alice", false);
  assert.equal(f.turns[1]!.idempotencyKey, first);
});

test("replay archives the old case and creates fresh institution identities", async () => {
  const f = fixture();
  await f.service.advance("alice", true);
  const old = (await f.store.get("PAY-1042:alice"))!;
  old.status = "review";
  await f.store.put("PAY-1042:alice", old);
  await f.service.advance("alice", true, "replay");
  const next = (await f.store.get("PAY-1042:alice"))!;
  assert.notEqual(next.generation, old.generation);
  assert.notEqual(casePrincipal(next, "sender"), casePrincipal(old, "sender"));
  assert.equal((await f.store.get(`PAY-1042:alice:history:${old.generation}`))!.status, "review");
  await f.service.advance("alice", true, "replay");
  assert.equal((await f.store.get("PAY-1042:alice"))!.generation, next.generation);
});

test("case API refuses agent capabilities and unsigned human requests", async () => {
  const { paymentCaseRoutes } = await import("../src/api/routes/payment-cases.ts");
  const responses: number[] = [];
  const res = { writeHead: (status: number) => responses.push(status), end: () => {} };
  const route = paymentCaseRoutes[0]!;
  const base = { res, actor: null, capability: null };
  await route.handle(base as unknown as Parameters<typeof route.handle>[0]);
  await route.handle({ ...base, actor: { p: "alice" }, capability: { actorId: "alice" } } as unknown as Parameters<
    typeof route.handle
  >[0]);
  await route.handle({ ...base, actor: { p: "payment-demo-agent" } } as unknown as Parameters<typeof route.handle>[0]);
  assert.deepEqual(responses, [403, 403, 403]);
});

test("agents may cite published evidence while unpublished peer evidence stays inaccessible", () => {
  const text = JSON.stringify({
    findings: [{ text: "Reconciled published receipt", evidenceIds: ["S-SETTLEMENT", "R-RECEIPT"] }],
    requests: [],
  });
  assert.throws(() => parseCaseReply(text, "receiver"));
  const shared = evidenceFor("sender").filter((e) => e.id === "S-SETTLEMENT");
  assert.equal(parseCaseReply(text, "receiver", shared).findings.length, 1);
  assert.throws(() =>
    parseCaseReply(
      JSON.stringify({ findings: [{ text: "Private", evidenceIds: ["S-INSTRUCTION"] }], requests: [] }),
      "receiver",
      shared,
    ),
  );
});

test("retry reprocesses a corrected result without requeuing or duplicating findings", async () => {
  const f = fixture();
  await f.service.advance("alice", true);
  f.results.set("1", { status: "done", result: { status: "ok", reply: "bad" } });
  await f.service.advance("alice", false);
  f.results.set("1", { status: "done", result: { status: "ok", reply: sender } });
  const recovered = await f.service.advance("alice", false, "retry");
  assert.equal(recovered!.status, "investigating");
  assert.equal(recovered!.events.length, 2);
  assert.equal(f.turns.length, 1);
  await f.service.advance("alice", false, "retry");
  assert.equal((await f.service.get("alice"))!.events.length, 2);
});
