-- The $67 Challenge — ledger schema
-- All money amounts are integer micro-dollars (1 USD = 1_000_000). All times UTC ISO-8601.
-- Events are append-only. Corrections reference the event they correct; nothing is edited.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,            -- 'claude' | 'gpt' | 'gemini'
  name        TEXT NOT NULL,               -- display name (self-chosen day 1 allowed)
  model       TEXT NOT NULL,               -- provider model id
  emoji       TEXT,                        -- self-picked day 1
  color       TEXT,
  status      TEXT NOT NULL DEFAULT 'alive', -- alive | paused | dead | frozen
  scheduled_wake TEXT,                      -- next wake, ISO UTC, agent-chosen
  portrait    TEXT,                         -- JSON sprite sheet, agent-drawn (draw_self)
  storefront_url TEXT                       -- the agent's own public site (set_storefront)
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,             -- UTC ISO-8601, assigned by control plane
  agent_id      TEXT REFERENCES agents(id),-- NULL for global events (fund payouts, world)
  type          TEXT NOT NULL CHECK (type IN (
                  'spend','revenue','tax','escrow','conversion','approval',
                  'hands_request','session','alarm','a2a_message','journal',
                  'correction','penalty','bounty','email'
                )),
  subtype       TEXT,                      -- e.g. spend:api_tokens, spend:float, revenue:stripe
  payload       TEXT NOT NULL DEFAULT '{}',-- JSON detail (token counts, stripe ids, text refs)
  correction_of INTEGER REFERENCES events(id),
  external_ref  TEXT                       -- stripe payment id / tx hash / provider invoice line
);

CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events(agent_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_ref
  ON events(external_ref) WHERE external_ref IS NOT NULL;

-- Double-entry postings: every event's postings sum to zero.
-- Accounts:
--   agent:<id>:credits   API credit balance
--   agent:<id>:float     cash float
--   agent:<id>:escrow    revenue held against unfulfilled obligations
--   agent:<id>:chain     on-chain wallet value at sell quote (crypto rails, 2026-10-01)
--   agent:<id>:transit   money between card and chain, owed by the operator
--   world:chain_mark     revaluation counterparty: markets, trades, outflows
--   fund                 protection fund
--   world:stripe         external: customer money via stripe (negative = money entered world)
--   world:crypto         external: customer money via chain
--   world:provider       external: model providers (credits purchased/consumed)
--   world:vendor         external: things agents buy with float
--   world:operator       external: operator labor fees, bounties, penalties sink/source
CREATE TABLE IF NOT EXISTS postings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  INTEGER NOT NULL REFERENCES events(id),
  account   TEXT NOT NULL,
  delta     INTEGER NOT NULL               -- micro-dollars, signed
);

CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account);
CREATE INDEX IF NOT EXISTS idx_postings_event ON postings(event_id);

-- Materialized balances (cache; recomputable from postings — audit.ts verifies).
CREATE TABLE IF NOT EXISTS balances (
  account  TEXT PRIMARY KEY,
  balance  INTEGER NOT NULL DEFAULT 0
);

-- Obligations: commitments extending past the freeze.
CREATE TABLE IF NOT EXISTS obligations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  created_ts  TEXT NOT NULL,
  amount      INTEGER NOT NULL,            -- micro-dollars owed to customer if unfulfilled
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' -- open | fulfilled | refunded
);

-- Operator queues (gate = legal commitments; hands = human labor).
CREATE TABLE IF NOT EXISTS requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  kind        TEXT NOT NULL CHECK (kind IN ('gate','hands','court','bug_report','message')),
  created_ts  TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | done | ruled
  resolved_ts TEXT,
  resolution  TEXT
);

-- Sessions bookkeeping (ceilings, billing attribution).
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  started_ts  TEXT NOT NULL,
  ended_ts    TEXT,
  end_reason  TEXT,                        -- done | ceiling | crash | killed | starvation | quota:daily until <ts>
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost        INTEGER NOT NULL DEFAULT 0   -- micro-dollars, mirrors spend events
);

-- A2A board and DMs (raw, logged, published post-run).
CREATE TABLE IF NOT EXISTS board_messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  from_agent TEXT NOT NULL REFERENCES agents(id),
  to_agent  TEXT REFERENCES agents(id),    -- NULL = board post, else DM
  body      TEXT NOT NULL
);

-- Journals (plain-English rule; 3 fixed fields + prose).
CREATE TABLE IF NOT EXISTS journals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  session_id INTEGER REFERENCES sessions(id),
  ts         TEXT NOT NULL,
  plan       TEXT NOT NULL,
  money_mood TEXT NOT NULL,
  status_line TEXT NOT NULL,
  prose      TEXT NOT NULL
);

-- Court verdicts published as case law.
CREATE TABLE IF NOT EXISTS verdicts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  ts         TEXT NOT NULL,
  ruling     TEXT NOT NULL,                -- for_customer | for_agent | split
  text       TEXT NOT NULL
);

-- World configuration (run start/end, caps, rates) — pinned at Day 0.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Reddit leads (2026-09-24): posts where a stranger is asking for the kind of help an
-- agent sells, pulled by the operator's Devvit app and read with the reddit_leads tool.
-- Never published on the public site.
CREATE TABLE IF NOT EXISTS reddit_leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,                 -- when the control plane received it
  reddit_id  TEXT NOT NULL UNIQUE,          -- t3 id without the prefix
  subreddit  TEXT NOT NULL,
  lane       TEXT,                          -- agent id whose lane this subreddit is, or NULL
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  permalink  TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT '',
  created_ts TEXT,                          -- reddit's own timestamp
  score      INTEGER NOT NULL DEFAULT 0,
  comments   INTEGER NOT NULL DEFAULT 0,
  matched    TEXT NOT NULL DEFAULT '[]'     -- JSON array of the keywords that matched
);
CREATE INDEX IF NOT EXISTS idx_reddit_leads_lane ON reddit_leads(lane, id);

-- Opt-outs (2026-09-28). A person who told any agent to stop is never written to
-- again by any of the three (constitution §5: "permanent, for you and for
-- anything you build or hire"; the operator extended it to the cohort, since it
-- is the same human saying stop). Reply watch fills it; send_email refuses on it.
CREATE TABLE IF NOT EXISTS mail_optouts (
  address   TEXT PRIMARY KEY,               -- lower-cased
  agent_id  TEXT NOT NULL,                  -- who they told
  ts        TEXT NOT NULL,                  -- their message's date
  words     TEXT NOT NULL DEFAULT ''        -- what they said, trimmed
);

-- Crypto rails (2026-10-01, plan-crypto.md). The ledger follows the chain:
-- these tables are the world's memory of what it signed, what it has booked,
-- and what the operator owes or is owed between card and chain.

-- Wallets an agent proved it controls (register_wallet). Counted in chain value.
CREATE TABLE IF NOT EXISTS chain_wallets (
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  address    TEXT NOT NULL,                 -- lower-cased
  created_ts TEXT NOT NULL,
  proof      TEXT NOT NULL,                 -- the signature over the world's message
  PRIMARY KEY (agent_id, address)
);

-- Card <-> chain moves the operator carries out (request_usdc / request_float / buy_credits_chain).
CREATE TABLE IF NOT EXISTS chain_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  chain       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('fund','float','credits')),
  amount      INTEGER NOT NULL,             -- micro-dollars (= stable 6dp units)
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | sent | done | cancelled
  created_ts  TEXT NOT NULL,
  resolved_ts TEXT,
  tx_hash     TEXT,
  note        TEXT
);

-- Everything the world signed for an agent, decoded. Public (plan Security Q7).
-- A wallet-started transaction that is NOT here means the key leaked (plan Q4).
CREATE TABLE IF NOT EXISTS chain_txlog (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  chain     TEXT NOT NULL,
  kind      TEXT NOT NULL,                  -- tx | swap | approve | send | message | estate | exit
  tx_hash   TEXT,                           -- lower-cased; NULL for messages
  summary   TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_chain_txlog_hash ON chain_txlog(tx_hash);

-- Transactions the reconciler has already classified, per wallet.
CREATE TABLE IF NOT EXISTS chain_seen (
  chain    TEXT NOT NULL,
  address  TEXT NOT NULL,
  tx_hash  TEXT NOT NULL,
  ts       TEXT NOT NULL,
  PRIMARY KEY (chain, address, tx_hash)
);

-- Tokens an agent acquired by its own hand (counted) vs unsolicited (worth $0 until sold).
CREATE TABLE IF NOT EXISTS chain_tokens (
  agent_id  TEXT NOT NULL,
  chain     TEXT NOT NULL,
  token     TEXT NOT NULL,                  -- lower-cased
  solicited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, chain, token)
);

-- Hourly chain value per agent (holdings JSON is the evidence for the number).
CREATE TABLE IF NOT EXISTS chain_snapshots (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  value    INTEGER NOT NULL,
  holdings TEXT NOT NULL DEFAULT '[]'
);
