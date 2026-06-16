import { describe, expect, it } from "vitest";
import {
  findLocalChannelDriver,
  listLocalChannelDriverMatrix,
  runLocalChannelDriverSmoke,
} from "../src/index.js";

describe("local channel driver API", () => {
  it("exposes deterministic local channel driver metadata", () => {
    expect(
      findLocalChannelDriver({
        channel: "telegram",
      }),
    ).toMatchObject({
      channel: "telegram",
      channelLive: false,
      deterministic: true,
      driverId: "telegram",
      driverVersion: 1,
      status: "ready",
    });
    expect(listLocalChannelDriverMatrix().matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "telegram.dm.text",
          channel: "telegram",
          driverId: "telegram",
          status: "covered",
        }),
        expect.objectContaining({
          capabilityId: "whatsapp.dm.text",
          channel: "whatsapp",
          driverId: "whatsapp",
          status: "covered",
        }),
      ]),
    );

    expect(
      findLocalChannelDriver({
        channel: "whatsapp",
      }),
    ).toMatchObject({
      channel: "whatsapp",
      driverId: "whatsapp",
      driverVersion: 1,
      status: "ready",
    });
  });

  it("runs deterministic smoke fixtures for selected local drivers", async () => {
    await expect(
      runLocalChannelDriverSmoke({
        channel: "telegram",
      }),
    ).resolves.toMatchObject({
      driver: {
        channel: "telegram",
        driverId: "telegram",
        driverVersion: 1,
      },
      result: {
        fixtureId: "telegram-local-driver-smoke",
        ok: true,
        providerId: "telegram-local",
      },
    });

    await expect(
      runLocalChannelDriverSmoke({
        channel: "whatsapp",
      }),
    ).resolves.toMatchObject({
      driver: {
        channel: "whatsapp",
        driverId: "whatsapp",
        driverVersion: 1,
      },
      result: {
        fixtureId: "whatsapp-local-driver-smoke",
        ok: true,
        providerId: "whatsapp-local",
      },
    });
  });
});
