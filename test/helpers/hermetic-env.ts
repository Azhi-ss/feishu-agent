/**
 * Hermetic subprocess environment for CLI tests.
 *
 * Pi's ModelRuntime discovers ambient models from provider credential/config
 * variables in the environment (Anthropic, OpenAI, Gemini, …). A CLI subprocess
 * that inherits the developer's shell therefore sees real models even when the
 * fixture's HOME-scoped `~/.pi/agent` declares none — so tests asserting "no
 * authenticated model is available" instead find the host credentials and fall
 * through to a live network call. `hermeticEnv` strips those variables so model
 * discovery depends only on the fixture's auth/models; test-provided overrides
 * (HOME, PATH, MEM0_API_KEY, …) are applied last and always win.
 */

const MODEL_ENV_PATTERN =
  /^(?:ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|OPENROUTER|DEEPSEEK|XAI|GROK|MISTRAL|COHERE|OLLAMA|AZURE|VERTEX|BEDROCK|AMAZON_BEDROCK|AWS|TOGETHER|TOGETHERAI|FIREWORKS|DATABRICKS|PERPLEXITY|MOONSHOT|MOONSHOTAI|KIMI|CEREBRAS|BASETEN|CLOUDFLARE|NVIDIA|LLAMA|MINIMAX|MINIMAX_CN|HUGGINGFACE|OPENCODE|AI_GATEWAY|ANT_LING|COPILOT_GITHUB|DASHSCOPE|ZHIPU|BAILIAN|QWEN|NOVITA|LEPTON)(?:_[A-Z0-9]+)*$/;

const CREDENTIAL_SUFFIX = /(?:^|_)(API_KEY|APIKEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY|BEARER_TOKEN)$/;

export function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (MODEL_ENV_PATTERN.test(key) || CREDENTIAL_SUFFIX.test(key)) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}
