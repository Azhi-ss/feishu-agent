export function redactSecrets(value: string): string {
  const secret = process.env.MEM0_API_KEY;
  return secret ? value.split(secret).join("[REDACTED]") : value;
}

export function memoryWarning(feature: "load" | "health" | "recall" | "capture" | "dream", error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Startup Warning: Long-term Memory ${feature} unavailable for this session: ${redactSecrets(message)}`;
}
