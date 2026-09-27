const el = (id) => document.getElementById(id);
const labels = { sender: "Sender PSP", receiver: "Receiver PSP" };
let busy = false;
let active = false;
let saved = false;
let timer;
let timelineKey = "";
function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function render(c) {
  if (!c) return;
  active = c.status === "investigating";
  saved = true;
  el("start").disabled = active;
  el("start").textContent = active ? "Investigation in progress…" : "Run a fresh investigation ↗";
  el("status").textContent = {
    investigating: "Agents investigating",
    review: "Ready for human review",
    needs_attention: "Needs attention",
  }[c.status];
  el("error").hidden = !c.error;
  el("error").textContent = c.error || "";
  for (const name of ["transmitted", "received", "credited", "difference"])
    el(name).textContent =
      c.reconciliation[name] === null ? "—" : new Intl.NumberFormat("en-US").format(c.reconciliation[name]) + " USDC";
  el("adjustment").textContent = c.reconciliation.adjustmentReference
    ? "Adjustment " + c.reconciliation.adjustmentReference
    : "Awaiting evidence";
  for (const a of c.agents)
    el(a.institution + "-state").textContent = a.jobs.some((j) => j.status === "running")
      ? "Investigating"
      : a.jobs.some((j) => j.status === "pending")
        ? "Request received"
        : a.jobs.length
          ? "Findings published"
          : "Awaiting request";
  const nextKey = c.createdAt + ":" + c.status + ":" + c.events.map((e) => e.id).join(",");
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
        "Discrepancy established from published records. The adjustment references PA-218; responsibility for the charge remains unresolved and requires human review.",
        "review",
      ),
    );
  for (const e of c.events) {
    const card = node("article", undefined, "event" + (e.kind === "request" ? " request" : ""));
    const top = node("div", undefined, "event-top");
    top.append(
      node("strong", labels[e.institution]),
      node("span", e.kind === "request" ? "→ " + labels[e.to] : "Finding"),
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
async function request(action) {
  if (busy) return;
  busy = true;
  clearTimeout(timer);
  try {
    const response = await fetch("/api/payment-demo" + (action ? "/" + action : ""), {
      method: action ? "POST" : "GET",
      headers: action ? { "content-type": "application/json" } : {},
      body: action ? "{}" : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Could not load case");
    render(data.case);
  } catch (error) {
    el("error").hidden = false;
    el("error").textContent = error.message;
  } finally {
    busy = false;
    if (active) timer = setTimeout(() => request("advance"), 2500);
  }
}
el("start").addEventListener("click", () => request(saved ? "replay" : "start"));
request();
