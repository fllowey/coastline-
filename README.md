# COASTLINE AI

Responsive coastal-style Russian virtual try-on interface with FASHN API integration.

## Deploy the full-stack app
GitHub Pages only hosts static files and cannot run the AI backend. Deploy this repo as a Node.js web service (for example Render, Railway, or Replit).

- Build command: `npm install`
- Start command: `npm start`
- Environment secret: `FASHN_API_KEY` from https://app.fashn.ai/
- Node.js 20+ recommended

Do not commit a real .env or expose the API key in frontend code. The user uploads a person photo and garment photo; the server sends them to FASHN for processing. Upload only images you have permission to process. Before public launch, add rate limits, cost controls, strict CSP, and a privacy policy.