#!/usr/bin/env bash
# Canonical list of credential/provider env vars to clear for hermetic test runs.
# Source this from test.sh / pi-test.sh instead of duplicating the list in each.
#
# The union of every provider key Pit may read (see packages/ai/src/env-api-keys.ts
# and stream.ts). Keep this as the single source of truth so new providers are not
# forgotten in one of the scripts.

PIT_TEST_ENV_VARS=(
  ANTHROPIC_API_KEY
  ANTHROPIC_OAUTH_TOKEN
  OPENAI_API_KEY
  GEMINI_API_KEY
  GROQ_API_KEY
  CEREBRAS_API_KEY
  XAI_API_KEY
  OPENROUTER_API_KEY
  ZAI_API_KEY
  MISTRAL_API_KEY
  MINIMAX_API_KEY
  MINIMAX_CN_API_KEY
  KIMI_API_KEY
  HF_TOKEN
  AI_GATEWAY_API_KEY
  OPENCODE_API_KEY
  COPILOT_GITHUB_TOKEN
  GH_TOKEN
  GITHUB_TOKEN
  GOOGLE_APPLICATION_CREDENTIALS
  GOOGLE_CLOUD_PROJECT
  GCLOUD_PROJECT
  GOOGLE_CLOUD_LOCATION
  AWS_PROFILE
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  AWS_SESSION_TOKEN
  AWS_REGION
  AWS_DEFAULT_REGION
  AWS_BEARER_TOKEN_BEDROCK
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  AWS_CONTAINER_CREDENTIALS_FULL_URI
  AWS_WEB_IDENTITY_TOKEN_FILE
  BEDROCK_EXTENSIVE_MODEL_TEST
  FIREWORKS_API_KEY
  AZURE_OPENAI_API_KEY
  AZURE_OPENAI_BASE_URL
  AZURE_OPENAI_RESOURCE_NAME
)

clear_test_env() {
  for var in "${PIT_TEST_ENV_VARS[@]}"; do
    unset "$var"
  done
}
