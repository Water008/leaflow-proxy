// leaflow.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const config = require('./config');

// Configure multer for file uploads
const upload = multer({ 
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept image files only
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传图片文件'));
    }
  }
});

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
 * Processes messages in the payload to handle image content.
 * Supports base64 encoded images and image URLs.
 * @param {Object} payload - The request payload.
 * @returns {Object} The processed payload with image content properly formatted.
 */
function processImageContent(payload) {
  // Create a deep copy of the payload to avoid modifying the original
  const processedPayload = JSON.parse(JSON.stringify(payload));
  
  // Check if messages exist in the payload
  if (!processedPayload.messages || !Array.isArray(processedPayload.messages)) {
    return processedPayload;
  }
  
  // Process each message
  processedPayload.messages = processedPayload.messages.map(message => {
    // Skip if message doesn't have content
    if (!message.content) {
      return message;
    }
    
    // Handle string content (no images)
    if (typeof message.content === 'string') {
      return message;
    }
    
    // Handle array content (may contain images)
    if (Array.isArray(message.content)) {
      // Process each content part
      const processedContent = message.content.map(part => {
        // If it's a text part, leave it as is
        if (part.type === 'text') {
          return part;
        }
        
        // If it's an image part, process it
        if (part.type === 'image_url') {
          // Handle image URL object
          if (typeof part.image_url === 'string') {
            return {
              type: 'image_url',
              image_url: {
                url: part.image_url
              }
            };
          }
          
          // Handle object with url property
          if (typeof part.image_url === 'object' && part.image_url.url) {
            return {
              type: 'image_url',
              image_url: {
                url: part.image_url.url,
                detail: part.image_url.detail || 'auto'
              }
            };
          }
        }
        
        // Return part unchanged if it doesn't match expected formats
        return part;
      });
      
      return {
        ...message,
        content: processedContent
      };
    }
    
    // Return message unchanged if content is neither string nor array
    return message;
  });
  
  return processedPayload;
}

/**
 * Processes messages in the payload to handle uploaded image files.
 * Converts uploaded files to base64 data URLs.
 * @param {Object} payload - The request payload.
 * @param {Array} files - The uploaded files from multer.
 * @returns {Object} The processed payload with image content properly formatted.
 */
function processImageContentWithFiles(payload, files) {
  // Create a deep copy of the payload to avoid modifying the original
  const processedPayload = JSON.parse(JSON.stringify(payload));
  
  // Check if messages exist in the payload
  if (!processedPayload.messages || !Array.isArray(processedPayload.messages)) {
    return processedPayload;
  }
  
  // Create a map of uploaded files by fieldname
  const fileMap = {};
  if (files && Array.isArray(files)) {
    files.forEach(file => {
      // Convert file buffer to base64 data URL
      const base64Data = file.buffer.toString('base64');
      const dataUrl = `data:${file.mimetype};base64,${base64Data}`;
      fileMap[file.fieldname] = dataUrl;
    });
  }
  
  // Process each message
  processedPayload.messages = processedPayload.messages.map(message => {
    // Skip if message doesn't have content
    if (!message.content) {
      return message;
    }
    
    // Handle string content (no images)
    if (typeof message.content === 'string') {
      return message;
    }
    
    // Handle array content (may contain images)
    if (Array.isArray(message.content)) {
      // Process each content part
      const processedContent = message.content.map(part => {
        // If it's a text part, leave it as is
        if (part.type === 'text') {
          return part;
        }
        
        // If it's an image part with a file reference, replace with base64 data URL
        if (part.type === 'image_file' && part.file_key) {
          const dataUrl = fileMap[part.file_key];
          if (dataUrl) {
            return {
              type: 'image_url',
              image_url: {
                url: dataUrl,
                detail: part.detail || 'auto'
              }
            };
          }
        }
        
        // If it's already an image_url part, process it
        if (part.type === 'image_url') {
          // Handle image URL object
          if (typeof part.image_url === 'string') {
            return {
              type: 'image_url',
              image_url: {
                url: part.image_url
              }
            };
          }
          
          // Handle object with url property
          if (typeof part.image_url === 'object' && part.image_url.url) {
            return {
              type: 'image_url',
              image_url: {
                url: part.image_url.url,
                detail: part.image_url.detail || 'auto'
              }
            };
          }
        }
        
        // Return part unchanged if it doesn't match expected formats
        return part;
      });
      
      return {
        ...message,
        content: processedContent
      };
    }
    
    // Return message unchanged if content is neither string nor array
    return message;
  });
  
  return processedPayload;
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

// Handle regular JSON requests
app.post('/v1/chat/completions', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  // Process payload to handle image content
  const payload = processImageContent(req.body);
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

// Handle multipart/form-data requests with file uploads
app.post('/v1/chat/completions', upload.array('images', 10), async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try {
    // Parse the JSON payload from the 'data' field
    payload = JSON.parse(req.body.data);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON in data field' });
  }

  // Process payload to handle image content
  payload = processImageContentWithFiles(payload, req.files);
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
