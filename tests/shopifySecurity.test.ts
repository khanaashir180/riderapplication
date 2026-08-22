import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { verifyGomilaIntegrationSecret, verifyShopifyWebhookHmac } from "../src/services/shopifySecurity.js";

test("Shopify HMAC accepts only the raw-body signature", () => {
  const body = Buffer.from('{"id":50001,"name":"#50001"}');
  const secret = "shopify-secret";
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(verifyShopifyWebhookHmac(body, signature, secret), true);
  assert.equal(verifyShopifyWebhookHmac(Buffer.from('{"name":"#50001","id":50001}'), signature, secret), false);
  assert.equal(verifyShopifyWebhookHmac(body, undefined, secret), false);
});

test("Gomila middleware secret remains separate from Shopify HMAC", () => {
  assert.equal(verifyGomilaIntegrationSecret("gomila-secret", "gomila-secret"), true);
  assert.equal(verifyGomilaIntegrationSecret("shopify-secret", "gomila-secret"), false);
});
