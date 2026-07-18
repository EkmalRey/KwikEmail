export interface Env {
  DB: D1Database;
  API_KEY?: string;
}

export type AppVars = { keyId: string; isBootstrap: boolean };

export async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function ensureSeedKey(env: Env): Promise<void> {
  if (!env.API_KEY) return;
  const kh = await hashKey(env.API_KEY);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO api_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), "seed", kh, Date.now())
    .run();
}
