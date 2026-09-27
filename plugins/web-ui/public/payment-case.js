const el = (id) => document.getElementById(id);
const labels = { sender: "Sender PSP", receiver: "Receiver PSP" };
let busy = false;
let active = false;
let needsAttention = false;
let timer;
let timelineKey = "";
let currentCase;
let activityFilter = "all";
function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function render(c) {
  if (!c) {
    el("intake").hidden = false;
    return;
  }
  currentCase = c;
  active = c.status === "investigating";
  needsAttention = c.status === "needs_attention";
  el("start").disabled = active;
  el("start").textContent = active
    ? "Investigation in progress…"
    : needsAttention
      ? "Retry pending step ↗"
      : "Report a new demo issue ↗";
  el("stage").textContent =
    {
      discovery: "1 · Reconcile records",
      pricing: "2 · Receiver checks PA-218",
      challenge: "3 · Sender challenges the deduction",
      recommendation: "4 · Prepare human recommendation",
      review: "Review evidence and proposed next steps",
    }[c.stage] || "Reconcile records";
  el("status").textContent = {
    investigating: "Agents investigating",
    review: "Ready for human review",
    needs_attention: "Needs attention",
  }[c.status];
  el("reported").hidden = !c.report;
  if (c.report)
    el("reported").textContent =
      "Reported · " +
      c.report.paymentId +
      " · " +
      new Intl.NumberFormat("en-US").format(c.report.sent) +
      " USDC sent / " +
      new Intl.NumberFormat("en-US").format(c.report.credited) +
      " credited. " +
      c.report.description +
      " — Unverified until checked against evidence.";
  el("error").hidden = !c.error;
  el("error").textContent = c.error || "";
  for (const name of ["transmitted", "received", "credited", "difference"])
    el(name).textContent =
      c.reconciliation[name] === null ? "—" : new Intl.NumberFormat("en-US").format(c.reconciliation[name]) + " USDC";
  el("adjustment").textContent = c.reconciliation.adjustmentReference
    ? "Adjustment " + c.reconciliation.adjustmentReference
    : "Awaiting evidence";
  for (const a of c.agents)
    el(a.institution + "-state").textContent =
      needsAttention && a.jobs.some((j) => j.status === "running")
        ? "Needs attention"
        : a.jobs.some((j) => j.status === "running")
          ? "Investigating"
          : a.jobs.some((j) => j.status === "pending")
            ? "Request received"
            : a.jobs.length
              ? "Findings published"
              : "Awaiting request";
  for (const a of c.agents) {
    el(a.institution + "-live").textContent = el(a.institution + "-state").textContent;
    const runs = new Set(
      a.jobs.flatMap((j) => [...(j.runId ? [j.runId] : []), ...(j.rejectedRuns || []).map((r) => r.runId)]),
    );
    const findings = c.events.filter((e) => e.institution === a.institution && e.kind === "finding").length;
    el(a.institution + "-count").textContent = runs.size + " model runs · " + findings + " published findings";
    el(a.institution + "-session").textContent =
      [...new Set(a.jobs.map((j) => j.sessionId).filter(Boolean))].join(", ") || "Created when the agent starts";
  }
  const nextKey = activityFilter + ":" + c.createdAt + ":" + c.status + ":" + c.events.map((e) => e.id).join(",");
  if (nextKey === timelineKey) return;
  timelineKey = nextKey;
  const timeline = el("timeline");
  timeline.replaceChildren();
  if (!c.events.length) {
    timeline.append(
      node("div", "Agents are reviewing their own records. Findings will appear here when published.", "empty"),
    );
    return;
  }
  if (c.status === "review")
    timeline.append(
      node(
        "div",
        c.version === 2
          ? "Pricing review and Sender challenge are complete. The recommendation below is advisory; any correction or separate billing requires human approval."
          : "Discrepancy established from published records. Run a fresh investigation to add PA-218 pricing review and a Sender challenge.",
        "review",
      ),
    );
  const ordered = [
    ...c.events.filter((e) => e.stage === "recommendation"),
    ...c.events.filter((e) => e.stage !== "recommendation"),
  ];
  const visible = ordered.filter(
    (e) =>
      activityFilter === "all" ||
      (activityFilter === "requests" ? e.kind === "request" : e.institution === activityFilter),
  );
  if (!visible.length) timeline.append(node("p", "No published activity for this view yet.", "empty"));
  for (const e of visible) {
    const card = node("article", undefined, "event" + (e.kind === "request" ? " request" : ""));
    const top = node("div", undefined, "event-top");
    top.append(
      node("strong", labels[e.institution]),
      node(
        "span",
        e.kind === "request"
          ? "→ " + labels[e.to]
          : {
              pricing: "Pricing assessment",
              challenge: "Sender challenge",
              recommendation: "Recommendation · human approval required",
            }[e.stage] || "Finding",
      ),
      node("time", new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
    );
    card.append(top, node("p", e.text));
    for (const evidence of e.evidence) {
      const d = node("details", undefined, "evidence");
      d.append(node("summary", evidence.id + " · " + evidence.title));
      const dl = node("dl");
      for (const [k, v] of Object.entries(evidence.facts)) dl.append(node("dt", k), node("dd", String(v)));
      d.append(dl);
      card.append(d);
    }
    card.append(node("small", "QM run " + e.runId + (e.sessionId ? " · Session " + e.sessionId : ""), "provenance"));
    timeline.append(card);
  }
}
async function request(action, payload = {}) {
  if (busy) return;
  busy = true;
  clearTimeout(timer);
  try {
    const response = await fetch("/api/payment-demo" + (action ? "/" + action : ""), {
      method: action ? "POST" : "GET",
      headers: action ? { "content-type": "application/json" } : {},
      body: action ? JSON.stringify(payload) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Could not load case");
    if (action === "report") {
      el("intake").hidden = true;
      activityFilter = "all";
    }
    render(data.case);
  } catch (error) {
    if (action === "report") {
      el("report-error").hidden = false;
      el("report-error").textContent = error.message;
    }
    el("error").hidden = false;
    el("error").textContent = error.message;
  } finally {
    busy = false;
    if (active) timer = setTimeout(() => request("advance"), 2500);
  }
}
el("start").addEventListener("click", () => {
  if (needsAttention) return request("retry");
  el("intake").hidden = false;
  el("report-description").focus();
});
el("cancel-report").addEventListener("click", () => {
  el("intake").hidden = true;
});
el("report-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  el("report-error").hidden = true;
  el("submit-report").disabled = true;
  await request("report", {
    paymentId: el("report-id").value,
    currency: el("report-currency").value,
    sent: Number(el("report-sent").value),
    credited: Number(el("report-credited").value),
    description: el("report-description").value,
  });
  el("submit-report").disabled = false;
});
for (const button of document.querySelectorAll("[data-filter]"))
  button.addEventListener("click", () => {
    activityFilter = button.dataset.filter;
    if (currentCase) render(currentCase);
    el("timeline").scrollIntoView({ behavior: "smooth", block: "start" });
  });
request();
