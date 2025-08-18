// leaflow.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');

const app = express();

// Set timezone from config
process.env.TZ = config.timezone;

// --- Utility Functions ---
/**
 * Checks if the request is authorized based on the AUTHORIZATION_KEY environment variable.
 * @param {express.Request} req - The incoming request object.
 * @returns {boolean} True if authorized, false otherwise.
 */
function checkAuth(req) {
  const { authorizationKey } = config.auth;
  return !authorizationKey || req.headers.authorization === `Bearer ${authorizationKey}`;
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
  console.error(`[Proxy Error] for ${operation}:`, err.message, err.stack);

  // Sanitize error message sent to client
  if (err.response) {
    const { status, data } = err.response;
    console.error(`[Proxy Error] Upstream service responded with status ${status}:`, data);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: 'Client error from upstream service.' });
    } else if (status >= 500) {
      return res.status(502).json({ error: 'Bad Gateway. Upstream service error.' });
    }
  } else if (err.request) {
    console.error(`[Proxy Error] No response received from internal service for ${operation}.`);
    return res.status(502).json({ error: 'Bad Gateway. No response from upstream service.' });
  } else {
    console.error(`[Proxy Error] Error setting up request to internal service for ${operation}:`, err.message);
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
app.use(morgan('combined'));

// --- Routes ---
app.get('/', (req, res) => {
  res.type('text/plain').send(`LEAFLOW API ${config.version}`);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/v1/models', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data } = await axios.get(config.llm.modelsUrl, {
      timeout: config.llm.requestTimeoutMs,
      headers: { Authorization: `Bearer ${config.auth.innerToken}` }
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
    const axRes = await axios.post(config.llm.chatUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.auth.innerToken}`
      },
      timeout: config.llm.requestTimeoutMs,
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
      res.status(axRes.status).json(axRes.data);
    }
  } catch (err) {
    return handleUpstreamError(err, res, '/v1/chat/completions');
  }
});

app.post('/v1/embeddings', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const payload = req.body;

  try {
    const axRes = await axios.post(config.llm.embeddingsUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.auth.innerToken}`
      },
      timeout: config.llm.requestTimeoutMs,
      responseType: 'json'
    });

    res.status(axRes.status).json(axRes.data);
  } catch (err) {
    return handleUpstreamError(err, res, '/v1/embeddings');
  }
});

// --- Startup ---
app.listen(config.port, () => {
  console.log(`[Server] Running on port ${config.port}`);
  console.log(`[Server] Version: ${config.version}`);
});
