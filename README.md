# leaflow

---
[![Build & Push Docker Image](https://github.com/Water008/leaflow-proxy/actions/workflows/CI.yml/badge.svg)](https://github.com/Water008/leaflow-proxy/actions/workflows/CI.yml)

## API 接口

### Chat Completions
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Models
```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer YOUR_AUTH_KEY"
```

### Embeddings
```bash
curl -X POST http://localhost:3000/v1/embeddings \
  -H "Authorization: Bearer YOUR_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-ada-002",
    "input": "The food was delicious and the waiter was very friendly."
  }'
```