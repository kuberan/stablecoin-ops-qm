import assert from "node:assert/strict";
import { test } from "node:test";
import { advancePaymentChat, paymentChatIntent } from "../src/payment-cases/chat.ts";
import { createPaymentCaseService, type PaymentCase } from "../src/payment-cases/demo.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import type { TurnResult } from "../src/types.ts";

test("native chat recognizes explicit commands and supported reports without capturing ordinary questions", () => {
  assert.equal(
    paymentChatIntent("We sent 500,000 USDC but the beneficiary received only 487,000. Please investigate."),
    "report",
  );
  assert.equal(paymentChatIntent("/payment investigate PAY-1042"), "report");
  assert.equal(paymentChatIntent("/payment status"), "status");
  assert.equal(paymentChatIntent("/payment retry"), "retry");
  assert.equal(paymentChatIntent("What is PAY-1042?"), null);
  assert.equal(paymentChatIntent("We sent 600,000 USDC but the beneficiary received 487,000."), null);
});

test("native chat persists attributed findings, deduplicates sends, and refuses other chat scopes", async () => {
  const store = createMemoryMap<PaymentCase>();
  const lock = createMemoryAdvisoryLock();
  const sessions = createMemorySessionStore();
  let calls = 0;
  const service = createPaymentCaseService({
    store,
    lock,
    turn: async (): Promise<TurnResult> => ({ status: "queued", runId: String(++calls), sessionId: "private-sender" }),
    run: async () => ({ status: "running", result: null }),
  });
  const deps = { store, lock, sessions, service };
  const input = {
    threadRef: "web:alice:case",
    text: "/payment investigate PAY-1042",
    action: "start" as const,
    sendKey: "send-1",
  };
  const first = await advancePaymentChat(deps, "alice", input);
  assert.equal(first.handled, true);
  if (!first.handled) throw new Error("Expected handled result");
  assert.match(first.reply, /Sender PSP/);
  assert.match(first.reply, /Receiver PSP/);
  assert.ok(!first.reply.includes("260 basis points"));
  await advancePaymentChat(deps, "alice", input);
  assert.equal(calls, 1);
  let entries = await sessions.getEntries(first.sessionId);
  assert.equal(entries.filter((e) => e.type === "user").length, 1);
  await assert.rejects(advancePaymentChat(deps, "bob", input), /own personal QM chat/);
  await assert.rejects(
    advancePaymentChat(deps, "alice", { ...input, threadRef: "web:alice:other", action: "advance" }),
    /another chat/,
  );
  const c = (await store.get("PAY-1042:alice"))!;
  c.events.push({
    id: "finding",
    kind: "finding",
    institution: "sender",
    text: "Published settlement finding",
    evidence: [],
    runId: "1",
    at: Date.now(),
  });
  await store.put("PAY-1042:alice", c);
  const result = await advancePaymentChat(deps, "alice", { ...input, action: "advance" });
  assert.ok(result.handled && result.reply.includes("Published settlement finding"));
  await advancePaymentChat(deps, "alice", { ...input, action: "advance" });
  entries = await sessions.getEntries(first.sessionId);
  assert.equal(
    entries.filter((e) => (e.payload as { text?: string }).text?.includes("Published settlement finding")).length,
    1,
  );
  const resumed = await advancePaymentChat(deps, "alice", { ...input, text: "/payment status", sendKey: "send-2" });
  assert.ok(resumed.handled && resumed.reply.includes("resumed"));
  assert.ok(resumed.handled && !resumed.reply.includes("Published settlement finding"));
  const polled = await advancePaymentChat(deps, "alice", { ...input, action: "advance", sendKey: "send-2" });
  assert.ok(polled.handled && !polled.reply.includes("Published settlement finding"));
  assert.equal((await sessions.get(first.sessionId))!.scopeId, "personal:alice");
});
