import { array, number, object, safeParse, string } from "valibot";
import dedent from "dedent";

const BASE_TOPIC_URL = "https://www.youtube.com/xml/feeds/videos.xml?channel_id=";
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const SUBSCRIPTION_KV_KEY = "auto-yt-notify-subscriptions";

const requestSubscription = async ({
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

const subscription = object({
  channelId: string(),
  lastSubscribedAt: number(),
});

export const getAllSubscriptions = async (env: CloudflareBindings) => {
  const subscriptions = await env.KV.get(SUBSCRIPTION_KV_KEY);
  if (!subscriptions) return [];
  const subscriptionsRes = safeParse(array(subscription), JSON.parse(subscriptions));
  if (!subscriptionsRes.success) {
    await env.KV.delete(SUBSCRIPTION_KV_KEY);
    return [];
  } else {
    return subscriptionsRes.output;
  }
};

export const addSubscription = async (env: CloudflareBindings, channelId: string) => {
  const allSubscriptions = await getAllSubscriptions(env);
  if (allSubscriptions.find((s) => s.channelId === channelId)) return;
  const subscribed = await requestSubscription({
    mode: "subscribe",
    channelId,
    secret: env.API_SECRET,
    callbackUrl: `https://${env.APP_DOMAIN}/callback`,
  });
  if (!subscribed) throw new Error("Failed to subscribe!");
  allSubscriptions.push({ channelId, lastSubscribedAt: Date.now() });
  await env.KV.put(SUBSCRIPTION_KV_KEY, JSON.stringify(allSubscriptions));
};

export const removeSubscription = async (env: CloudflareBindings, channelId: string) => {
  const allSubscriptions = await getAllSubscriptions(env);
  if (!allSubscriptions.find((s) => s.channelId === channelId)) return;
  const unsubscribed = await requestSubscription({
    mode: "unsubscribe",
    channelId,
    secret: env.API_SECRET,
    callbackUrl: `${env.APP_DOMAIN}/callback`,
  });
  if (!unsubscribed) throw new Error("Failed to unsubscribe!");
  const subscriptions = allSubscriptions.filter((s) => s.channelId !== channelId);
  await env.KV.put(SUBSCRIPTION_KV_KEY, JSON.stringify(subscriptions));
};

export const verifyNotificationSignature = async (env: CloudflareBindings, signature: string, xml: string) => {
  const [algo, matchingParts] = signature.split("=").map((part) => part.toLowerCase());
  const algorithm = {
    name: "HMAC",
    hash: { name: algo.toUpperCase() },
  };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.API_SECRET), algorithm, false, ["sign"]);
  const signatureArrayBuffer = await crypto.subtle.sign(algorithm.name, key, new TextEncoder().encode(xml));
  const signatureHex = Array.from(new Uint8Array(signatureArrayBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return signatureHex.toLowerCase() === matchingParts;
};

export const discordLog = async (env: CloudflareBindings, message: string) => {
  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });
};

type VideoData = {
  video: {
    id: string;
    title: string;
    link: string;
  };
  channel: {
    id: string;
    name: string;
    link: string;
  };
  published: number;
  updated: number;
};

export const sendDiscordNotification = async (env: CloudflareBindings, video: VideoData) => {
  await discordLog(
    env,
    dedent`New video from [${video.channel.name}](${video.channel.link})
    **${video.video.title}**
    ${video.video.link ?? "*Link unavailable*"}
    
    Published at <t:${Math.floor(video.published / 1000)}:f>
    Updated at <t:${Math.floor(video.updated / 1000)}:f>`,
  );
};

export const renewSubscriptionCronWorker: ExportedHandlerScheduledHandler<CloudflareBindings> = async (_, env) => {
  const allSubscriptions = await getAllSubscriptions(env);
  const renewedSubscriptions = [];

  for (const subscription of allSubscriptions) {
    const subscribed = await requestSubscription({
      mode: "subscribe",
      channelId: subscription.channelId,
      secret: env.API_SECRET,
      callbackUrl: `https://${env.APP_DOMAIN}/callback`,
    });
    if (!subscribed) discordLog(env, `Failed to renew subscription for ${subscription.channelId}`);
    renewedSubscriptions.push(subscription);
  }

  await env.KV.put(SUBSCRIPTION_KV_KEY, JSON.stringify(renewedSubscriptions));
};
