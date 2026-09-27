import { z } from "zod";
import { createPaymentCaseService, type PaymentCase, type PaymentReport } from "./demo.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { appendEntryOutsideTurn, type SessionStore } from "../sessions/session-store.ts";

export const paymentChatSchema = z
  .object({
    threadRef: z.string().min(1).max(300),
    text: z.string().max(2000).default(""),
    action: z.enum(["start", "advance"]).default("start"),
    sendKey: z.string().min(1).max(256),
  })
  .strict();
export function paymentChatIntent(text: string): "report" | "status" | "retry" | null {
  if (/^\/payment\s+status\s*$/i.test(text)) return "status";
  if (/^\/payment\s+retry\s*$/i.test(text)) return "retry";
  if (/^\/payment\s+investigate\s+PAY-1042\s*$/i.test(text)) return "report";
  if (/^investigate\s+PAY-1042[.!]?$/i.test(text.trim())) return "report";
  if (
    /\b(sent|transmitted)\b/i.test(text) &&
    /\b(beneficiary|supplier)\b/i.test(text) &&
    /\bUSDC\b/i.test(text) &&
    /(?<![\d,])500,?000(?![\d,])/.test(text) &&
    /(?<![\d,])487,?000(?![\d,])/.test(text) &&
    !/\?/.test(text)
  )
    return "report";
  return null;
}
const names = { sender: "Sender PSP agent", receiver: "Receiver PSP agent" };
export async function advancePaymentChat(
  deps: {
    service: ReturnType<typeof createPaymentCaseService>;
    store: DurableMap<PaymentCase>;
    sessions: SessionStore;
    lock: AdvisoryLock;
  },
  owner: string,
  input: z.infer<typeof paymentChatSchema>,
) {
  if (!input.threadRef.startsWith(`web:${owner}:`) || input.threadRef.length <= `web:${owner}:`.length)
    throw new Error("Payment investigations require your own personal QM chat");
  const intent = paymentChatIntent(input.text);
  if (input.action === "start" && !intent) return { handled: false as const };
  return deps.lock.withLock(`payment-chat:${owner}`, async () => {
    const key = `PAY-1042:${owner}`;
    let c = await deps.store.get(key);
    if (
      c?.chat &&
      c.chat.threadRef !== input.threadRef &&
      (c.status === "investigating" || input.action === "advance" || intent !== "report")
    )
      throw new Error("This investigation belongs to another chat. Open its conversation to continue.");
    if (input.action === "advance" && (!c?.chat || c.chat.threadRef !== input.threadRef))
      throw new Error("No investigation is attached to this chat");
    if (input.action === "start" && intent === "report") {
      if (c?.status === "investigating" && !c.chat)
        throw new Error(
          "An investigation is already running in the debug view. Let it finish before starting in chat.",
        );
      if (c?.chat?.sendKey !== input.sendKey) {
        const report: PaymentReport = {
          paymentId: "PAY-1042",
          currency: "USDC",
          sent: 500000,
          credited: 487000,
          description: input.text.slice(0, 600),
        };
        await deps.service.advance(owner, true, "replay", report, {
          threadRef: input.threadRef,
          sendKey: input.sendKey,
        });
      }
    } else {
      if (!c?.chat) throw new Error("Start with /payment investigate PAY-1042 in this chat");
      await deps.service.advance(owner, false, intent === "retry" ? "retry" : "continue");
    }
    c = await deps.store.get(key);
    if (!c || c.chat?.threadRef !== input.threadRef) throw new Error("Investigation is not attached to this chat");
    const session = await deps.sessions.getOrCreateByThread(
      input.threadRef,
      "dm",
      `personal:${owner}`,
      undefined,
      "web",
    );
    if (session.scopeId !== `personal:${owner}`) throw new Error("Chat scope mismatch");
    await deps.sessions.addParticipant(session.id, owner);
    await deps.sessions.updateTitle(session.id, "PAY-1042 · payment investigation");
    const { lease } = await deps.sessions.acquireLease(session.id);
    if (!lease) throw new Error("Chat is busy; retry /payment status shortly");
    try {
      const entries = await deps.sessions.getEntries(session.id);
      const seen = new Set(entries.map((e) => (e.payload as { paymentMessageKey?: string })?.paymentMessageKey));
      const prefix = `payment:${c.generation}:`;
      const append = async (id: string, text: string, type: "user" | "assistant" = "assistant") => {
        const paymentMessageKey = prefix + id;
        if (seen.has(paymentMessageKey)) return;
        await appendEntryOutsideTurn(
          deps.sessions,
          lease,
          { type, scopeLabel: session.scopeId, payload: { text, paymentMessageKey } },
          () => `[Payment investigation ${type}] ${text}`,
        );
        seen.add(paymentMessageKey);
      };
      if (input.action === "start") {
        await append(`user:${input.sendKey}`, input.text, "user");
        if (intent !== "report")
          await append(
            `resume:${input.sendKey}`,
            `**QM · Investigation ${c.status === "investigating" ? "resumed" : c.status.replaceAll("_", " ")}**\n\nNew published findings will appear below. Earlier evidence remains above.`,
          );
      }
      await append(
        "intro",
        "**QM · Case coordinator**\n\nInvestigation started for **PAY-1042**. This is the fictional 500,000 USDC sent / 487,000 credited scenario. Two AI agents will work in separate personal sessions: **Sender PSP** and **Receiver PSP**. I route their questions and published evidence; the coordinator is application code, not a third AI agent.\n\nKeep this chat open while it advances. If you leave or stop the display, send `/payment status` here to resume. An already queued agent run may still finish.",
      );
      for (const institution of ["sender", "receiver"] as const) {
        const job = c.jobs.find((j) => j.institution === institution && j.sessionId);
        if (job)
          await append(
            `session:${institution}`,
            `**${names[institution]} · connected**\n\nSeparate QM session: \`${job.sessionId}\`. Only its own supplied records and published case evidence are provided.`,
          );
      }
      for (const e of c.events) {
        const label = e.kind === "request" ? ` → ${names[e.to!]}` : ` · ${e.stage ?? "finding"}`;
        const evidence = e.evidence
          .map(
            (r) =>
              `**${r.id} — ${r.title}**\n${Object.entries(r.facts)
                .map(([k, v]) => `- ${k}: ${v}`)
                .join("\n")}`,
          )
          .join("\n\n");
        await append(
          e.id,
          `**${names[e.institution]}${label}**\n\n${e.text}${evidence ? `\n\n**Published source evidence**\n\n${evidence}` : ""}\n\nRun: \`${e.runId}\``,
        );
      }
      if (c.status === "review")
        await append(
          "review",
          "**QM · Ready for human review**\n\nBoth agents have completed their work. Review Receiver’s recommendation and Sender’s challenge above. No payment, reversal or billing action has been executed. These are fictional records, and this is a simulation within one QM organization.",
        );
      if (c.status === "needs_attention")
        await append(
          `error:${c.jobs.map((j) => `${j.id}:${j.rejectedRuns?.length ?? 0}`).join("|")}`,
          `**QM · Needs attention**\n\nAn agent reply could not be accepted. The debug view contains the validation or runtime details.\n\nSend \`/payment retry\` to request bounded recovery, or inspect the [debug view](/payment-cases).`,
        );
      const saved = await deps.sessions.getEntries(session.id);
      const sendIndex = saved.findIndex(
        (e) => (e.payload as { paymentMessageKey?: string })?.paymentMessageKey === `${prefix}user:${input.sendKey}`,
      );
      const messages = saved
        .slice(sendIndex + 1)
        .filter(
          (e) =>
            e.type === "assistant" &&
            (e.payload as { paymentMessageKey?: string })?.paymentMessageKey?.startsWith(prefix),
        )
        .map((e) => (e.payload as { text: string }).text);
      return {
        handled: true as const,
        paymentCase: true as const,
        paymentSendKey: input.sendKey,
        status: "ok",
        caseStatus: c.status,
        sessionId: session.id,
        reply: messages.join("\n\n---\n\n"),
      };
    } finally {
      await deps.sessions.releaseLease(lease);
    }
  });
}
