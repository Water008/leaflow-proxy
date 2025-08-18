// leaflow.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const config = require('./config');

const upload = multer({ storage: multer.memoryStorage() });

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

app.post('/v1/chat/completions', upload.single('image'), async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  let payload = req.body;
  const useStream = !!payload.stream;

  // If an image file is uploaded, process it
  if (req.file) {
    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    // Assuming the message structure is an array of messages,
    // and the last message is the one to which the image should be added.
    // This logic might need to be more sophisticated based on actual client requests.
    if (payload.messages && Array.isArray(payload.messages) && payload.messages.length > 0) {
      const lastMessage = payload.messages[payload.messages.length - 1];

      // Ensure the content is an array to add image_url part
      if (typeof lastMessage.content === 'string') {
        lastMessage.content = [{ type: 'text', text: lastMessage.content }];
      } else if (!Array.isArray(lastMessage.content)) {
        lastMessage.content = []; // Initialize if not string or array
      }

      lastMessage.content.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${base64Image}`,
          detail: 'high' // Or 'low', 'auto' based on requirements
        }
      });
    } else {
      // If no existing messages or unexpected structure, create a new message with the image
      payload.messages = [{
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${base64Image}`,
            detail: 'high'
          }
        }]
      }];
    }
  }

  try {
    const axRes = await axios.post(config.llm.chatUrl, payload, {
      headers: {
        'Content-Type': 'application/json', // Always send as JSON to upstream
        Authorization: `Bearer ${config.auth.innerToken}`
      },
      timeout: config.llm.requestTimeoutMs,
      responseType: useStream ? 'stream' : 'json'
    });

    if (useStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
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
