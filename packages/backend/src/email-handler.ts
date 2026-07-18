import PostalMime from "postal-mime";
import { Env } from "./db";

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  try {
    const address = message.to.trim().toLowerCase();
    const row = await env.DB.prepare("SELECT id FROM email_addresses WHERE lower(address) = ?")
      .bind(address).first<{ id: string }>();
    if (!row) {
      message.setReject("Unknown recipient");
      return;
    }
    const parsed = await PostalMime.parse(message.raw);
    await env.DB.prepare(
      "INSERT INTO emails (id, address_id, message_id, sender, from_addr, to_addr, subject, body_text, body_html, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), row.id, parsed.messageId || null, parsed.from?.address || null,
      parsed.from?.address || "", address, parsed.subject || null, parsed.text || null,
      parsed.html || null, Date.now()).run();
  } catch (error) {
    console.error("handleEmail failed", error);
    throw error;
  }
}
