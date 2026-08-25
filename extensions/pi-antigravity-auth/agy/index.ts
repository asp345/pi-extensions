/**
 * Vendored agy CLI protocol implementation, rewritten in TypeScript from
 * @cortexkit/antigravity-auth-core 2.1.0 (MIT) and the agy CLI 1.1.20
 * MITM capture dated 2026-08-25. Differences from the upstream package:
 * - User-Agent and labels.request_id match agy 1.1.20 (cl=970154694).
 * - transport retries transient TLS handshake failures.
 * - Model catalog refreshes from v1internal:fetchAvailableModels.
 */
export * from "./constants.ts";
export * from "./fingerprint.ts";
export * from "./gemini-schema.ts";
export * from "./model-resolver.ts";
export * from "./models.ts";
export * from "./oauth.ts";
export * from "./request-metadata.ts";
export * from "./transport.ts";
