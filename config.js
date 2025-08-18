// config.js
require('dotenv').config();

/**
 * Tries to parse a string as an integer, returning a default value if parsing fails.
 * @param {string | undefined} value - The string value to parse.
 * @param {number} defaultValue - The default value to return on failure.
 * @returns {number} The parsed integer or the default value.
 */
function parseIntOrDefault(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

const config = {
  // Server configuration
  port: parseIntOrDefault(process.env.PORT, 3000),
  timezone: process.env.TZ || 'Asia/Shanghai',

  // Upstream service configuration
  llm: {
    baseURL: process.env.LLM_BASE_URL || 'http://llm.ai-infra.svc.cluster.local',
    chatEndpoint: '/v1/chat/completions',
    modelsEndpoint: '/v1/models',
    requestTimeoutMs: parseIntOrDefault(process.env.LLM_REQUEST_TIMEOUT_MS, 8000),
  },

  // Authorization tokens
  auth: {
    // Token for authenticating with the upstream LLM service
    innerToken: process.env.INNER_TOKEN || '',
    // Optional key to protect this proxy service
    authorizationKey: process.env.AUTHORIZATION_KEY,
  },
};

// --- Derived Values ---
// It's often useful to have fully constructed URLs in the config
config.llm.chatUrl = `${config.llm.baseURL}${config.llm.chatEndpoint}`;
config.llm.modelsUrl = `${config.llm.baseURL}${config.llm.modelsEndpoint}`;


// --- Validation ---
// Ensure critical environment variables are defined
const criticalEnvVars = ['INNER_TOKEN'];
const missingEnvVars = criticalEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  // Log the error and exit gracefully
  console.error(`[Config] Critical environment variables are missing: ${missingEnvVars.join(', ')}. Server will not start.`);
  process.exit(1); // Exit with a non-zero status code to indicate failure
}


module.exports = config;
