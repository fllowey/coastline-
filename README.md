# COASTLINE AI

Responsive Russian virtual try-on website with a coastal design.

## Deploy

Deploy this repository as a Node.js web service (for example, Render). GitHub Pages cannot run the backend.

- Build command: `npm install`
- Start command: `npm start`
- Node.js 20+ recommended
- No FASHN paid API key is required for the current experimental integration.

The server connects to the public Hugging Face Space `merve/fashn-vton-1.5` using the Gradio client. This is a best-effort free demo integration: the public Space may sleep, queue requests, change its API, or become unavailable. It is not guaranteed for production use and may have usage limits.

Uploaded person and clothing photos are sent from the server to the public model host for processing. Only upload images you have permission to process. Before opening the site to the public, add rate limiting, abuse protection, clear privacy disclosures, and review the model host's terms.
