'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const dns = require('node:dns');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Force use of Google DNS to prevent ECONNREFUSED on MongoDB SRV queries
try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
  console.warn('Failed to set DNS servers:', e);
}

// ── Dependencies (loaded after dotenv) ────────────────────────────────────────
const chokidar = require('chokidar');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const sharp = require('sharp');
sharp.cache(false);

// ── Cloudflare R2 client ──────────────────────────────────────────────────────
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.CF_ACCESS_KEY_ID,
    secretAccessKey: process.env.CF_SECRET_ACCESS_KEY,
  },
});

// ── MongoDB Native Driver ─────────────────────────────────────────────────────
let mongoClient;
let usersCollection;
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


// ── MongoDB ───────────────────────────────────────────────────────────────────

async function connectMongo() {
  if (dbConnected) return;
  try {
    mongoClient = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
    });
    await mongoClient.connect();
    const db = mongoClient.db();
    usersCollection = db.collection('photobooth_users');
    
    // Ensure index on imageId
    await usersCollection.createIndex({ imageId: 1 }, { unique: true }).catch(() => {});

    dbConnected = true;
    log('info', '✅ MongoDB connected');
    if (mainWindow) mainWindow.webContents.send('db-status', { connected: true });
  } catch (err) {
    log('error', `❌ MongoDB connection failed: ${err.message}`);
    if (mainWindow) mainWindow.webContents.send('db-status', { connected: false, error: err.message });
  }
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
        messaging_product: 'whatsapp',
        to: normalised,
        type: 'template',
        template: {
          name: 'photo_booth_test',
          language: { code: 'en' },
          components: [
            {
              type: 'header',
              parameters: [
                {
                  type: 'image',
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
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
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

    // 2. Resize photo to full frame size (matches height, crops width)
    await sharp(filePath)
      .rotate() // Auto-orient based on EXIF
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
  if (usersCollection && dbConnected) {
    try {
      const doc = await usersCollection.findOne({ imageId });
      if (doc && doc.status === 'completed') {
        log('info', `⏭️  imageId "${imageId}" already completed — skipping lookup`, imageId);
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
    const thumbBuffer = await sharp(filePath)
      .rotate()
      .resize(140)
      .jpeg({ quality: 80 })
      .toBuffer();
    previewUrl = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
  } catch (_) { /* non-critical */ }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('image-status', { imageId, status: 'detected', filePath, previewUrl });
  }

  try {
    if (!usersCollection) throw new Error('MongoDB not connected');

    let doc = await usersCollection.findOne({ imageId });

    // Link pre-registration: check if user registered using the short code before the photo was uploaded
    if (!doc) {
      const code = getCodeFromImageId(imageId);
      const shortDoc = await usersCollection.findOne({ imageId: code });
      if (shortDoc) {
        log('info', `🔗 Found pre-registered user by code "${code}". Linking to full imageId "${imageId}"...`, imageId);
        await usersCollection.updateOne({ _id: shortDoc._id }, { $set: { imageId } });
        doc = await usersCollection.findOne({ imageId });
      }
    }

    if (doc && doc.status === 'completed') {
      log('info', `⏭️  imageId "${imageId}" already completed — skipping`, imageId);
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

    // 1. Upload if we don't have an imageUrl yet
    let imageUrl = doc?.imageUrl;
    if (!imageUrl) {
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
      
      // Upsert DB with imageUrl and code
      doc = await usersCollection.findOneAndUpdate(
        { imageId },
        { 
          $set: { imageUrl, status: 'uploaded', code: getCodeFromImageId(imageId) },
          $setOnInsert: { createdAt: new Date() }
        },
        { returnDocument: 'after', upsert: true }
      );
      
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

    doc.status = 'completed';
    doc.completedAt = new Date();
    await usersCollection.updateOne(
      { imageId },
      { $set: { status: doc.status, completedAt: doc.completedAt } }
    );

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
    if (usersCollection) {
      await usersCollection.updateOne({ imageId }, { $set: { status: 'failed', errorMsg: full } }).catch(() => {});
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
    if (usersCollection && dbConnected && ids.length > 0) {
      dbRecords = await usersCollection.find({ imageId: { $in: ids } }).toArray();
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
        const thumbBuffer = await sharp(filePath)
          .rotate()
          .resize(140)
          .jpeg({ quality: 80 })
          .toBuffer();
        previewUrl = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
      } catch (_) {}

      let status = 'detected';
      if (doc) {
        status = doc.status || 'detected';
      } else {
        status = 'detected';
      }

      list.push({
        imageId,
        filePath,
        status,
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
  if (waitingFiles.size === 0 || !usersCollection || !dbConnected) return;

  try {
    const waitingIds = Array.from(waitingFiles.keys());

    // Query MongoDB for all waiting IDs in ONE query to see if any now have a phone number
    const claimedDocs = await usersCollection.find({
      imageId: { $in: waitingIds },
      phone: { $exists: true, $ne: null }
    }).toArray();

    if (claimedDocs.length === 0) return;

    log('info', `🔁 Found ${claimedDocs.length} newly claimed image(s). Enqueuing...`);

    // Enqueue only the photos that were actually claimed
    for (const doc of claimedDocs) {
      const filePath = waitingFiles.get(doc.imageId);
      
      if (processingSet.has(doc.imageId)) continue; // skip if already processing

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

  // Populate waitingFiles with existing files that are not completed in MongoDB yet
  try {
    if (fs.existsSync(folderPath)) {
      const files = fs.readdirSync(folderPath);
      const imageFiles = files.filter(f => isImage(path.join(folderPath, f)));
      const ids = imageFiles.map(f => extractImageId(f));

      let dbRecords = [];
      if (usersCollection && dbConnected && ids.length > 0) {
        dbRecords = await usersCollection.find({ imageId: { $in: ids } }).toArray();
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

        // If file isn't completed, add to retry queue
        if (!doc || doc.status !== 'completed') {
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
  await connectMongo();
  await startWatcher(folderPath);
  return { success: true };
});

ipcMain.handle('get-saved-folder', () => {
  const cfg = loadConfig();
  return cfg.lastFolder || null;
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
    eventName: data.eventName || '',
    eventPrefix: data.eventPrefix || '',
  });

  // Try connecting if not connected
  if (!dbConnected) {
    try {
      await connectMongo();
    } catch (_) {}
  }

  // Sync to MongoDB event_config collection
  if (dbConnected && mongoClient) {
    try {
      const db = mongoClient.db();
      const configCol = db.collection('event_config');
      const eventPrefix = (data.eventPrefix || '').toUpperCase().trim();
      const eventName = (data.eventName || '').trim();

      if (eventPrefix && eventName) {
        // 1. Save specific event document keyed by prefix
        await configCol.updateOne(
          { _id: eventPrefix },
          {
            $set: {
              eventName,
              eventPrefix,
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );

        log('info', `💾 Synced event config to MongoDB: "${eventName}" [${eventPrefix}]`);
      }
    } catch (err) {
      log('error', `⚠️ Failed to sync event config to MongoDB: ${err.message}`);
    }
  }

  return { success: true };
});

async function waitForDbConnection(timeoutMs = 5000) {
  if (dbConnected && mongoClient) return true;
  const startTime = Date.now();
  while (!dbConnected && (Date.now() - startTime) < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
  return dbConnected && !!mongoClient;
}

ipcMain.handle('get-all-events', async () => {
  const isConnected = await waitForDbConnection(5000);
  if (!isConnected) return [];
  try {
    const db = mongoClient.db();
    const configCol = db.collection('event_config');
    // Fetch all events except the active_event placeholder doc
    const events = await configCol
      .find({ _id: { $ne: 'active_event' } })
      .sort({ updatedAt: -1 })
      .toArray();

    const seen = new Set();
    const uniqueEvents = [];
    for (const e of events) {
      if (e.eventName && e.eventPrefix) {
        const key = e.eventPrefix.toUpperCase().trim();
        if (!seen.has(key)) {
          seen.add(key);
          uniqueEvents.push({
            eventName: e.eventName.trim(),
            eventPrefix: key,
          });
        }
      }
    }
    return uniqueEvents;
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

    // 1. Delete from MongoDB
    if (usersCollection && dbConnected) {
      await usersCollection.deleteOne({ imageId });
      log('info', `💾 Deleted MongoDB record for ${imageId}`, imageId);
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

    // 3. Remove from retry queue (waitingFiles) in case it was there
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
    if (usersCollection && dbConnected) {
      await usersCollection.updateOne({ imageId }, { $set: { hide: hide } });
      log('info', `👁️ Image ${imageId} hide status set to ${hide}`, imageId);
      return { success: true };
    }
    return { success: false, error: 'Database not connected' };
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
  if (!usersCollection || !dbConnected) return { error: 'MongoDB not connected' };
  const failed = await usersCollection.find({ status: 'failed' }).toArray();
  await usersCollection.updateMany({ status: 'failed' }, { $set: { status: 'pending', errorMsg: null } });
  return { count: failed.length };
});

ipcMain.handle('get-stats', async () => {
  if (!usersCollection || !dbConnected) return {};
  try {
    const [pending, processing, completed, failed] = await Promise.all([
      usersCollection.countDocuments({ status: { $in: ['pending', 'uploaded'] } }),
      usersCollection.countDocuments({ status: 'processing' }),
      usersCollection.countDocuments({ status: 'completed' }),
      usersCollection.countDocuments({ status: 'failed' }),
    ]);
    return { pending, processing, completed, failed };
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

// ── Manual send (no registered user) ─────────────────────────────────────────

ipcMain.handle('manual-send', async (_, { filePath, phone, imageId }) => {
  try {
    log('info', `📤 Manual send requested for ${imageId} → ${phone}`, imageId);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const tempFile = await applyActiveFrame(filePath, imageId);
    if (!tempFile) {
      throw new Error('No active frame selected or failed to apply the frame template.');
    }
    const uploadPath = tempFile;

    // Upload to Cloudflare R2
    const imageUrl = await uploadToCloudflare(uploadPath, `manual_${imageId}`);
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

    if (mainWindow) {
      mainWindow.webContents.send('image-status', { imageId, status: 'uploaded', imageUrl });
    }

    // Send WhatsApp
    await sendWhatsApp(phone, imageUrl, null);

    // Save / update MongoDB record so the send is tracked
    if (usersCollection && dbConnected) {
      await usersCollection.findOneAndUpdate(
        { imageId },
        {
          $set: {
            phone,
            imageUrl,
            status:      'completed',
            completedAt: new Date(),
            code:        getCodeFromImageId(imageId),
          },
          $setOnInsert: { imageId, createdAt: new Date() },
        },
        { upsert: true, returnDocument: 'after' }
      );
      log('info', `💾 Saved manual send record for ${imageId}`, imageId);
    } else {
      log('warn', `⚠️  MongoDB unavailable — record not saved for ${imageId}`, imageId);
    }

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

  // Connect to DB on start
  connectMongo();
};

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (watcher) watcher.close();
  if (mongoClient) await mongoClient.close();
  if (process.platform !== 'darwin') app.quit();
});
