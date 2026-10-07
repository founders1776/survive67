/**
 * Telegram bot — the operator's ONLY channel (UX decision, plan UX Q8).
 * Disabled mode (no token): messages collect in an outbox for tests/dev.
 *
 * Messages are plain text (no parse_mode): agent-written bodies routinely
 * contain _ and * and Telegram's Markdown rejects the whole message when they
 * are unbalanced. Emoji and unicode bars carry the formatting instead.
 *
 * Wiring (NEEDS-JAMES): create bot via @BotFather, put TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID (James's chat) in the control plane env.
 */

export interface TelegramButton {
  text: string;
  data: string; // callback_data, ≤64 bytes
}

export interface TelegramMessage {
  text: string;
  /** shortcut: attaches the standard request buttons (approve / deny / reply) */
  requestId?: number;
  /** explicit inline keyboard, rows of buttons */
  buttons?: TelegramButton[][];
}

export interface OperatorAction {
  kind: "callback" | "reply";
  /** callback_data for callbacks */
  data?: string;
  /** message text for replies */
  text?: string;
}

export interface BotCommand {
  command: string;
  description: string;
}

export function requestButtons(requestId: number): TelegramButton[][] {
  return [
    [
      { text: "✅ Approve", data: `approve:${requestId}` },
      { text: "❌ Deny", data: `deny:${requestId}` },
      { text: "💬 Reply", data: `note:${requestId}` },
    ],
  ];
}

export class TelegramBot {
  public outbox: TelegramMessage[] = []; // captured when disabled (tests)
  private offset = 0;
  private enabled: boolean;

  constructor(
    private token = process.env.TELEGRAM_BOT_TOKEN ?? "",
    private chatId = process.env.TELEGRAM_CHAT_ID ?? ""
  ) {
    this.enabled = Boolean(this.token && this.chatId);
  }

  async send(msg: TelegramMessage): Promise<void> {
    if (!this.enabled) {
      this.outbox.push(msg);
      return;
    }
    const buttons = msg.buttons ?? (msg.requestId !== undefined ? requestButtons(msg.requestId) : undefined);
    const body: Record<string, unknown> = {
      chat_id: this.chatId,
      text: msg.text.slice(0, 4000),
      disable_web_page_preview: true,
    };
    if (buttons) {
      body.reply_markup = {
        inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
      };
    }
    await this.api("sendMessage", body);
  }

  /** Registers the "/" command menu Telegram shows in the chat. */
  async setCommands(commands: BotCommand[]): Promise<void> {
    if (!this.enabled) return;
    await this.api("setMyCommands", { commands });
  }

  /**
   * Long-poll for operator actions. Only messages/callbacks from the configured chat
   * count — anyone else messaging the bot is ignored (single-operator world).
   */
  async poll(): Promise<OperatorAction[]> {
    if (!this.enabled) return [];
    const updates = (await this.api("getUpdates", {
      offset: this.offset,
      timeout: 25,
      allowed_updates: ["message", "callback_query"],
    })) as any[];
    const actions: OperatorAction[] = [];
    for (const u of updates) {
      this.offset = u.update_id + 1;
      const cb = u.callback_query;
      if (cb && String(cb.message?.chat?.id) === this.chatId) {
        if (typeof cb.data === "string") actions.push({ kind: "callback", data: cb.data });
        await this.api("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      }
      const m = u.message;
      if (m && String(m.chat?.id) === this.chatId && typeof m.text === "string") {
        actions.push({ kind: "reply", text: m.text });
      }
    }
    return actions;
  }

  private async api(method: string, body: unknown): Promise<unknown> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
    return json.result;
  }
}
