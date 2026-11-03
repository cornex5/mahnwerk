// Classifies PayPal failures. "Definitive" means PayPal certainly did not perform the write
// (a 4xx validation or business error); anything else may or may not have happened at PayPal.

import { PayPalApiError } from "../paypal/client";

export function isDefinitivePayPalFailure(err: unknown): boolean {
  if (!(err instanceof PayPalApiError)) return false;
  return err.status >= 400 && err.status < 500 && ![408, 409, 429].includes(err.status);
}

export function payPalIssue(err: unknown): string | undefined {
  return err instanceof PayPalApiError ? err.issue : undefined;
}

export function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error";
  return msg.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]").slice(0, 500);
}
