// Based on @cortexkit/antigravity-auth-core 2.1.0 and agy CLI 1.2.16 traffic.
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

export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

export const TOKEN_USER_AGENT = "google-api-nodejs-client/9.15.1";

const AGY_CLI_VERSION = "1.2.16";
const AGY_CLI_CHANGE_LIST = "992658124";
const OS_TYPE = process.platform === "win32" ? "windows" : process.platform;
const ARCH = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;

export const ANTIGRAVITY_USER_AGENT = `antigravity/cli/${AGY_CLI_VERSION} (aidev_client; os_type=${OS_TYPE}; arch=${ARCH}; cl=${AGY_CLI_CHANGE_LIST}; auth_method=consumer)`;
