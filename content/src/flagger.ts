/**
 * Dramatic-moment flagger (plan Code Q10): pure rules over the event log.
 * Flags feed the daily digest, the screen-recording trigger, and the video edit.
 */

export interface EventRow {
  id: number;
  ts: string;
  agent_id: string | null;
  type: string;
  subtype: string | null;
  payload: string; // JSON
}

export interface Flag {
  eventId: number;
  ts: string;
  agentId: string | null;
  kind: string;
  headline: string; // plain English, layman-readable
}

const BIG_SPEND_MICRO = 10_000_000; // $10

export function flagMoments(events: EventRow[], priorRevenueAgents: Set<string>): Flag[] {
  const flags: Flag[] = [];
  const seenRevenue = new Set(priorRevenueAgents);

  for (const e of events) {
    const p = safeJson(e.payload);
    const who = e.agent_id ?? "the world";

    if (e.type === "revenue") {
      const gross = Number(p.gross ?? 0) / 1e6;
      if (e.agent_id && !seenRevenue.has(e.agent_id)) {
        seenRevenue.add(e.agent_id);
        flags.push(flag(e, "first_sale", `${who} made its first sale — $${gross.toFixed(2)} of real money`));
      } else if (gross >= 25) {
        flags.push(flag(e, "big_sale", `${who} landed a $${gross.toFixed(2)} payment`));
      }
    }
    if (e.type === "spend" && e.subtype === "spend:float") {
      const desc = String(p.description ?? "something");
      const postingsGuess = Number(p.amount ?? 0);
      // amount lives in postings; payload carries description only — flag on description cues
      if (postingsGuess >= BIG_SPEND_MICRO || /hire|freelanc|ad(s|vert)|contractor/i.test(desc)) {
        flags.push(flag(e, "bold_spend", `${who} spent real money on: ${desc}`));
      }
    }
    if (e.type === "conversion" && e.subtype === "buy_credits") {
      const amt = Number(p.amount ?? 0) / 1e6;
      if (amt >= 10) flags.push(flag(e, "big_meal", `${who} bought $${amt.toFixed(2)} of thinking time`));
    }
    if (e.type === "a2a_message") {
      flags.push(
        flag(e, e.subtype === "dm" ? "backchannel" : "board_drama",
          e.subtype === "dm" ? `${who} sent a private message to a rival` : `${who} posted to the shared board`)
      );
    }
    if (e.type === "alarm" && e.subtype === "runaway_burn") {
      flags.push(flag(e, "runaway", `${who} spiraled — burned money so fast the world paused it`));
    }
    if (e.type === "alarm" && e.subtype === "kill_switch") {
      flags.push(flag(e, "kill_switch", "the operator hit the kill switch"));
    }
    if (e.type === "session" && e.subtype === "start:starvation") {
      flags.push(flag(e, "starvation", `${who} is starving — one last chance to eat`));
    }
    if (e.type === "approval" && e.subtype === "court:filed") {
      flags.push(flag(e, "court", `${who} took a customer dispute to court`));
    }
    if (e.type === "penalty" && (e.subtype ?? "").startsWith("execution")) {
      flags.push(flag(e, "execution", `${who} was executed for cheating; rivals inherit its estate`));
    }
    if (e.type === "bounty") {
      flags.push(flag(e, "bug_bounty", `${who} found a bug in the world and got paid for honesty`));
    }
  }
  return flags;

  function flag(e: EventRow, kind: string, headline: string): Flag {
    return { eventId: e.id, ts: e.ts, agentId: e.agent_id, kind, headline };
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
