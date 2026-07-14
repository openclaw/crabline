export async function throwProbeHttpError(response: Response, message: string): Promise<never> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the provider HTTP failure when response cleanup also fails.
  }
  throw new Error(message);
}
