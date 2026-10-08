// POST /api/pdf: text of a PDF (by https URL or base64, up to 15 MB) page by page, with title, author, page count
// and creation date. Text PDFs only: a scanned PDF without a text layer answers 422 and is not charged (no OCR).
import { badInput, clampInt, ToolError, upstreamDown } from "./upstream.js";

const MAX_BYTES = 15_000_000;
const UA = "Mozilla/5.0 (compatible; SiteCheckReader/1.0; +https://api.sitecheck-api.workers.dev)";

const fromBase64 = (s) => { const bin = atob(s.replace(/^data:[^,]*,/, "").replace(/\s+/g, "")); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const isoPdfDate = (s) => { const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || ""); return m ? `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}Z` : null; };

export async function pdf(body) {
  let bytes;
  if (body.pdf_base64) {
    if (typeof body.pdf_base64 !== "string" || body.pdf_base64.length > MAX_BYTES * 1.4) throw badInput("pdf_base64 must be a base64 string of at most 15 MB");
    try { bytes = fromBase64(body.pdf_base64); } catch { throw badInput("pdf_base64 is not valid base64"); }
  } else {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) throw badInput("url (http/https link to a PDF) or pdf_base64 is required");
    let res;
    try { res = await fetch(url, { headers: { "user-agent": UA, accept: "application/pdf,*/*" }, redirect: "follow", signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw (e?.name === "TimeoutError" ? upstreamDown("The PDF host", "timed out") : new ToolError(502, "The PDF could not be downloaded, you were not charged.")); }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new ToolError(502, `The PDF host answered HTTP ${res.status}, you were not charged.`); }
    if (Number(res.headers.get("content-length") || 0) > MAX_BYTES) { await res.body?.cancel().catch(() => {}); throw badInput("PDF larger than 15 MB"); }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw badInput("PDF larger than 15 MB");
    bytes = new Uint8Array(buf);
  }
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") throw badInput("This is not a PDF file (it does not start with %PDF-)");
  const maxChars = clampInt(body.maxChars, 100000, 1000, 500000);
  const { getDocumentProxy, extractText, getMeta } = await import("unpdf");
  let doc;
  try { doc = await getDocumentProxy(bytes); }
  catch (e) { throw new ToolError(422, `The PDF could not be opened (${String(e?.message || e).slice(0, 100)}); you were not charged.`); }
  const [{ totalPages, text }, meta] = await Promise.all([extractText(doc, { mergePages: false }), getMeta(doc).catch(() => ({ info: {} }))]);
  const pages = text.map((t, i) => ({ page: i + 1, text: t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() }));
  const chars = pages.reduce((s, p) => s + p.text.length, 0);
  if (chars < 8) throw new ToolError(422, "The PDF has no text layer (probably scanned images); OCR is not offered, you were not charged.");
  let left = maxChars;
  const out = [];
  for (const p of pages) { if (left <= 0) break; const t = p.text.slice(0, left); out.push({ page: p.page, text: t }); left -= t.length; }
  const info = meta.info || {};
  return {
    pages: totalPages, title: info.Title || null, author: info.Author || null, subject: info.Subject || null, creator: info.Creator || null, producer: info.Producer || null,
    createdAt: isoPdfDate(info.CreationDate), modifiedAt: isoPdfDate(info.ModDate),
    chars, truncated: chars > maxChars, pagesReturned: out.length,
    text: out.map((p) => p.text).join("\n\n"), byPage: out,
    note: "Text layer only, no OCR. Layout (columns, tables) is flattened to reading order.",
  };
}
