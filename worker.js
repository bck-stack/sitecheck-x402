// Cloudflare Worker entry. Config comes from wrangler.toml [vars] and Worker secrets;
// the app lives in lib/app.js, the per-network x402 wiring in lib/payments.js.
import { createApp } from "./lib/app.js";

export default createApp();
