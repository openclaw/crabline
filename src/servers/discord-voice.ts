import { createSocket } from "node:dgram";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { closeServer, isJsonObject } from "./http.js";
import type { ServerRecorder } from "./recorder.js";
import { closeWebSocketServer } from "./websocket.js";

// Public test-only material. Valid through 2036; SANs cover localhost and loopback.
export const DISCORD_VOICE_CA_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJALY9WPr2jw28MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAeFw0yNjA5MTQwMzEwNDFaFw0zNjA5MTEwMzEwNDFaMBQx
EjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBANYlzRW7jLNhSKK1X2Ch2aO7D0rCPyizrI63dRbubC7JNp8dd7eD74+XUhFU
5eVHNpTffcudL1hhTv52//OdDrE3E+akKtEDHEUkESjdA5h8QYrud/uMwwQ1Akj8
cU8CtQBxanKl5jL9Yxbni8vLq2pbll082yzywtyoaPuasgXbvVTg3j+rcfKlL0Us
dCdsdt4gzL0pqdBw+ePhp5/7Gj/hNQgL0QGmcttq6F/lzZ9baaGfAq58758ypB1J
ZL6PjhzWFBR0ntExPpvGBxXrs2x/tCSvYx7C68z6x7a/ro+rt5PuWFbZuKoaZcY2
Lh+LNdvoC9Ujj+ax8+KJIJVmXYkCAwEAAaMeMBwwGgYDVR0RBBMwEYIJbG9jYWxo
b3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQCD0GgWGZ6dUbUS2xQmwP09mrPb
N2wC+GJ7+/bOEOHQiyMtnr04O4Bx+6UHBL6sEP5mbnFvfRa+/I86gXUIKXKVGxAQ
ghPjnvNdsPxC4CyD/sCedXL2FVuE8jcgxSVs7LgR5lNgJZhzstIM0Yrtiz9Ue89w
IONmc/4CMo6bzAag25N/64/Hc2XuaJLJGZHL3WD/qqLmXpAlJXQkOS0+OFpJU8f1
Z7VtjO3PeN0yoSxR/6U1cjdo+Wcxzjf4ffBv53BxhguZjIcIrIGi2jgbzrjHIhi1
uaj3H8CknPJu7Z1r3SgVzJ0Nxb22CkRQBw7osdAZCCKs66rxgOUn7kSI/qP3
-----END CERTIFICATE-----`;

const PRIVATE_KEY_LABEL = "PRIVATE KEY";
const DISCORD_VOICE_PRIVATE_KEY = [
  `-----BEGIN ${PRIVATE_KEY_LABEL}-----`, // pragma: allowlist secret
  `MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDWJc0Vu4yzYUii
tV9godmjuw9Kwj8os6yOt3UW7mwuyTafHXe3g++Pl1IRVOXlRzaU333LnS9YYU7+
dv/znQ6xNxPmpCrRAxxFJBEo3QOYfEGK7nf7jMMENQJI/HFPArUAcWpypeYy/WMW
54vLy6tqW5ZdPNss8sLcqGj7mrIF271U4N4/q3HypS9FLHQnbHbeIMy9KanQcPnj
4aef+xo/4TUIC9EBpnLbauhf5c2fW2mhnwKufO+fMqQdSWS+j44c1hQUdJ7RMT6b
xgcV67Nsf7Qkr2MewuvM+se2v66Pq7eT7lhW2biqGmXGNi4fizXb6AvVI4/msfPi
iSCVZl2JAgMBAAECggEAJEbXDR1uYlzSjy2mcJo6YjAoEQQC6wQ08SBG55GQJgTU
CfRV+XKSPILn1iPJpiOALYwGpV2FTbV+SkEibsRmXsLzzhh1YF7khRntBj0ahNRX
zg9DqAtaZfYM4wxQrY/J1b9gxvcvneeqx5CF8AoaibPmLvlGL8EYHYUx851rFu6p
MzIQ/B5KdH4XbRxgnKd/xgkZO/NwkEYkjjjq6kJYFPpUiDI4gM/LpH24lBw/f0c3
pdAYUjsukfu8fPhDiflL8RjljxGYHXxUSWkhx223MFtaNSWUZ0fY88oPVNU82C3L
EeTYVXEJ2Qk9XZ04p4vAFD+MymJObM5o/vOW/aUdWQKBgQDwUVBPCjYl3FvHw8mg
DNgU5KAC0IoQV0ihCQF+FJdt6ZZm2GpfSQxJYF4kRg+U7Xa4PilsgNAVIr5cSanN
C8oYV/YiSWekXWuPce6N4uKbMkrzr5AIGeRfAllZJ0F7ybyOCybhYXvMPMBd5b1l
cnIzTAKH7brmwlcdtNARld+O/wKBgQDkH0xko0gK28Ao2YWPx5CjJlsI/UGlSTmT
dlnXSg63X/eqkirEVyX7FFwzzVq6HMcn+tLtDo6guEMP3pUFFZUhaRS7+Xb50+ro
FC4CVz/qG54SZblach3dRoackMVpY99/38Ji780VeGUW+9ots94gTuEEkvzpLItn
O94Xr5obdwKBgEC3lSoD9PsTMcBFUJoCe3p86z52zIeECfIcC8PZZcJawn8lztek
Q2PLSO750x5nKK6LRvqKYf8fISaXS9wFTcJqhcVMAVY5NksmAnlBXYcv7xFa+S3F
U0PmzQr+UFs2w8l45VqStxUUUzW2NeAJBwobcR8L/WZBddZxKAtkUhUfAoGBAMmI
RQsbnUfKf+cW1IIDQmqANiio5NfK6wy1oAUsrfee1sRgQVwXybwZbqNtJlwJlIBj
fPhkxeiDIOviLjDBsnBDz0eJymxHpd3GBieXQSXnpCyIpcmby3pzFfU3iM/kpczo
t2iEheAT7urxMPzzTKeqR+yslrbA3Z8kKr8uKa1dAoGBAMQPsQ7BocIuoXNYTyZx
yFsz/AKcMRWmSAnHnQHSDF1DnOWB2jR7yg9oWaWJPzc9V4p2bEmvd6prwF52NZV5
TWl4lYtEtZqvHzwsPdIxlmyW65IWSFtEM05fuM6A7b73LH6ME+qJhwBlrLLvCH9d
cYCncvo3woYIHt+nk85PePrE`,
  `-----END ${PRIVATE_KEY_LABEL}-----`,
].join("\n");

// Public test-only material for IPv6 loopback. Valid through 2036; SANs cover localhost,
// 127.0.0.1, and ::1.
const DISCORD_VOICE_IPV6_CA_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIC2zCCAcOgAwIBAgIJAKiu25jQVgATMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAeFw0yNjA5MTQwNTI3MzRaFw0zNjA5MTEwNTI3MzRaMBQx
EjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAMwapUMKnMejSlmDKjmrIWVK07H4h1OmI7tfMxSAj/ywu1DVF5ML7edO/CDv
eF5yDacCBt3Q75LooIrni6IKRPImRyLb2IUuZVf3R9yoWuZLn8AyHD0WkUviKkXH
7hlry/6dGoLtW9Ig9df68UbHnb8joM2wA9FoUws5lGPNbO0/eAHWYuM/q9O8Cqfx
FDzC50SS1LDRS1ZAtSxm/aoNXC1rVdOU375WNoyzToXrsabYIJSbVi1Na4ktb/K+
hZ9I+zApWAPqOirjVIdK3v3oUOB65shTeNHx9v53CT9ksx6Ow+CDkl9Rv7cwA/xz
Po3szIMGpRFNu6FG6OkIMKgeIb8CAwEAAaMwMC4wLAYDVR0RBCUwI4IJbG9jYWxo
b3N0hwR/AAABhxAAAAAAAAAAAAAAAAAAAAABMA0GCSqGSIb3DQEBCwUAA4IBAQBM
PhA4+a+uQ55uBm1RtDEq6s/J6s0r4ufBv59P39fer6IQKkpU4nK+vZmNip0uOmBE
WZ1lxdUCMy8NlgKHYnXRijaObF6KGROT6Io9zEjs1Yatf3ASdqPIu0uFpfLU3BDp
Cf7lgPzEAkGZXNnAha4ptXMjKPL4zXYF8K7I9hxn3Bv4MtejtwB9/YUY7xphxoHR
xfIiTOs0IYKHJt2wP3HN3mtsj0aSupYdlpuFAT+kDlItvVGnM4rI8AJ8B74KE1dS
py3NrV3C1niym43G404PvXIcS7hpXCJW81KM4ugGURSNs9xu05RR/OY4w5MCqvru
/7UKsiD4ZJDnytGKh/E4
-----END CERTIFICATE-----`;

const DISCORD_VOICE_IPV6_PRIVATE_KEY = [
  `-----BEGIN ${PRIVATE_KEY_LABEL}-----`, // pragma: allowlist secret
  `MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDMGqVDCpzHo0pZ
gyo5qyFlStOx+IdTpiO7XzMUgI/8sLtQ1ReTC+3nTvwg73hecg2nAgbd0O+S6KCK
54uiCkTyJkci29iFLmVX90fcqFrmS5/AMhw9FpFL4ipFx+4Za8v+nRqC7VvSIPXX
+vFGx52/I6DNsAPRaFMLOZRjzWztP3gB1mLjP6vTvAqn8RQ8wudEktSw0UtWQLUs
Zv2qDVwta1XTlN++VjaMs06F67Gm2CCUm1YtTWuJLW/yvoWfSPswKVgD6joq41SH
St796FDgeubIU3jR8fb+dwk/ZLMejsPgg5JfUb+3MAP8cz6N7MyDBqURTbuhRujp
CDCoHiG/AgMBAAECggEAQDVNshZ/lcpH1HsP6I5udhghGsbNg8IrUYG0Zwm+wkay
1s4CmY7SK8dMR+wt2MBWjSh1EojtJTEreCc5ZSOH5wmlrVCt/8/Fr/Op1r/bwMEf
o23gNlOIJ/AhTkyEGdkwlovD0FZtYWBfFq/qAVNAy+Wga7SortL79PcLOI5iawvQ
8Vhi8c6J5IexHAODhb1rUuuW80ISAuGZ0WvarkfcldKrDnzE+Zldoh3hc9lq5kRl
/Csq1hmKDhEIjwPIyw1OHtv+S8oXbgU3OAi65oeNaIxNYvoQ2MfcsOem0oVZ29OZ
nbgBaA6eoqUA+evla4zGG98FkgnfTNXxmGrx7bBFOQKBgQD7hudJaTJBzYYNnNLj
GaJ6mMsL9E6OpQ/YXl2CcLD1gM9waI7oCZVvyl/zAKmbHt/oPo3OTs4JlIrOju51
i7s5VHCs/tCaZCyWVcyhmmspcbYh9Jek3JVXMWOhfylhYBuyNQUOlkNAwZdZmWnV
jx33gaM5olZ8z5P1qyuSR4ZUmwKBgQDPu9h8E8fO/Et/wpuSTxuxXqXAO49/k5sq
62UOE9e3IKRg4LNm0hcL4NCzDQbM3YfxZ099TItTaGjiR7vZtGOcrhAYAY5zznQ4
8a7gtJQKCmGbpihtvn63HE3UkiAfGv/oqkthWjkD7dcaRt1DgMk5TSrUh5hzRZus
64fhlROvrQKBgQDzGkoE7AXFD82W7pHtKWOetnrZTQF4YRTVfS9H2X9PaXYVIRmu
L0UdzS27glJrOQYURBFu6z+8hrM6PW9AcRM9r91PduFLt7JYgwjK0KLuZZcxbmP6
1bAJnBS9jFgEY42hShlfJeBOgE22Lc7at/6wr72BAOQysbZB5XSxZyvwLQKBgQCo
3d/WxVGo7ikFm5JRtmMhpXoCMaiuIbSCiEZm0jSKVkupwR+1VtWLP18IHm/Hu9IV
qFDS35Vm4TpZr8yB5gUPyeOlUCaX9109KSJq4gBxxQyhtcmppLBnc+fFBGB+SLl9
Tmnmoqw0iHRSlQarKBbrsNI/YFbKZext/i1AcKpHJQKBgQCHgfqbeLtC0S8iazum
t3Z7RxRJsmpxjXBqgW8EGOfHWGLq3h/Z6uAYLCDovxIUW4EWacjbybcFiAE29pNr
tnWxCbwtCwFbqvY+DczWKA1SgrbnWaYCsaW3GumR+I3+HAtvKkQmEacIgjT75Epy
mrZwRV61T62Ors7EDa7jKM7fkA==`,
  `-----END ${PRIVATE_KEY_LABEL}-----`,
].join("\n");

type StartedDiscordVoiceServer = {
  caCertificate: string;
  close(): Promise<void>;
  endpoint: string;
  invalidateSession(sessionId: string): void;
};

export type DiscordVoiceSession = {
  guildId: string;
  sessionId: string;
  token: string;
  userId: string;
};

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export async function startDiscordVoiceServer(params: {
  authorize(session: DiscordVoiceSession): boolean;
  host: string;
  recorder: ServerRecorder;
}): Promise<StartedDiscordVoiceServer> {
  const ipv6 = params.host.includes(":");
  const caCertificate = ipv6 ? DISCORD_VOICE_IPV6_CA_CERTIFICATE : DISCORD_VOICE_CA_CERTIFICATE;
  const privateKey = ipv6 ? DISCORD_VOICE_IPV6_PRIVATE_KEY : DISCORD_VOICE_PRIVATE_KEY;
  const udp = createSocket(ipv6 ? "udp6" : "udp4");
  udp.on("message", (message, remote) => {
    const discovery = message.length >= 8 && message.readUInt16BE(0) === 1;
    void params.recorder.recordCommitted({
      at: new Date().toISOString(),
      body: {
        bytes: message.length,
        kind: discovery ? "ip-discovery" : "keepalive",
      },
      method: "UDP",
      path: "/voice",
      query: {},
      type: "api",
    });
    if (discovery) {
      const response = Buffer.alloc(74);
      response.writeUInt16BE(2, 0);
      response.writeUInt16BE(70, 2);
      message.copy(response, 4, 4, 8);
      response.write(remote.address, 8, "utf8");
      response.writeUInt16BE(remote.port, 72);
      udp.send(response, remote.port, remote.address);
      return;
    }
    udp.send(message, remote.port, remote.address);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(0, params.host, () => {
        udp.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    try {
      udp.close();
    } catch {
      // The socket never reached the bound state.
    }
    throw error;
  }
  const udpAddress = udp.address() as AddressInfo;
  const server = createServer({
    cert: caCertificate,
    key: privateKey,
  });
  const sockets = new Set<WebSocket>();
  const socketSessions = new Map<WebSocket, DiscordVoiceSession>();
  const voiceServer = new WebSocketServer({ server });
  voiceServer.on("connection", (socket, request) => {
    sockets.add(socket);
    send(socket, { d: { heartbeat_interval: 45_000 }, op: 8 });
    socket.on("message", (raw: RawData) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString()) as unknown;
      } catch {
        socket.close(4_002, "Decode error");
        return;
      }
      void params.recorder.recordCommitted({
        at: new Date().toISOString(),
        body: payload,
        method: "WS",
        path: request.url ?? "/voice",
        query: {},
        type: "api",
      });
      if (!isJsonObject(payload) || typeof payload.op !== "number") {
        socket.close(4_002, "Decode error");
      } else if (payload.op === 0) {
        if (!isJsonObject(payload.d)) {
          socket.close(4_004, "Authentication failed");
          return;
        }
        const session: DiscordVoiceSession = {
          guildId: typeof payload.d.server_id === "string" ? payload.d.server_id : "",
          sessionId: typeof payload.d.session_id === "string" ? payload.d.session_id : "",
          token: typeof payload.d.token === "string" ? payload.d.token : "",
          userId: typeof payload.d.user_id === "string" ? payload.d.user_id : "",
        };
        if (
          !session.guildId ||
          !session.sessionId ||
          !session.token ||
          !session.userId ||
          !params.authorize(session)
        ) {
          socket.close(4_004, "Authentication failed");
          return;
        }
        socketSessions.set(socket, session);
        send(socket, {
          d: {
            ip: params.host,
            modes: ["aead_xchacha20_poly1305_rtpsize"],
            port: udpAddress.port,
            ssrc: 1,
          },
          op: 2,
        });
      } else if (payload.op === 1) {
        const session = socketSessions.get(socket);
        if (!session || !params.authorize(session)) {
          socket.close(4_006, "Session no longer valid");
          return;
        }
        if (
          !isJsonObject(payload.d) ||
          payload.d.protocol !== "udp" ||
          !isJsonObject(payload.d.data) ||
          typeof payload.d.data.address !== "string" ||
          !payload.d.data.address.trim() ||
          typeof payload.d.data.port !== "number" ||
          !Number.isSafeInteger(payload.d.data.port) ||
          payload.d.data.port <= 0 ||
          payload.d.data.port > 65_535 ||
          payload.d.data.mode !== "aead_xchacha20_poly1305_rtpsize"
        ) {
          socket.close(4_002, "Invalid protocol selection");
          return;
        }
        send(socket, {
          d: {
            dave_protocol_version: 0,
            mode: "aead_xchacha20_poly1305_rtpsize",
            secret_key: Array.from({ length: 32 }, () => 0),
          },
          op: 4,
        });
      } else if (payload.op === 3) {
        send(socket, { d: payload.d ?? null, op: 6 });
      } else if (payload.op === 7) {
        if (!isJsonObject(payload.d)) {
          socket.close(4_004, "Authentication failed");
          return;
        }
        const session: DiscordVoiceSession = {
          guildId: typeof payload.d.server_id === "string" ? payload.d.server_id : "",
          sessionId: typeof payload.d.session_id === "string" ? payload.d.session_id : "",
          token: typeof payload.d.token === "string" ? payload.d.token : "",
          userId: typeof payload.d.user_id === "string" ? payload.d.user_id : "",
        };
        if (!params.authorize(session)) {
          socket.close(4_006, "Session no longer valid");
          return;
        }
        socketSessions.set(socket, session);
        send(socket, { d: {}, op: 9 });
      }
    });
    socket.once("close", () => {
      sockets.delete(socket);
      socketSessions.delete(socket);
    });
    socket.on("error", () => undefined);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, params.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    voiceServer.close();
    await new Promise<void>((resolve) => udp.close(() => resolve()));
    throw error;
  }
  const address = server.address() as AddressInfo;
  return {
    caCertificate,
    endpoint: `${params.host.includes(":") ? `[${params.host}]` : params.host}:${address.port}/voice`,
    invalidateSession(sessionId) {
      for (const [socket, session] of socketSessions) {
        if (session.sessionId === sessionId) {
          socket.close(4_006, "Session no longer valid");
        }
      }
    },
    async close() {
      for (const socket of sockets) {
        socket.close(1_000);
      }
      const results = await Promise.allSettled([
        closeWebSocketServer(voiceServer),
        closeServer(server),
        new Promise<void>((resolve) => udp.close(() => resolve())),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Discord voice server shutdown failed.");
      }
    },
  };
}
