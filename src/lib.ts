import { XMLParser } from "fast-xml-parser";
import * as v from "valibot";

const BASE_TOPIC_URL = "https://www.youtube.com/xml/feeds/videos.xml?channel_id=";
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";

type Subscription = {
  channelId: string;
  lastSubscribed: Date;
};

export class YoutubeNotifier {
  constructor(private env: Env) {}

  public async getAllSubscriptions() {
    return JSON.parse((await this.env.KV.get("subscriptions")) || "[]") as Subscription[];
  }

  public async addSubscription(channelId: string) {
    const subscriptions = await this.getAllSubscriptions();
    if (subscriptions.find((s) => s.channelId === channelId)) return;
    const subscribed = await requestSubscription({
      mode: "subscribe",
      channelId,
      secret: this.env.API_SECRET,
      callbackUrl: `https://${this.env.APP_DOMAIN}/callback`,
    });
    if (!subscribed) throw new Error("Failed to subscribe");
    subscriptions.push({ channelId, lastSubscribed: new Date() });
    await this.env.KV.put("subscriptions", JSON.stringify(subscriptions));
  }

  public async removeSubscription(channelId: string) {
    const subscriptions = await this.getAllSubscriptions();
    if (!subscriptions.find((s) => s.channelId === channelId)) return;
    const unsubscribed = await requestSubscription({
      mode: "unsubscribe",
      channelId,
      secret: this.env.API_SECRET,
      callbackUrl: `https://${this.env.APP_DOMAIN}/callback`,
    });
    if (!unsubscribed) throw new Error("Failed to unsubscribe");
    const updatedSubscriptions = subscriptions.filter((s) => s.channelId !== channelId);
    await this.env.KV.put("subscriptions", JSON.stringify(updatedSubscriptions));
  }

  public async renewAll() {
    const subscriptions = await this.getAllSubscriptions();
    const updatedSubscriptions: Subscription[] = [];
    for (const subscription of subscriptions) {
      const subscribed = await requestSubscription({
        mode: "subscribe",
        channelId: subscription.channelId,
        secret: this.env.API_SECRET,
        callbackUrl: `https://${this.env.APP_DOMAIN}/callback`,
      });
      if (!subscribed) discordLog(this.env.DISCORD_WEBHOOK_URL, `Failed to renew subscription for ${subscription.channelId}`);
      updatedSubscriptions.push({ channelId: subscription.channelId, lastSubscribed: new Date() });
    }
    await this.env.KV.put("subscriptions", JSON.stringify(updatedSubscriptions));
  }

  public async callback(xml: string, signature?: string) {
    if (!signature || !(await verifyNotificationSignature(this.env.API_SECRET, signature, xml))) throw new Error("Invalid signature");
    const parser = new XMLParser();
    const data = parser.parse(xml);

    const callbackData = v.safeParse(callbackSchema, data);
    if (!callbackData.success) return;
    if (!callbackData.output) return;

    await sendDiscordNotification(this.env.DISCORD_WEBHOOK_URL, callbackData.output);
  }
}

export const requestSubscription = async ({
  channelId,
  mode,
  secret,
  callbackUrl,
}: {
  mode: "subscribe" | "unsubscribe";
  channelId: string;
  secret: string;
  callbackUrl: string;
}) => {
  const topic = BASE_TOPIC_URL + channelId;
  const body = new URLSearchParams({
    "hub.callback": callbackUrl,
    "hub.mode": mode,
    "hub.topic": topic,
    "hub.secret": secret,
    "hub.verify": "sync",
  });
  const response = await fetch(HUB_URL, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!response.ok) return false;
  return true;
};

export const verifyNotificationSignature = async (secret: string, signature: string, xml: string) => {
  const [algo, matchingParts] = signature.split("=");
  const algorithm = { name: "HMAC", hash: { name: algo.toUpperCase().replace("SHA", "SHA-") } };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), algorithm, false, ["sign"]);
  const signatureArrayBuffer = await crypto.subtle.sign(algorithm.name, key, new TextEncoder().encode(xml));
  const signatureHex = Array.from(new Uint8Array(signatureArrayBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return signatureHex.toLowerCase() === matchingParts.toLowerCase();
};

export const discordLog = async (webhookUrl: string, message: string) =>
  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });

export const callbackSchema = v.pipe(
  v.object({
    feed: v.union([
      v.object({ "at:deleted-entry": v.unknown() }),
      v.object({
        entry: v.optional(
          v.object({
            "yt:videoId": v.string(),
            title: v.string(),
            "yt:channelId": v.string(),
            author: v.object({
              name: v.string(),
              uri: v.string(),
            }),
            published: v.date(),
            updated: v.date(),
          }),
        ),
      }),
    ]),
  }),
  v.transform((data) => {
    if ("at:deleted-entry" in data.feed) return null;
    if (!data.feed.entry) return null;
    const video = data.feed.entry;
    return {
      video: {
        id: video["yt:videoId"],
        title: video.title,
        link: `https://www.youtube.com/watch?v=${video["yt:videoId"]}`,
      },
      channel: {
        id: video["yt:channelId"],
        name: video.author.name,
        link: video.author.uri,
      },
      published: video.published.getTime(),
      updated: video.updated.getTime(),
    };
  }),
);

type VideoData = NonNullable<v.InferOutput<typeof callbackSchema>>;

export const sendDiscordNotification = async (webhookUrl: string, video: VideoData) =>
  discordLog(
    webhookUrl,
    [
      `New video from [${video.channel.name}](${video.channel.link})`,
      `**${video.video.title}**`,
      ` ${video.video.link}`,
      "",
      `Published at <t:${Math.floor(video.published / 1000)}:f>`,
      `Updated at <t:${Math.floor(video.updated / 1000)}:f>`,
    ].join("\n"),
  );
