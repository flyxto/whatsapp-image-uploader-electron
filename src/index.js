'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } = require('electron');
app.setName('whatsapp-booth');
const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ── Dependencies (loaded after dotenv) ────────────────────────────────────────
const chokidar = require('chokidar');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const sharp = require('sharp');
sharp.cache(false);

// ── Mongo API Server config ───────────────────────────────────────────────────
const API_BASE = process.env.MONGO_API_URL || 'http://localhost:4000';

/** Thin wrapper — all DB calls go through the Express API server. */
const db = {
  async health() {
    const r = await axios.get(`${API_BASE}/health`, { timeout: 5000 });
    return r.data;
  },
  async findOne(imageId) {
    const r = await axios.get(`${API_BASE}/users/${encodeURIComponent(imageId)}`, { timeout: 8000 });
    return r.data.doc;
  },
  async findByCode(code) {
    const r = await axios.get(`${API_BASE}/users/code/${encodeURIComponent(code)}`, { timeout: 8000 });
    return r.data.doc;
  },
  async batchFind(ids) {
    if (!ids.length) return [];
    const r = await axios.post(`${API_BASE}/users/batch-find`, { ids }, { timeout: 10000 });
    return r.data.docs;
  },
  async upsert(imageId, fields) {
    const r = await axios.post(`${API_BASE}/users/upsert`, { imageId, ...fields }, { timeout: 10000 });
    return r.data.doc;
  },
  async update(imageId, fields) {
    await axios.patch(`${API_BASE}/users/${encodeURIComponent(imageId)}`, fields, { timeout: 8000 });
  },
  async linkCode(code, newImageId) {
    const r = await axios.patch(`${API_BASE}/users/${encodeURIComponent(code)}/link`, { newImageId }, { timeout: 8000 });
    return r.data.doc;
  },
  async deleteOne(imageId) {
    await axios.delete(`${API_BASE}/users/${encodeURIComponent(imageId)}`, { timeout: 8000 });
  },
  async findWaiting(ids) {
    if (!ids.length) return [];
    const r = await axios.post(`${API_BASE}/users/waiting`, { ids }, { timeout: 8000 });
    return r.data.docs;
  },
  async retryFailed() {
    const r = await axios.post(`${API_BASE}/users/retry-failed`, {}, { timeout: 10000 });
    return r.data.count;
  },
  async stats() {
    const r = await axios.get(`${API_BASE}/stats`, { timeout: 8000 });
    return r.data;
  },
  async getAllEvents() {
    const r = await axios.get(`${API_BASE}/events`, { timeout: 8000 });
    return r.data.events;
  },
  async saveEvent(eventName, eventPrefix) {
    await axios.post(`${API_BASE}/events`, { eventName, eventPrefix }, { timeout: 8000 });
  },
};
const QRCode = require('qrcode');

// ── Cloudflare R2 client ──────────────────────────────────────────────────────
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.CF_ACCESS_KEY_ID,
    secretAccessKey: process.env.CF_SECRET_ACCESS_KEY,
  },
});

// ── DB state (driven by API health polling) ──────────────────────────────────
let dbConnected = false;

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindow  = null;
let watcher     = null;
let retryTimer  = null;                        // interval id for the retry loop
// Set of imageIds currently being processed (prevent double-processing)
const processingSet = new Set();
// Files that arrived before a matching user registered — retried every 10 s
const waitingFiles  = new Map();               // imageId → filePath
const uploadQueue   = [];                      // sequential queue for files to process
let queueProcessing = false;                   // flag indicating if queue is currently processing

// ── Config persistence ────────────────────────────────────────────────────────
// Stored in: ~/Library/Application Support/<appName>/config.json  (macOS)
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function getFramesDir() {
  const dir = path.join(app.getPath('userData'), 'frames');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveConfig(updates) {
  const current = loadConfig();
  const next    = { ...current, ...updates };
  fs.writeFileSync(getConfigPath(), JSON.stringify(next, null, 2), 'utf8');
}

/** Upside-down booth rotate. On unless explicitly turned off. */
function isRotate180Enabled(cfg = loadConfig()) {
  return cfg.rotate180 !== false;
}

const DEFAULT_WHATSAPP_TEMPLATE = 'pop_culture';

function getWhatsAppTemplateName(cfg = loadConfig()) {
  const name = String(cfg.whatsappTemplate || '').trim().toLowerCase();
  return /^[a-z0-9_]+$/.test(name) ? name : DEFAULT_WHATSAPP_TEMPLATE;
}

/** EXIF auto-orient, then optional 180° rotate. */
async function preparePhoto(filePath) {
  const oriented = await sharp(filePath).rotate().toBuffer();
  if (!isRotate180Enabled()) return oriented;
  return sharp(oriented).rotate(180).toBuffer();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Send a log entry to the renderer */
function log(level, message, imageId = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', { level, message, imageId, ts: new Date().toISOString() });
  }
  console[level === 'error' ? 'error' : 'log'](`[${level.toUpperCase()}]`, message);
}

/** Sleep helper */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Supported image extensions */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff']);

function isImage(filePath) {
  return IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

function formatDateYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** Extract image ID: pull all digits from the filename, return prefix + YYYYMMDD + last 4 digits */
function extractImageId(filePath) {
  const base   = path.basename(filePath, path.extname(filePath));
  const digits = base.replace(/\D/g, ''); // strip non-digits
  const last4 = digits.slice(-4) || '0000'; // fallback last 4 digits

  const cfg = loadConfig();
  const prefix = (cfg.eventPrefix || '').toUpperCase();
  
  // Format the date using the file modification time or current date
  let dateStr = '';
  try {
    let resolvedPath = filePath;
    if (!fs.existsSync(resolvedPath) && cfg.lastFolder) {
      const altPath = path.join(cfg.lastFolder, filePath);
      if (fs.existsSync(altPath)) {
        resolvedPath = altPath;
      }
    }

    if (fs.existsSync(resolvedPath)) {
      const stats = fs.statSync(resolvedPath);
      const date = stats.birthtime || stats.mtime || new Date();
      dateStr = formatDateYYYYMMDD(date);
    } else {
      dateStr = formatDateYYYYMMDD(new Date());
    }
  } catch (_) {
    dateStr = formatDateYYYYMMDD(new Date());
  }

  return `${prefix}${dateStr}${last4}`;
}

/** Extract event-specific guest code from image ID (e.g. CMB202607181024 -> CMB1024) */
function getCodeFromImageId(imageId) {
  const match = (imageId || '').match(/^([A-Za-z]+)\d{8}(\d{4})$/);
  if (match) {
    return `${match[1].toUpperCase()}${match[2]}`;
  }
  return imageId;
}


// ── API connection / health poll ─────────────────────────────────────────────

async function connectMongo() {
  try {
    const health = await db.health();
    const wasConnected = dbConnected;
    dbConnected = !!health.dbConnected;
    if (dbConnected && !wasConnected) {
      log('info', '✅ API server + MongoDB connected');
      if (mainWindow) mainWindow.webContents.send('db-status', { connected: true });
    } else if (!dbConnected && wasConnected) {
      log('warn', '⚠️ API server reachable but MongoDB disconnected');
      if (mainWindow) mainWindow.webContents.send('db-status', { connected: false });
    } else if (!dbConnected) {
      log('warn', '⚠️ API server reachable — waiting for MongoDB...');
    }
  } catch (err) {
    if (dbConnected) {
      log('error', `❌ Cannot reach API server: ${err.message}`);
      if (mainWindow) mainWindow.webContents.send('db-status', { connected: false, error: err.message });
    }
    dbConnected = false;
  }
}

/** Poll the API health every 10 seconds to keep dbConnected up-to-date. */
function startHealthPoll() {
  connectMongo();
  setInterval(connectMongo, 10000);
}

// ── Cloudflare R2 upload ──────────────────────────────────────────────────────

async function uploadToCloudflare(filePath, imageId) {
  log('info', `🚀 Uploading photo to Cloudflare R2…`, imageId);

  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : 'image/jpeg';

  const key = `processed/${imageId}${ext}`;
  const fileBuffer = fs.readFileSync(filePath);

  // 1. Generate pre-signed URL
  const command = new PutObjectCommand({
    Bucket:      process.env.CF_BUCKET_NAME,
    Key:         key,
    ContentType: contentType,
  });
  const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

  // 2. PUT image to pre-signed URL
  await axios.put(presignedUrl, fileBuffer, {
    headers: { 'Content-Type': contentType },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 60000,
  });

  // 3. Build final public URL
  const publicUrl = `${process.env.CF_PUBLIC_URL}/${key}`;
  log('info', `✅ Image uploaded: ${publicUrl}`, imageId);
  return publicUrl;
}

// ── WhatsApp notification ─────────────────────────────────────────────────────

/**
 * Normalise a phone number to WhatsApp international format (digits only, no +).
 * Handles:
 *   +94766831319  →  94766831319
 *   0766831319    →  94766831319  (Sri Lanka local → prepend 94, strip leading 0)
 *   94766831319   →  94766831319  (already correct)
 */
function normalisePhone(phone) {
  // Strip everything except digits
  let digits = phone.replace(/\D/g, '');

  // Local format: starts with 0 and is ~10 digits (Sri Lanka)
  // Replace leading 0 with country code 94
  if (digits.startsWith('0') && digits.length <= 11) {
    digits = '94' + digits.slice(1);
  }

  return digits;
}

async function sendWhatsApp(phone, imageUrl, userName) {
  const normalised = normalisePhone(phone);
  log('info', `📲 Sending WhatsApp to ${normalised} (original: ${phone})…`);

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: normalised,
        type: "template",
        template: {
          name: getWhatsAppTemplateName(),
          language: { code: "en" },
          components: [
            {
              type: "header",
              parameters: [
                {
                  type: "image",
                  image: { link: imageUrl },
                },
              ],
            },
          ],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );

    log('info', `✅ WhatsApp sent to ${normalised} — message id: ${response.data?.messages?.[0]?.id ?? 'n/a'}`);
  } catch (err) {
    // Extract the real Meta API error from the response body
    const apiErr = err?.response?.data?.error;
    const detail = apiErr
      ? `[${apiErr.code}] ${apiErr.message}${apiErr.error_data?.details ? ' — ' + apiErr.error_data.details : ''}`
      : err.message;
    throw new Error(`WhatsApp API error: ${detail}`);
  }
}

// ── Frame overlay helper ──────────────────────────────────────────────────────

const frameCache = {}; // Cache frame metadata to avoid recomputing

async function applyActiveFrame(filePath, imageId) {
  const cfg = loadConfig();
  if (!cfg.activeFrame) return null;

  const framePath = path.join(getFramesDir(), cfg.activeFrame);
  if (!fs.existsSync(framePath)) return null;

  try {
    const tempFile = path.join(app.getPath('temp'), `framed_${imageId}.jpg`);
    
    // 1. Get frame metadata
    if (!frameCache[cfg.activeFrame]) {
      const info = await sharp(framePath).metadata();
      frameCache[cfg.activeFrame] = info;
    }

    const meta = frameCache[cfg.activeFrame];

    // 2. Auto-orient based on EXIF, then optional 180° for upside-down booth effect
    const orientedBuffer = await preparePhoto(filePath);

    // 3. Resize photo to full frame size (matches height, crops width) and overlay frame
    await sharp(orientedBuffer)
      .resize(meta.width, meta.height, { fit: 'cover' })
      .composite([{ input: framePath }])
      .jpeg({ quality: 100 })
      .toFile(tempFile);
      
    log('info', `🖼️  Applied frame: ${cfg.activeFrame}`, imageId);
    return tempFile;
  } catch (err) {
    log('error', `⚠️ Failed to apply frame: ${err.message}`, imageId);
    return null;
  }
}

// ── Queue System ──────────────────────────────────────────────────────────────

function enqueueImage(filePath) {
  const imageId = extractImageId(filePath);

  // Check if this imageId is already being processed
  if (processingSet.has(imageId)) {
    log('info', `⏭️  Skip queuing ${imageId} — already processing`, imageId);
    return;
  }

  // Check if this file is already in the queue
  if (uploadQueue.includes(filePath)) {
    return;
  }

  // Check if another file with the same imageId is already in the queue
  const isIdQueued = uploadQueue.some(queuedPath => extractImageId(queuedPath) === imageId);
  if (isIdQueued) {
    log('info', `⏭️  Skip queuing ${imageId} — already queued`, imageId);
    return;
  }

  uploadQueue.push(filePath);
  log('info', `📥 Queued file: ${path.basename(filePath)} (Queue size: ${uploadQueue.length})`);
  triggerQueueProcessing();
}

async function triggerQueueProcessing() {
  if (queueProcessing) return;
  queueProcessing = true;

  while (uploadQueue.length > 0) {
    const nextPath = uploadQueue.shift();
    try {
      await processImage(nextPath);
    } catch (err) {
      log('error', `❌ Queue error processing ${nextPath}: ${err.message}`);
    }
  }

  queueProcessing = false;
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

async function processImage(filePath) {
  const imageId = extractImageId(filePath);

  if (processingSet.has(imageId)) {
    log('info', `⏭️  Already processing ${imageId}, skipping`);
    return;
  }

  // Fast pre-check: if already completed in DB, skip debounce sleep and return immediately
  if (dbConnected) {
    try {
      const doc = await db.findOne(imageId);
      if (doc && (doc.status === 'completed' || doc.status === 'generated')) {
        log('info', `⏭️  imageId "${imageId}" already ${doc.status} — skipping lookup`, imageId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('image-status', {
            imageId,
            status:   doc.status,
            imageUrl: doc.imageUrl || undefined,
            phone:    doc.phone    || undefined,
            hide:     doc.hide     || false,
            filePath,
          });
        }
        return;
      }
    } catch (err) {
      log('warn', `⚠️ DB pre-check lookup failed for ${imageId}: ${err.message}`);
    }
  }

  // Small debounce – wait for file write to complete
  await sleep(1500);

  if (!fs.existsSync(filePath)) return; // file vanished

  processingSet.add(imageId);
  log('info', `🔍 Detected: ${path.basename(filePath)} → ID: ${imageId}`, imageId);

  // Generate a small thumbnail for the dashboard preview
  let previewUrl = null;
  try {
    const oriented = await preparePhoto(filePath);
    const thumbBuffer = await sharp(oriented)
      .resize(140)
      .jpeg({ quality: 80 })
      .toBuffer();
    previewUrl = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
  } catch (_) { /* non-critical */ }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('image-status', { imageId, status: 'detected', filePath, previewUrl });
  }

  try {
    if (!dbConnected) throw new Error('API server not connected');

    let doc = await db.findOne(imageId);

    // Link pre-registration: check if user registered using the short code before the photo was uploaded
    if (!doc) {
      const code = getCodeFromImageId(imageId);
      const shortDoc = await db.findByCode(code);
      if (shortDoc) {
        log('info', `🔗 Found pre-registered user by code "${code}". Linking to full imageId "${imageId}"...`, imageId);
        doc = await db.linkCode(code, imageId);
      }
    }

    if (doc && (doc.status === 'completed' || doc.status === 'generated')) {
      log('info', `⏭️  imageId "${imageId}" already ${doc.status} — skipping`, imageId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('image-status', {
          imageId,
          status:   doc.status,
          imageUrl: doc.imageUrl || undefined,
          phone:    doc.phone    || undefined,
          hide:     doc.hide     || false,
          filePath,
        });
      }
      processingSet.delete(imageId);
      return;
    }

    // 1. Always apply frame (with 180° rotation) and upload to Cloudflare
    let imageUrl;
    {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('image-status', { imageId, status: 'processing', user: doc ? { name: doc.name, phone: doc.phone } : undefined, hide: doc?.hide });
      }
      
      const tempFile = await applyActiveFrame(filePath, imageId);
      
      if (!tempFile) {
        log('warn', `🚫 No frame applied for imageId "${imageId}" — ignoring upload`, imageId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('image-status', { imageId, status: 'error' });
        }
        processingSet.delete(imageId);
        return;
      }
      
      const uploadPath = tempFile;

      imageUrl = await uploadToCloudflare(uploadPath, imageId);
      if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      
      // Upsert via API with imageUrl and code
      doc = await db.upsert(imageId, {
        imageUrl,
        status: 'uploaded',
        code:   getCodeFromImageId(imageId),
      });
      
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('image-status', { imageId, status: 'uploaded', imageUrl, user: doc ? { name: doc.name, phone: doc.phone } : undefined, hide: doc?.hide });
      }
    }

    // 2. Check if we have a phone number to send to
    if (!doc || !doc.phone) {
      log('warn', `⏳ No phone number yet for imageId "${imageId}" — queuing for retry`, imageId);
      waitingFiles.set(imageId, filePath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('image-status', { imageId, status: 'no-match', imageUrl, user: doc ? { name: doc.name, phone: doc.phone } : undefined, hide: doc?.hide });
      }
      processingSet.delete(imageId);
      return;
    }

    // 3. We have both imageUrl and phone, so send WhatsApp
    log('info', `👤 Matched user: ${doc.name || 'Unknown'} (${doc.phone})`, imageId);
    await sendWhatsApp(doc.phone, imageUrl, doc.name);

    await db.update(imageId, { status: 'completed', completedAt: new Date() });
    waitingFiles.delete(imageId);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('image-status', { imageId, status: 'completed', imageUrl, user: doc ? { name: doc.name, phone: doc.phone } : undefined, hide: doc?.hide });
    }

    log('info', `🎉 Done! ${imageId} → ${imageUrl}`, imageId);
  } catch (err) {
    const msg =
      err?.error?.message ||
      err?.message ||
      (typeof err === 'string' ? err : null) ||
      JSON.stringify(err);
    const code = err?.http_code || err?.error?.http_code || '';
    const full = code ? `[HTTP ${code}] ${msg}` : msg;
    log('error', `❌ Failed to process ${imageId}: ${full}`, imageId);
    if (dbConnected) {
      await db.update(imageId, { status: 'failed', errorMsg: full }).catch(() => {});
    }
    if (mainWindow) mainWindow.webContents.send('image-status', { imageId, status: 'failed', error: full });
  } finally {
    processingSet.delete(imageId);
  }
}

// Function to scan local folder and cross-reference with DB status in batch
async function getInitialImages(folderPath) {
  if (!fs.existsSync(folderPath)) return [];
  try {
    const files = fs.readdirSync(folderPath);
    const imageFiles = files.filter(f => isImage(path.join(folderPath, f)));
    const ids = imageFiles.map(f => extractImageId(f));

    let dbRecords = [];
    if (dbConnected && ids.length > 0) {
      dbRecords = await db.batchFind(ids);
    }
    const dbMap = new Map(dbRecords.map(r => [r.imageId, r]));

    const list = [];
    for (const file of imageFiles) {
      const filePath = path.join(folderPath, file);
      const imageId = extractImageId(filePath);
      const doc = dbMap.get(imageId);
      const stats = fs.statSync(filePath);

      let previewUrl = null;
      try {
        const oriented = await preparePhoto(filePath);
        const thumbBuffer = await sharp(oriented)
          .resize(140)
          .jpeg({ quality: 80 })
          .toBuffer();
        previewUrl = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
      } catch (_) {}

      list.push({
        imageId,
        filePath,
        status: doc?.status || 'detected',
        previewUrl,
        imageUrl: doc?.imageUrl,
        user: doc ? { name: doc.name, phone: doc.phone } : undefined,
        hide: doc?.hide,
        mtime: stats.birthtimeMs || stats.mtimeMs
      });
    }

    // Sort: oldest first (so when renderer prepends them, the newest ends up at the top)
    return list.sort((a, b) => a.mtime - b.mtime);
  } catch (err) {
    log('error', `⚠️ Failed to get initial images: ${err.message}`);
    return [];
  }
}

async function retryWaiting() {
  if (waitingFiles.size === 0 || !dbConnected) return;

  try {
    const waitingIds = Array.from(waitingFiles.keys());

    // Ask API for all waiting IDs that now have a phone number
    const claimedDocs = await db.findWaiting(waitingIds);

    if (claimedDocs.length === 0) return;

    log('info', `🔁 Found ${claimedDocs.length} newly claimed image(s). Enqueuing...`);

    for (const doc of claimedDocs) {
      const filePath = waitingFiles.get(doc.imageId);
      
      if (processingSet.has(doc.imageId)) continue;

      if (filePath && fs.existsSync(filePath)) {
        enqueueImage(filePath);
      } else {
        log('warn', `🗑️ File gone: ${filePath}`, doc.imageId);
        waitingFiles.delete(doc.imageId);
      }
    }
  } catch (err) {
    log('error', `⚠️ Error in retry check: ${err.message}`);
  }
}

// ── Folder watching ───────────────────────────────────────────────────────────

async function startWatcher(folderPath) {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  waitingFiles.clear();
  uploadQueue.length = 0;                        // Clear any pending queue items on start

  log('info', `👁️  Watching folder: ${folderPath}`);

  // Populate waitingFiles with existing files that are not completed yet
  try {
    if (fs.existsSync(folderPath)) {
      const files = fs.readdirSync(folderPath);
      const imageFiles = files.filter(f => isImage(path.join(folderPath, f)));
      const ids = imageFiles.map(f => extractImageId(f));

      let dbRecords = [];
      if (dbConnected && ids.length > 0) {
        dbRecords = await db.batchFind(ids);
      }
      const dbMap = new Map(dbRecords.map(r => [r.imageId, r]));

      for (const file of imageFiles) {
        const filePath = path.join(folderPath, file);
        const imageId = extractImageId(filePath);
        const doc = dbMap.get(imageId);

        // If file has not been uploaded yet, enqueue it for processing/upload
        if (!doc || !doc.imageUrl) {
          enqueueImage(filePath);
        }

        // If file isn't completed or delivered via QR, add to retry queue
        if (!doc || (doc.status !== 'completed' && doc.status !== 'generated')) {
          waitingFiles.set(imageId, filePath);
        }
      }
      if (waitingFiles.size > 0) {
        log('info', `📥 Initialized retry queue with ${waitingFiles.size} unmatched/incomplete file(s)`);
      }
    }
  } catch (err) {
    log('error', `⚠️ Failed to initialize retry queue: ${err.message}`);
  }

  // Retry any unmatched files every 10 seconds
  const RETRY_INTERVAL = parseInt(process.env.RETRY_INTERVAL_MS || '10000', 10);
  retryTimer = setInterval(retryWaiting, RETRY_INTERVAL);
  log('info', `⏱️  Retry interval: ${RETRY_INTERVAL / 1000}s`);

  watcher = chokidar.watch(folderPath, {
    ignored: /(^|[/\\])\../,  // ignore dot-files
    persistent: true,
    ignoreInitial: true,     // ignore initial scan as we already populated wait files and batch loaded
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 200,
    },
  });

  watcher
    .on('add', (filePath) => {
      if (isImage(filePath)) enqueueImage(filePath);
    })
    .on('change', (filePath) => {
      if (isImage(filePath)) enqueueImage(filePath);
    })
    .on('unlink', (filePath) => {
      for (const [id, pathVal] of waitingFiles.entries()) {
        if (pathVal === filePath) {
          waitingFiles.delete(id);
          log('info', `🗑️ File removed locally: ${path.basename(filePath)} (removed from retry queue)`);
          break;
        }
      }
    })
    .on('error', (err) => log('error', `Watcher error: ${err.message}`));
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Photo Booth Images Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('start-watch', async (_, folderPath) => {
  // Persist so it's restored on next launch
  saveConfig({ lastFolder: folderPath });
  await connectMongo(); // ensure latest health status before starting
  await startWatcher(folderPath);
  return { success: true };
});

ipcMain.handle('get-saved-folder', () => {
  const cfg = loadConfig();
  return cfg.lastFolder || null;
});

ipcMain.handle('get-whatsapp-template', () => getWhatsAppTemplateName());

ipcMain.handle('set-whatsapp-template', (_, name) => {
  const cleaned = String(name || '').trim().toLowerCase();
  const valid = /^[a-z0-9_]+$/.test(cleaned);
  const whatsappTemplate = valid ? cleaned : getWhatsAppTemplateName();
  if (valid) saveConfig({ whatsappTemplate });
  log('info', `💬 WhatsApp template set to ${whatsappTemplate}`);
  return { whatsappTemplate };
});

ipcMain.handle('get-rotate-setting', () => isRotate180Enabled());

ipcMain.handle('set-rotate-setting', (_, enabled) => {
  const rotate180 = !!enabled;
  saveConfig({ rotate180 });
  log('info', rotate180 ? '🔄 180° rotate enabled' : '🔄 180° rotate disabled');
  return { rotate180 };
});

ipcMain.handle('get-event-config', () => {
  const cfg = loadConfig();
  return {
    eventName: cfg.eventName || '',
    eventPrefix: cfg.eventPrefix || '',
  };
});

ipcMain.handle('save-event-config', async (_, data) => {
  saveConfig({
    eventName:   data.eventName   || '',
    eventPrefix: data.eventPrefix || '',
  });

  // Try connecting if not connected
  if (!dbConnected) {
    try { await connectMongo(); } catch (_) {}
  }

  // Sync to API server → MongoDB event_config collection
  if (dbConnected) {
    try {
      const eventPrefix = (data.eventPrefix || '').toUpperCase().trim();
      const eventName   = (data.eventName   || '').trim();
      if (eventPrefix && eventName) {
        await db.saveEvent(eventName, eventPrefix);
        log('info', `💾 Synced event config via API: "${eventName}" [${eventPrefix}]`);
      }
    } catch (err) {
      log('error', `⚠️ Failed to sync event config: ${err.message}`);
    }
  }

  return { success: true };
});

async function waitForDbConnection(timeoutMs = 5000) {
  if (dbConnected) return true;
  const startTime = Date.now();
  while (!dbConnected && (Date.now() - startTime) < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
  return dbConnected;
}

ipcMain.handle('get-all-events', async () => {
  const isConnected = await waitForDbConnection(5000);
  if (!isConnected) return [];
  try {
    return await db.getAllEvents();
  } catch (err) {
    log('error', `⚠️ Failed to get all events: ${err.message}`);
    return [];
  }
});

ipcMain.handle('get-images', async (_, folderPath) => {
  return await getInitialImages(folderPath);
});

ipcMain.handle('delete-image', async (_, imageId) => {
  try {
    log('info', `🗑️ Deletion requested for image ${imageId}`, imageId);

    // 1. Delete via API
    if (dbConnected) {
      await db.deleteOne(imageId);
      log('info', `💾 Deleted record for ${imageId} via API`, imageId);
    }

    // 2. Delete file locally (move to trash)
    const saved = loadConfig().lastFolder;
    if (saved) {
      const files = fs.readdirSync(saved);
      const matchingFiles = files.filter(f => extractImageId(f) === imageId);
      for (const file of matchingFiles) {
        const filePath = path.join(saved, file);
        if (fs.existsSync(filePath)) {
          await shell.trashItem(filePath);
          log('info', `🗑️ Moved local file to trash: ${filePath}`, imageId);
        }
      }
    }

    // 3. Remove from retry queue
    waitingFiles.delete(imageId);

    return { success: true };
  } catch (err) {
    const msg = err.message || String(err);
    log('error', `❌ Failed to delete image ${imageId}: ${msg}`, imageId);
    return { success: false, error: msg };
  }
});

ipcMain.handle('toggle-hide-image', async (_, imageId, hide) => {
  try {
    if (!dbConnected) return { success: false, error: 'API server not connected' };
    await db.update(imageId, { hide });
    log('info', `👁️ Image ${imageId} hide status set to ${hide}`, imageId);
    return { success: true };
  } catch (err) {
    const msg = err.message || String(err);
    log('error', `❌ Failed to hide image ${imageId}: ${msg}`, imageId);
    return { success: false, error: msg };
  }
});

ipcMain.handle('is-watching', () => watcher !== null);

ipcMain.handle('stop-watch', () => {
  if (watcher) { watcher.close(); watcher = null; }
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  waitingFiles.clear();
  uploadQueue.length = 0;                        // Clear any pending queue items on stop
  log('info', '🛑 Watcher stopped');
  return { success: true };
});


ipcMain.handle('get-db-status', () => ({ connected: dbConnected }));

ipcMain.handle('retry-failed', async () => {
  if (!dbConnected) return { error: 'API server not connected' };
  try {
    const count = await db.retryFailed();
    return { count };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-stats', async () => {
  if (!dbConnected) return {};
  try {
    return await db.stats();
  } catch (err) {
    log('error', `get-stats error: ${err.message}`);
    return {};
  }
});

// ── Frames ────────────────────────────────────────────────────────────────────

ipcMain.handle('upload-frame', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png'] }],
    title: 'Select Frame (PNG with transparency)',
  });
  if (result.canceled || !result.filePaths.length) return null;
  const src = result.filePaths[0];
  const filename = path.basename(src);
  const dest = path.join(getFramesDir(), filename);
  fs.copyFileSync(src, dest);
  
  // Auto-set as active if there is no active frame
  const cfg = loadConfig();
  if (!cfg.activeFrame) {
    saveConfig({ activeFrame: filename });
  }
  
  return filename;
});

ipcMain.handle('get-frames', () => {
  const dir = getFramesDir();
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.png'));
  const cfg = loadConfig();
  return { frames: files, activeFrame: cfg.activeFrame || null, framesDir: dir };
});

ipcMain.handle('set-active-frame', (_, filename) => {
  saveConfig({ activeFrame: filename });
  return { success: true };
});

ipcMain.handle('delete-frame', (_, filename) => {
  const filepath = path.join(getFramesDir(), filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  const cfg = loadConfig();
  if (cfg.activeFrame === filename) {
    saveConfig({ activeFrame: null });
  }
  return { success: true };
});

ipcMain.handle('generate-qr-code', async (_, text) => {
  try {
    const dataUrl = await QRCode.toDataURL(text, { width: 320, margin: 2 });
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Manual send (no registered user) ─────────────────────────────────────────

ipcMain.handle('manual-send', async (_, { phone, imageId }) => {
  try {
    log('info', `📤 Manual send requested for ${imageId} → ${phone}`, imageId);

    if (!dbConnected) {
      throw new Error('API server unavailable — cannot send without the stored image URL');
    }

    const existing = await db.findOne(imageId);
    const imageUrl = existing?.imageUrl;
    if (!imageUrl) {
      throw new Error('No image URL stored for this photo yet');
    }

    // Send WhatsApp with the URL already saved from the first upload
    await sendWhatsApp(phone, imageUrl, null);

    await db.update(imageId, {
      phone,
      status:      'completed',
      completedAt: new Date(),
      code:        getCodeFromImageId(imageId),
    });
    log('info', `💾 Saved manual send record for ${imageId}`, imageId);

    // Remove from retry queue so the loop stops re-checking this file
    waitingFiles.delete(imageId);

    if (mainWindow) {
      mainWindow.webContents.send('image-status', { imageId, status: 'completed', imageUrl });
    }

    log('info', `🎉 Manual send done! ${imageId} → ${phone}`, imageId);
    return { ok: true, imageUrl };
  } catch (err) {
    const msg = err?.message || String(err);
    log('error', `❌ Manual send failed for ${imageId}: ${msg}`, imageId);
    if (mainWindow) {
      mainWindow.webContents.send('image-status', { imageId, status: 'failed', error: msg });
    }
    return { ok: false, error: msg };
  }
});


// ── Window ────────────────────────────────────────────────────────────────────

if (require('electron-squirrel-startup')) { app.quit(); }

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Start health polling (connect + keep-alive every 10s)
  startHealthPoll();
};

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (watcher) watcher.close();
  if (process.platform !== 'darwin') app.quit();
});
