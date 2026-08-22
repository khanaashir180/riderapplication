import crypto from "crypto";

function timingSafeEqualText(actual: unknown, expected: string) {
  if (typeof actual !== "string" || !actual.trim() || !expected) return false;
  const actualBuffer = Buffer.from(actual.trim());
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verifyShopifyWebhookHmac(rawBody: Buffer, hmacHeader: unknown, webhookSecret: string) {
  if (!Buffer.isBuffer(rawBody) || !webhookSecret) return false;
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("base64");
  return timingSafeEqualText(hmacHeader, expected);
}

export function verifyGomilaIntegrationSecret(secretHeader: unknown, configuredSecret: string) {
  return timingSafeEqualText(secretHeader, configuredSecret);
}
