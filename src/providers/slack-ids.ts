import type { NativeIdRule } from "./native-ids.js";

export const SLACK_CHANNEL_ID_RULE: NativeIdRule = {
  example: "C1234567890",
  name: "Slack conversation id",
  pattern: /^[CDG][A-Z0-9]{2,}$/u,
};

export const SLACK_SEND_TARGET_ID_RULE: NativeIdRule = {
  example: "C1234567890",
  name: "Slack conversation or user id",
  pattern: /^[CDGUW][A-Z0-9]{2,}$/u,
};

export const SLACK_USER_ID_RULE: NativeIdRule = {
  example: "U1234567890",
  name: "Slack user id",
  pattern: /^[UW][A-Z0-9]{2,}$/u,
};

export const SLACK_EVENT_ID_RULE: NativeIdRule = {
  example: "Ev1234567890",
  name: "Slack event id",
  pattern: /^Ev[A-Z0-9]{2,}$/u,
};

export const SLACK_TS_RULE: NativeIdRule = {
  example: "1700000000.000100",
  name: "Slack timestamp",
  pattern: /^\d{10}\.\d{6}$/u,
};

export function slackTargetKey(channel: string, threadTs?: string) {
  return threadTs ? `${channel}:thread:${threadTs}` : channel;
}
