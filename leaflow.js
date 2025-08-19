// leaflow.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const config = require('./config');

const app = express();

// Set timezone from config
process.env.TZ = config.timezone;

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.image.maxFileSize,
    files: config.image.maxImages
  },
  fileFilter: (req, file, cb) => {
    if (config.image.allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed types: ${config.image.allowedTypes.join(', ')}`));
    }
  }
});

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
/**
 * Validates if a URL is a valid image URL.
 * @param {string} url - The URL to validate.
 * @returns {boolean} True if valid image URL, false otherwise.
 */
function validateImageUrl(url) {
  try {
    new URL(url);
    return url.match(/\.(jpg|jpeg|png|gif|webp)$/i) !== null;
  } catch {
    return false;
  }
}

/**
 * Processes image content in messages, validating image URLs.
 * @param {Array|Object|string} content - The content to process.
 * @returns {Array|Object|string} The processed content.
 */
function processImageContent(content) {
  if (Array.isArray(content)) {
    return content.map(item => {
      if (item.type === 'image_url' && typeof item.image_url?.url === 'string') {
        if (!validateImageUrl(item.image_url.url)) {
          throw new Error('Invalid image URL format');
        }
      }
      return item;
    });
  }
  return content;
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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
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

app.post('/v1/chat/completions', upload.array('images', config.image.maxImages), async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  
  try {
    if (req.is('multipart/form-data')) {
      // Handle multipart/form-data requests (file uploads)
      payload = JSON.parse(req.body.payload || '{}');
      
      // Process uploaded image files
      if (req.files && req.files.length > 0) {
        const images = req.files.map(file => ({
          type: 'image_url',
          image_url: {
            url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`
          }
        }));
        
        // Add images to the last message
        if (payload.messages && payload.messages.length > 0) {
          const lastMessage = payload.messages[payload.messages.length - 1];
          if (!Array.isArray(lastMessage.content)) {
            lastMessage.content = [{ type: 'text', text: lastMessage.content }];
          }
          lastMessage.content.push(...images);
        }
      }
    } else {
      // Handle JSON requests (image URLs)
      payload = req.body;
      
      // Validate and process image content in JSON requests
      if (payload.messages && Array.isArray(payload.messages)) {
        payload.messages.forEach(message => {
          if (message.content) {
            message.content = processImageContent(message.content);
          }
        });
      }
    }
    
    const useStream = !!payload.stream;
    
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
    // Handle multer errors
    if (err.name === 'MulterError') {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Maximum size is ${config.image.maxFileSize / (1024 * 1024)}MB` });
      } else if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(413).json({ error: `Too many files. Maximum is ${config.image.maxImages} files` });
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Unexpected file field' });
      }
    }
    
    // Handle image validation errors
    if (err.message === 'Invalid image URL format') {
      return res.status(400).json({ error: 'Invalid image URL format' });
    }
    
    // Handle JSON parsing errors
    if (err instanceof SyntaxError && err.message.includes('Unexpected token')) {
      return res.status(400).json({ error: 'Invalid JSON in payload field' });
    }
    
    // Handle other upstream errors
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
