// index.js
// 依赖：npm install express axios cors
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- 基础配置 ---------- */
process.env.TZ = 'Asia/Shanghai';

/* ---------- 内网固定 Token ---------- */
const INNER_TOKEN = process.env.INNER_TOKEN || '';

/* ---------- 内网目标 ---------- */
const LEAFLOW_CHAT   = 'http://llm.ai-infra.svc.cluster.local/v1/chat/completions';
const LEAFLOW_MODELS = 'http://llm.ai-infra.svc.cluster.local/v1/models';

/* ---------- 中间件 ---------- */
app.set('trust proxy', 1);
app.use(cors());                   // 允许所有来源跨域；生产请按需配置
app.use(express.json());

/* ---------- 工具 ---------- */
function checkAuth(req) {
  const ak = process.env.AUTHORIZATION_KEY;
  return !ak || req.headers.authorization === `Bearer ${ak}`;
}

/* ---------- 路由 ---------- */
app.get('/', (req, res) => {
  res.type('text/plain').send('LEAFLOW API RUNNING V0.0.1');
});

app.get('/v1/models', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data } = await axios.get(LEAFLOW_MODELS, {
      timeout: 8000,
      headers: { Authorization: `Bearer ${INNER_TOKEN}` }
    });
    return res.json(data);
  } catch (err) {
    console.warn('fetch models failed:', err.message);
    return res.status(500).json({ error: err.message });
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
    console.error('proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------- 启动 ---------- */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
