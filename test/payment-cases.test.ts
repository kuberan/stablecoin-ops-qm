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
  const legacy = (await f.store.get("PAY-1042:alice"))!;
  delete legacy.version;
  await f.store.put("PAY-1042:alice", legacy);
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

test("invalid model replies can be regenerated twice with distinct keys and preserved failed runs", async () => {
  const f = fixture();
  await f.service.advance("alice", true);
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.results.set(String(attempt), { status: "done", result: { status: "ok", reply: "bad" } });
    const failed = await f.service.advance("alice", false);
    assert.equal(failed!.status, "needs_attention");
    await f.service.advance("alice", false, "retry");
    await f.service.advance("alice", false);
  }
  const c = (await f.store.get("PAY-1042:alice"))!;
  assert.equal(c.status, "needs_attention");
  assert.equal(c.events.length, 0);
  assert.equal(c.jobs[0]!.rejectedRuns!.length, 2);
  assert.equal(f.turns.length, 3);
  assert.equal(new Set(f.turns.map((t) => t.idempotencyKey)).size, 3);
  assert.match(f.turns[1]!.text, /previous response was rejected/);
});

test("pricing review follows discovery, publishes terms before Sender challenge, and requires cited recommendation", async () => {
  const f = fixture();
  await f.service.advance("alice", true);
  f.results.set("1", { status: "done", result: { status: "ok", reply: sender } });
  await f.service.advance("alice", false);
  await f.service.advance("alice", false);
  assert.ok(!f.turns[1]!.text.includes("260 basis points"));
  f.results.set("2", { status: "done", result: { status: "ok", reply: receiver } });
  await f.service.advance("alice", false);
  await f.service.advance("alice", false);
  const restored = createPaymentCaseService(f.deps);
  const reply = (ids: string[]) =>
    JSON.stringify({
      findings: [{ text: "Evidence-backed assessment for human review", evidenceIds: ids }],
      requests: [],
    });
  for (const [index, stage, ids] of [
    [3, "pricing", ["R-PA218", "R-APPROVAL", "R-CREDIT"]],
    [4, "challenge", ["S-INSTRUCTION", "R-PA218", "R-APPROVAL"]],
    [5, "recommendation", ["S-INSTRUCTION", "R-PA218", "R-APPROVAL", "R-CREDIT"]],
  ] as const) {
    await restored.advance("alice", false);
    assert.equal((await restored.get("alice"))!.stage, stage);
    if (stage === "pricing") assert.match(f.turns[index - 1]!.text, /260 basis points/);
    if (stage === "challenge") assert.match(f.turns[index - 1]!.text, /fictional pricing agreement excerpt/);
    if (stage === "recommendation") {
      f.results.set(String(index), { status: "done", result: { status: "ok", reply: receiver } });
      const rejected = await restored.advance("alice", false);
      assert.equal(rejected!.status, "needs_attention");
      assert.ok(!rejected!.events.some((e) => e.stage === "recommendation"));
    }
    f.results.set(String(index), { status: "done", result: { status: "ok", reply: reply([...ids]) } });
    await restored.advance("alice", false, "retry");
    await restored.advance("alice", false);
  }
  const result = (await restored.get("alice"))!;
  assert.equal(result.status, "review");
  assert.equal(result.reconciliation.difference, 13000);
  assert.deepEqual(
    result.events.filter((e) => e.stage && e.stage !== "discovery").map((e) => e.stage),
    ["pricing", "challenge", "recommendation"],
  );
  assert.equal(
    result.events.find((e) => e.stage === "challenge")!.evidence.find((e) => e.id === "R-PA218")!.institution,
    "receiver",
  );
  await restored.advance("alice", false);
  assert.equal(f.turns.length, 5);
});

test("Sender cannot cite unpublished pricing terms and new cases do not expose them in discovery", async () => {
  const f = fixture();
  await f.service.advance("alice", true);
  const c = (await f.store.get("PAY-1042:alice"))!;
  assert.ok(
    !caseTurn(c, {
      id: "r",
      institution: "receiver",
      status: "pending",
      stage: "discovery",
      question: "Verify",
    }).text.includes("260 basis points"),
  );
  assert.throws(() =>
    parseCaseReply(JSON.stringify({ findings: [{ text: "Terms", evidenceIds: ["R-PA218"] }], requests: [] }), "sender"),
  );
  assert.ok(!(await f.service.get("alice"))!.events.some((e) => e.evidence.some((r) => r.id === "R-PA218")));
});

test("a review finding can cite all six available records", () => {
  const shared = evidenceFor("sender");
  const ids = [...shared, ...evidenceFor("receiver")].map((e) => e.id);
  const reply = JSON.stringify({ findings: [{ text: "Combined assessment", evidenceIds: ids }], requests: [] });
  assert.equal(parseCaseReply(reply, "receiver", shared).findings[0]!.evidenceIds.length, 6);
});

test("reported issue persists, reaches agents as an unverified claim, and duplicate submission cannot restart active work", async () => {
  const f = fixture();
  const report = {
    paymentId: "PAY-1042",
    currency: "USDC",
    sent: 500000,
    credited: 487000,
    description: "Supplier reports a shortfall. Please investigate.",
  };
  const first = await f.service.advance("alice", true, "replay", report);
  assert.deepEqual(first!.report, report);
  assert.equal(first!.reconciliation.credited, null);
  assert.match(f.turns[0]!.text, /unverified user input/);
  assert.match(f.turns[0]!.text, /Supplier reports a shortfall/);
  await f.service.advance("alice", true, "replay", report);
  assert.equal(f.turns.length, 1);
  assert.deepEqual((await createPaymentCaseService(f.deps).get("alice"))!.report, report);
  await assert.rejects(f.service.advance("alice", true, "replay", { ...report, sent: 100 }));
  await assert.rejects(f.service.advance("alice", true, "replay", { ...report, description: " " }));
  await assert.rejects(f.service.advance("alice", true, "replay", { ...report, paymentId: "PAY-OTHER" }));
  assert.equal((await f.service.get("alice"))!.createdAt, first!.createdAt);
});
