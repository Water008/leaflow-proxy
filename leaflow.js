// leaflow.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const morgan = require('morgan'); // Added for HTTP request logging

const app = express();
const PORT = process.env.PORT || 3000;
const LLM_REQUEST_TIMEOUT_MS = parseInt(process.env.LLM_REQUEST_TIMEOUT_MS, 10) || 8000;

// --- Configuration ---
process.env.TZ = 'Asia/Shanghai';

// --- Internal Service Constants ---
const INNER_TOKEN = process.env.INNER_TOKEN || '';
const LEAFLOW_CHAT = 'http://llm.ai-infra.svc.cluster.local/v1/chat/completions';
const LEAFLOW_MODELS = 'http://llm.ai-infra.svc.cluster.local/v1/models';

// --- Utility Functions ---
/**
 * Checks if the request is authorized based on the AUTHORIZATION_KEY environment variable.
 * @param {express.Request} req - The incoming request object.
 * @returns {boolean} True if authorized, false otherwise.
 */
function checkAuth(req) {
  const ak = process.env.AUTHORIZATION_KEY;
  return !ak || req.headers.authorization === `Bearer ${ak}`;
}

/**
 * Handles errors from axios requests to the internal LLM service.
 * Logs the full error server-side and sends a sanitized response to the client.
 * @param {Error} err - The error object from axios.
 * @param {express.Response} res - The Express response object.
 * @param {string} operation - A description of the operation that failed (for logging).
 */
function handleUpstreamError(err, res, operation) {
  // Log the full error for debugging server-side
  console.error(`Proxy error for ${operation}:`, err.message, err.stack);

  // Sanitize error message sent to client
  if (err.response) {
    const statusCode = err.response.status;
    if (statusCode >= 400 && statusCode < 500) {
      return res.status(statusCode).json({ error: 'Client error from upstream service.' });
    } else if (statusCode >= 500) {
      return res.status(502).json({ error: 'Bad Gateway. Upstream service error.' });
    }
  } else if (err.request) {
    console.error(`No response received from internal service for ${operation}.`);
    return res.status(502).json({ error: 'Bad Gateway. No response from upstream service.' });
  } else {
    console.error(`Error setting up request to internal service for ${operation}:`, err.message);
  }
  // Default to 500 for unexpected errors
  return res.status(500).json({ error: `Internal server error during ${operation} proxy.` });
}


// --- Middleware ---
app.set('trust proxy', 1);
// TODO: Restrict CORS to specific origins in production for enhanced security.
// Example: app.use(cors({ origin: ['https://yourdomain.com'] }));
app.use(cors());
app.use(express.json());
// Add HTTP request logging middleware
app.use(morgan('combined'));

// --- Routes ---
app.get('/', (req, res) => {
  res.type('text/plain').send('LEAFLOW API RUNNING V0.0.1');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/v1/models', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data } = await axios.get(LEAFLOW_MODELS, {
      timeout: LLM_REQUEST_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${INNER_TOKEN}` }
    });
    return res.json(data);
  } catch (err) {
    return handleUpstreamError(err, res, '/v1/models');
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const payload = req.body;
  const useStream = !!payload.stream;

  try {
    const axRes = await axios.post(LEAFLOW_CHAT, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INNER_TOKEN}`
      },
      timeout: LLM_REQUEST_TIMEOUT_MS,
      responseType: useStream ? 'stream' : 'json'
    });

    if (useStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      // Add header to prevent buffering by reverse proxies if necessary
      // res.setHeader('X-Accel-Buffering', 'no');
      axRes.data.pipe(res);
    } else {
      // Forward the status code and data from the internal service
      res.status(axRes.status).json(axRes.data);
    }
  } catch (err) {
    return handleUpstreamError(err, res, '/v1/chat/completions');
  }
});

// --- Startup ---
// Check for critical environment variables
const criticalEnvVars = ['INNER_TOKEN'];
const missingEnvVars = criticalEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error(`Critical environment variables are missing: ${missingEnvVars.join(', ')}. Server will not start.`);
  process.exit(1); // Exit with a non-zero status code to indicate failure
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
