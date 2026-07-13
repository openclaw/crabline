export type NativeIdRule = {
  example: string;
  name: string;
  pattern: RegExp;
  validate?: ((value: string) => boolean) | undefined;
};

export function matchesNativeId(value: string, rule: NativeIdRule): boolean {
  return rule.pattern.test(value) && (rule.validate?.(value) ?? true);
}

export function numericNativeId(value: number | bigint): string | undefined {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    return undefined;
  }
  return value.toString();
}
