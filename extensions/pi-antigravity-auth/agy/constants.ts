/**
 * Constants for the Antigravity Cloud Code Assist API and OAuth flows.
 * Wire values captured from agy CLI 1.1.20 via mitmproxy
 * (~/dev/pi-misc/agy-mitm/models/agy-1.1.20-gemini37-ping.flows).
 */
export const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_CLIENT_SECRET = "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";
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const ANTIGRAVITY_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;

/** Project id sent when the account returns none (workspace/business accounts). */
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

/** User-Agent on the OAuth token endpoints (matches google-api-nodejs-client). */
export const TOKEN_USER_AGENT = "google-api-nodejs-client/9.15.1";
