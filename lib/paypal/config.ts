// PayPal environment selection. Sandbox is the default. Live is refused unless ALLOW_LIVE=1.

export type PayPalEnv = "sandbox" | "live";

export const PAYPAL_BASE_URLS: Record<PayPalEnv, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

export interface PayPalConfig {
  env: PayPalEnv;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

type EnvLike = Record<string, string | undefined>;

export function resolvePayPalEnv(env: EnvLike = process.env): PayPalEnv {
  const raw = env.PAYPAL_ENV;
  if (raw === undefined || raw === "") return "sandbox";
  if (raw !== "sandbox" && raw !== "live") {
    throw new Error(`PAYPAL_ENV must be "sandbox" or "live", got "${raw}"`);
  }
  if (raw === "live" && env.ALLOW_LIVE !== "1") {
    throw new Error("PAYPAL_ENV=live is refused. Mahnwerk runs on the PayPal sandbox only (set ALLOW_LIVE=1 to override).");
  }
  return raw;
}

export function loadPayPalConfig(env: EnvLike = process.env): PayPalConfig {
  const which = resolvePayPalEnv(env);
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId) throw new Error("PAYPAL_CLIENT_ID is not set");
  if (!clientSecret) throw new Error("PAYPAL_CLIENT_SECRET is not set");
  return { env: which, baseUrl: PAYPAL_BASE_URLS[which], clientId, clientSecret };
}
