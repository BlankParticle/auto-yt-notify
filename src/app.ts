import { vValidator } from "@hono/valibot-validator";
import { YoutubeNotifier, discordLog } from "./lib";
import { Hono } from "hono/tiny";
import * as v from "valibot";

const app = new Hono<{ Bindings: Env; Variables: { yt: YoutubeNotifier } }>();

app
  .use("*", async (c, next) => {
    c.set("yt", new YoutubeNotifier(c.env));
    await next();
  })
  .get("/", (c) => c.json({ message: "Youtube Notifier is running!" }))
  .use("/api/*", async (c, next) =>
    c.req.header("Authorization") !== `Bearer ${c.env.API_SECRET}` ? c.json({ error: "Unauthorized" }, 401) : next(),
  )
  .get("/api/subscriptions", (c) => c.json(c.var.yt.getAllSubscriptions()))
  .post("/api/subscribe", vValidator("json", v.object({ channelId: v.string() })), (c) =>
    c.var.yt.addSubscription(c.req.valid("json").channelId).then(() => c.json({ message: "Subscribed!" })),
  )
  .post("/api/unsubscribe", vValidator("json", v.object({ channelId: v.string() })), (c) =>
    c.var.yt.removeSubscription(c.req.valid("json").channelId).then(() => c.json({ message: "Unsubscribed!" })),
  )
  .post("/api/force-renew", async (c) => {
    await c.var.yt.renewAll();
    return c.json({ message: "Forced Renewal Done!" });
  })
  .get("/callback", vValidator("query", v.object({ "hub.challenge": v.string() })), (c) => c.text(c.req.valid("query")["hub.challenge"]))
  .post("/callback", async (c) =>
    c.var.yt
      .callback(await c.req.text(), c.req.header("x-hub-signature"))
      .then(() => c.text("OK"))
      .catch((err) => {
        console.error(err);
        return c.text(`Error: ${err.message}`, 500);
      }),
  )
  .onError(async (err, c) => {
    await discordLog(c.env.DISCORD_WEBHOOK_URL, `Encountered an Error\n${err.stack}`);
    console.error(err);
    return c.json({ message: "Something went wrong" });
  });

export default {
  fetch: app.fetch,
  scheduled: async (_, env) => await new YoutubeNotifier(env).renewAll(),
} satisfies ExportedHandler<Env>;
