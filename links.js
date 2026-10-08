// Per-provider web links, keyed by the provider ids codexbar emits.
//
// The macOS app links into its own settings and into each provider's dashboard.
// A shell extension has no settings of its own to link to, so these point at the
// provider pages that show the same information: the usage dashboard each
// provider already exposes, and its status page.

/** Usage dashboards, keyed by provider id from `codexbar usage` output. */
export const USAGE_URLS = {
  codex: "https://chatgpt.com/codex/settings/usage",
  openai: "https://platform.openai.com/usage",
  azureopenai: "https://portal.azure.com/",
  claude: "https://claude.ai/settings/usage",
  clinepass: "https://cline.bot/usage",
  cursor: "https://cursor.com/dashboard/usage",
  opencode: "https://opencode.ai/console",
  opencodego: "https://opencode.ai/console/go/status",
  alibaba: "https://bailian.console.aliyun.com/",
  alibabatokenplan: "https://bailian.console.aliyun.com/",
  qwencloud: "https://bailian.console.aliyun.com/",
  factory: "https://app.factory.ai/cli",
  fireworks: "https://fireworks.ai/account/billing",
  gemini: "https://aistudio.google.com/",
  antigravity: "https://antigravity.google/",
  copilot: "https://github.com/settings/billing/budgets",
  devin: "https://devin.ai/usage",
  zai: "https://z.ai/manage-apikey/apikey-list",
  minimax: "https://platform.minimax.io/user-center/basic-information/interface-key",
  manus: "https://manus.im/",
  kimi: "https://platform.moonshot.cn/console/api-keys",
  kilo: "https://app.kilo.ai/",
  kiro: "https://kiro.dev/",
  vertexai: "https://console.cloud.google.com/",
  augment: "https://app.augmentcode.com/",
  jetbrains: "https://www.jetbrains.com/ai/",
  moonshot: "https://platform.moonshot.cn/",
  amp: "https://ampcode.com/settings",
  t3chat: "https://t3.chat/",
  langdock: "https://langdock.com/",
  ollama: "https://ollama.com/settings/keys",
  synthetic: "https://platform.synthetic.new/",
  openrouter: "https://openrouter.ai/credits",
  elevenlabs: "https://elevenlabs.io/app/settings/usage",
  warp: "https://warp.dev/account",
  windsurf: "https://windsurf.com/usage",
  zed: "https://zed.dev/account",
  perplexity: "https://www.perplexity.ai/settings/usage",
  mimo: "https://platform.xiaomimimo.com/",
  doubao: "https://console.volcengine.com/ark/region:ark+cn-beijing/home",
  sakana: "https://sakana.ai/",
  abacus: "https://abacus.ai/",
  mistral: "https://console.mistral.ai/workspace/limits",
  deepseek: "https://platform.deepseek.com/usage",
  deepinfra: "https://deepinfra.com/dash/api_keys",
  codebuff: "https://www.codebuff.com/",
  venice: "https://venice.ai/",
  commandcode: "https://app.commandcode.com/",
  qoder: "https://qoder.com/",
  stepfun: "https://platform.stepfun.com/",
  bedrock: "https://console.aws.amazon.com/bedrock/home",
  grok: "https://console.x.ai/",
  groq: "https://console.groq.com/keys",
  litellm: "https://cloud.litellm.ai/",
  poe: "https://poe.com/",
  muse: "https://muse.ai/",
  coderabbit: "https://coderabbit.ai/",
  replicate: "https://replicate.com/account/billing",
  huggingface: "https://huggingface.co/settings/billing",
  raycast: "https://www.raycast.com/dashboard",
  pi: "https://pi.ai/",
  v0: "https://v0.dev/chat/settings/usage",
};

/** Status pages, keyed by the same provider ids. */
export const STATUS_URLS = {
  codex: "https://status.openai.com/",
  openai: "https://status.openai.com/",
  azureopenai: "https://azure.status.microsoft/en-us/status",
  claude: "https://status.claude.com/",
  cursor: "https://status.cursor.com/",
  opencode: "https://status.opencode.ai/",
  opencodego: "https://status.opencode.ai/",
  gemini: "https://status.cloud.google.com/",
  copilot: "https://www.githubstatus.com/",
  deepseek: "https://status.deepseek.com/",
  zai: "https://status.z.ai/",
  kimi: "https://status.moonshot.cn/",
  grok: "https://status.x.ai/",
  groq: "https://status.groq.com/",
  replicate: "https://status.replicate.com/",
  elevenlabs: "https://status.elevenlabs.io/",
  ollama: "https://status.ollama.com/",
  openrouter: "https://status.openrouter.ai/",
  v0: "https://www.vercel-status.com/",
  devin: "https://status.devin.ai/",
  windsurf: "https://status.windsurf.com/",
};

// Where each provider's credentials are configured in codexbar. One page covers
// all of them; the CLI owns the config format.
export const ADD_ACCOUNT_URL = "https://github.com/steipete/CodexBar/blob/main/docs/configuration.md";

// The project's own site, for "About".
export const ABOUT_URL = "https://codexbar.app";

// Only reachable when codexbar itself is missing, so this is the install hint.
export const INSTALL_URL = "https://github.com/steipete/CodexBar#installation";

const FALLBACK_DASHBOARD = "https://codexbar.app";

/**
 * @param {string} providerId
 * @returns {string} Usage dashboard, or the project site if unknown.
 */
export function usageUrl(providerId) {
  return USAGE_URLS[providerId] || FALLBACK_DASHBOARD;
}

/**
 * @param {string} providerId
 * @returns {string} Status page, or the project site if unknown.
 */
export function statusUrl(providerId) {
  return STATUS_URLS[providerId] || FALLBACK_DASHBOARD;
}