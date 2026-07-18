import { Hono } from "hono";
import { Env } from "./db";
import { apiApp } from "./api";
import { handleEmail } from "./email-handler";

const app = new Hono<{ Bindings: Env }>();
app.route("/api", apiApp);
app.get("/health", (c) => c.json({ status: "ok" }));

export default {
  fetch: app.fetch,
  email: (message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) => ctx.waitUntil(handleEmail(message, env)),
  scheduled: (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) =>
    ctx.waitUntil(env.DB.prepare("DELETE FROM emails WHERE received_at < ?").bind(Date.now() - 86_400_000).run()),
};
