function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushSlackText(value: unknown, output: string[]): void {
  if (typeof value === "string" && value.trim()) {
    output.push(value);
  }
}

function slackInlineText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(slackInlineText).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (value.type === "link" && typeof value.url === "string") {
    return typeof value.text === "string" && value.text.length > 0 ? value.text : value.url;
  }
  if (value.type === "user" && typeof value.user_id === "string") {
    return `<@${value.user_id}>`;
  }
  if (value.type === "channel" && typeof value.channel_id === "string") {
    return `<#${value.channel_id}>`;
  }
  if (value.type === "usergroup" && typeof value.usergroup_id === "string") {
    return `<!subteam^${value.usergroup_id}>`;
  }
  if (value.type === "emoji" && typeof value.name === "string") {
    return `:${value.name}:`;
  }
  if (value.type === "broadcast" && typeof value.range === "string") {
    return `<!${value.range}>`;
  }
  if (value.type === "date") {
    if (typeof value.fallback === "string" && value.fallback.length > 0) {
      return value.fallback;
    }
    if (
      (typeof value.timestamp === "number" || typeof value.timestamp === "string") &&
      typeof value.format === "string"
    ) {
      return `<!date^${value.timestamp}^${value.format}>`;
    }
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  return slackInlineText(value.elements);
}

function collectSlackTextValue(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    pushSlackText(value, output);
    return;
  }
  if (isRecord(value) && typeof value.text === "string") {
    pushSlackText(value.text, output);
    return;
  }
  collectSlackBlockText(value, output);
}

export function collectSlackBlockText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSlackBlockText(entry, output);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (
    value.type === "rich_text_section" ||
    value.type === "rich_text_preformatted" ||
    value.type === "rich_text_quote"
  ) {
    pushSlackText(slackInlineText(value.elements), output);
    return;
  }
  for (const key of [
    "alt_text",
    "title",
    "body",
    "subtitle",
    "subtext",
    "details",
    "output",
  ] as const) {
    collectSlackTextValue(value[key], output);
  }
  collectSlackTextValue(value.text, output);
  for (const key of [
    "blocks",
    "elements",
    "fields",
    "rows",
    "tasks",
    "actions",
    "hero_image",
    "icon",
  ] as const) {
    collectSlackBlockText(value[key], output);
  }
}

export function collectSlackAttachmentText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSlackAttachmentText(entry, output);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["fallback", "pretext", "author_name", "title", "text", "footer"] as const) {
    pushSlackText(value[key], output);
  }
  if (Array.isArray(value.fields)) {
    for (const field of value.fields) {
      if (!isRecord(field)) {
        continue;
      }
      pushSlackText(field.title, output);
      pushSlackText(field.value, output);
    }
  }
  collectSlackBlockText(value.blocks, output);
}
