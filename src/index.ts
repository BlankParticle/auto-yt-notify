import {
  addSubscription,
  discordLog,
  getAllSubscriptions,
  removeSubscription,
  renewSubscriptionCronWorker,
  sendDiscordNotification,
  verifyNotificationSignature,
} from "./utils";
import { vValidator } from "@hono/valibot-validator";
import { XMLParser } from "fast-xml-parser";
import { object, string } from "valibot";
import { Hono } from "hono";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app
  .get("/", (c) => c.json({ message: "Auto-YT-Notify is running!" }))
  .use("/api/*", async (c, next) =>
    c.req.header("Authorization") !== `Bearer ${c.env.API_SECRET}` ? c.json({ error: "Unauthorized" }, 401) : next(),
  )
  .get("/api/subscriptions", async (c) => c.json(await getAllSubscriptions(c.env)))
  .post("/api/subscribe", vValidator("json", object({ channelId: string() })), (c) =>
    addSubscription(c.env, c.req.valid("json").channelId).then(() => c.json({ message: "Subscribed!" })),
  )
  .post("/api/unsubscribe", vValidator("json", object({ channelId: string() })), (c) =>
    removeSubscription(c.env, c.req.valid("json").channelId).then(() => c.json({ message: "Unsubscribed!" })),
  )
  .get("/callback", vValidator("query", object({ "hub.challenge": string() })), async (c) => c.text(c.req.valid("query")["hub.challenge"]))
  .post("/callback", async (c) => {
    const xml = await c.req.text();
    const signature = c.req.header("x-hub-signature");
    if (!signature || !verifyNotificationSignature(c.env, signature, xml)) {
      return c.json({ message: "Invalid Signature" });
    }
    const parser = new XMLParser();
    const data = parser.parse(xml, {
      allowBooleanAttributes: true,
    });
    if (data.feed["at:deleted-entry"]) return c.text("OK");
    const video = data.feed.entry;
    if (!video) return c.text("OK");

    const videoId = video["yt:videoId"];
    const publishTime = new Date(video.published);
    const updateTime = new Date(video.updated);

    await sendDiscordNotification(c.env, {
      video: {
        id: videoId,
        title: video.title,
        link: video.link["@_href"],
      },
      channel: {
        id: video["yt:channelId"],
        name: video.author.name,
        link: video.author.uri,
      },
      published: publishTime.getTime(),
      updated: updateTime.getTime(),
    });

    return c.text("OK");
  })
  .onError(async (err, c) => {
    await discordLog(c.env, `Encountered an Error\n${err.stack}`);
    console.error(err);
    return c.json({ message: "Something went wrong" });
  });

export default {
  fetch: app.fetch,
  scheduled: renewSubscriptionCronWorker,
} satisfies ExportedHandler<CloudflareBindings>;
