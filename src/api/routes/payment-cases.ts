import { advancePaymentChat, paymentChatSchema } from "../../payment-cases/chat.ts";
import { sendJson } from "../http.ts";
import { createPaymentCaseService, paymentReportSchema } from "../../payment-cases/demo.ts";
import type { ApiCtx, Route } from "./route.ts";

async function paymentCase(ctx: ApiCtx): Promise<void> {
  if (!ctx.actor || ctx.capability || ctx.actor.p.startsWith("payment-demo-"))
    return sendJson(ctx.res, 403, { error: "Human sign-in required" });
  if (!ctx.deps.paymentCases || !ctx.deps.advisoryLock || !ctx.deps.runs || !ctx.deps.sessions)
    return sendJson(ctx.res, 503, { error: "Payment demo is unavailable" });
  const service = createPaymentCaseService({
    store: ctx.deps.paymentCases,
    lock: ctx.deps.advisoryLock,
    turn: async (request) => {
      const principal = request.actor.externalId;
      const session = await ctx.deps.sessions!.getOrCreateByThread(
        request.conversation.threadRef,
        "dm",
        `personal:${principal}`,
        undefined,
        request.surface,
      );
      if (session.scopeId !== `personal:${principal}`) throw new Error("Institution session scope mismatch");
      await ctx.deps.sessions!.addParticipant(session.id, principal);
      await ctx.deps.sessions!.updateTitle(session.id, `${request.actor.displayName} · PAY-1042`);
      return ctx.app.turn(request);
    },
    run: (id) => ctx.deps.runs!.get(id),
  });
  const action = ctx.params.action;
  if (action === "chat") {
    const input = paymentChatSchema.safeParse(ctx.body);
    if (!input.success) return sendJson(ctx.res, 400, { error: "Invalid payment chat request" });
    try {
      const result = await advancePaymentChat(
        { service, store: ctx.deps.paymentCases, sessions: ctx.deps.sessions, lock: ctx.deps.advisoryLock },
        ctx.actor.p,
        input.data,
      );
      return sendJson(ctx.res, 200, result);
    } catch (error) {
      return sendJson(ctx.res, 409, { error: error instanceof Error ? error.message : "Payment chat unavailable" });
    }
  }
  if (
    ctx.method === "POST" &&
    action !== "start" &&
    action !== "advance" &&
    action !== "replay" &&
    action !== "retry" &&
    action !== "report"
  )
    return sendJson(ctx.res, 404, { error: "Not found" });
  const report = action === "report" ? paymentReportSchema.safeParse(ctx.body) : undefined;
  if (report && !report.success)
    return sendJson(ctx.res, 400, {
      error:
        "This fictional demo supports PAY-1042: 500000 USDC sent, 487000 credited, with a description of 1–600 characters.",
    });
  let mode: "continue" | "replay" | "retry" = "continue";
  if (action === "report" || action === "replay") mode = "replay";
  if (action === "retry") mode = "retry";
  const result =
    ctx.method === "GET"
      ? await service.get(ctx.actor.p)
      : await service.advance(
          ctx.actor.p,
          action === "start" || action === "replay" || action === "report",
          mode,
          report?.success ? report.data : undefined,
        );
  sendJson(ctx.res, 200, { case: result });
}
export const paymentCaseRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/payment-demo", auth: "source", handle: paymentCase },
  { method: "POST", path: "/v1/payment-demo/:action", auth: "source", handle: paymentCase },
];
