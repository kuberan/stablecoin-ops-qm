import { sendJson } from "../http.ts";
import { createPaymentCaseService } from "../../payment-cases/demo.ts";
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
  if (ctx.method === "POST" && action !== "start" && action !== "advance" && action !== "replay")
    return sendJson(ctx.res, 404, { error: "Not found" });
  const result =
    ctx.method === "GET"
      ? await service.get(ctx.actor.p)
      : await service.advance(ctx.actor.p, action === "start" || action === "replay", action === "replay");
  sendJson(ctx.res, 200, { case: result });
}
export const paymentCaseRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/payment-demo", auth: "source", handle: paymentCase },
  { method: "POST", path: "/v1/payment-demo/:action", auth: "source", handle: paymentCase },
];
