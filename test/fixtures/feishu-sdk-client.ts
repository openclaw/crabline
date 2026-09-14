// Run in a child: the official SDK changes protobufjs' process-global Long setting.
import * as Lark from "@larksuiteoapi/node-sdk";

let websocket: Lark.WSClient | undefined;
let release: (() => void) | undefined;

process.on(
  "message",
  (message: {
    type: string;
    appId?: string;
    appSecret?: string;
    baseUrl?: string;
    rejectCredentials?: boolean;
    chatIdentity?: "admission-first" | "send-first";
  }) => {
    if (message.type === "release") {
      release?.();
      return;
    }
    if (message.type === "stop") {
      websocket?.close({ force: true });
      process.disconnect();
      return;
    }
    if (message.type !== "start" || !message.appId || !message.appSecret || !message.baseUrl) {
      throw new Error("Invalid SDK fixture command");
    }
    const { appId, appSecret, baseUrl } = message;
    let discoveryRequests = 0;
    // Keep the SDK's route expansion and response handling; change only the origin.
    Lark.defaultHttpInstance.interceptors.request.use((request) => {
      const url = new URL(request.url!);
      if (url.origin !== "https://open.feishu.cn") {
        throw new Error("Unexpected SDK destination");
      }
      if (url.pathname === "/callback/ws/endpoint") {
        discoveryRequests++;
      }
      request.url = `${baseUrl}${url.pathname}${url.search}`;
      request.proxy = false;
      return request;
    });
    const run = async () => {
      if (message.rejectCredentials) {
        // Observe HTTP rejection without converting it into the SDK's terminal error.
        Lark.defaultHttpInstance.interceptors.response.use(undefined, (error: unknown) => {
          process.send?.({
            type: "http-error",
            message: error instanceof Error ? error.message : String(error),
          });
          return Promise.reject(error);
        });
        websocket = new Lark.WSClient({
          appId,
          appSecret,
          autoReconnect: true,
          loggerLevel: Lark.LoggerLevel.error,
          onReady: () => {
            process.send?.({ type: "unexpected-ready" });
          },
          onError: (error) => {
            process.send?.({
              type: "auth-error",
              message: error.message,
              status: websocket?.getConnectionStatus(),
              discoveryRequests,
            });
          },
        });
        await websocket.start({ eventDispatcher: new Lark.EventDispatcher({}) });
        return;
      }
      const client = new Lark.Client({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error });
      if (message.chatIdentity) {
        const sendDirect = () =>
          client.im.message.create({
            params: { receive_id_type: "open_id" },
            data: {
              receive_id: "ou_dm_peer",
              msg_type: "text",
              content: JSON.stringify({ text: "SDK direct response" }),
            },
          });
        const first = await sendDirect();
        if (message.chatIdentity === "send-first") {
          const barrier = new Promise<void>((resolve) => {
            release = resolve;
          });
          process.send?.({ type: "first-dm", first });
          await barrier;
          release = undefined;
        }
        const chatId =
          message.chatIdentity === "send-first" ? first.data?.chat_id : "oc_existing_dm";
        if (!chatId) {
          throw new Error("SDK direct send did not return a chat ID");
        }
        const direct = message.chatIdentity === "send-first" ? await sendDirect() : first;
        const explicit = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({ text: "SDK chat response" }),
          },
        });
        const reply = await client.im.message.reply({
          path: { message_id: "om_dm_inbound" },
          data: { msg_type: "text", content: JSON.stringify({ text: "SDK reply" }) },
        });
        process.send?.({ type: "chat-identity", direct, explicit, reply });
        return;
      }
      for (const [msg_type, content] of [
        ["text", { text: "SDK 文本" }],
        ["post", { zh_cn: { title: "", content: [[{ tag: "text", text: "SDK 富文本" }]] } }],
        ["interactive", { elements: [{ tag: "markdown", content: "SDK 卡片" }] }],
      ] as const) {
        const response = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: "oc_sdk", msg_type, content: JSON.stringify(content) },
        });
        if (response.code !== 0 || !response.data?.message_id) {
          throw new Error("SDK create was not accepted");
        }
        const reply = await client.im.message.reply({
          path: { message_id: response.data.message_id },
          data: { msg_type: "text", content: JSON.stringify({ text: "SDK 回复" }) },
        });
        if (reply.code !== 0) {
          throw new Error("SDK reply was not accepted");
        }
      }
      const dispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (event) => {
          const lookup = await client.im.message.get({
            path: { message_id: event.message.message_id },
          });
          const reply = await client.im.message.reply({
            path: { message_id: event.message.message_id },
            data: { msg_type: "text", content: JSON.stringify({ text: "SDK 自定义 ID 回复" }) },
          });
          const barrier = new Promise<void>((resolve) => {
            release = resolve;
          });
          process.send?.({ type: "event", event, lookup, reply });
          await barrier;
          release = undefined;
          if (event.message.content.includes("SDK_THROW")) {
            throw new Error("Expected dispatcher failure");
          }
          return { handled: true };
        },
      });
      websocket = new Lark.WSClient({
        appId,
        appSecret,
        autoReconnect: false,
        loggerLevel: Lark.LoggerLevel.error,
      });
      await websocket.start({ eventDispatcher: dispatcher });
      process.send?.({ type: "started" });
    };
    void run().catch((error: unknown) => {
      process.send?.({
        type: "failure",
        message: error instanceof Error ? error.message : String(error),
      });
      websocket?.close({ force: true });
      process.exitCode = 1;
      process.disconnect();
    });
  },
);
