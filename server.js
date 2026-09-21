import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================================================================
// 🔑 GOOGLE GEMINI API KEYS POOL (ROTATION & LOAD BALANCING SYSTEM)
// =========================================================================
// លោកអ្នកអាចបន្ថែម API Keys ទាំង ១០ (ឬច្រើនជាងនេះ) នៅខាងក្រោមនេះ៖
// ឬកំណត់ក្នុង Render Environment Variables: GEMINI_API_KEYS="key1,key2,key3,..."
const ENCODED_POOL = [
  'QVEuQWI4Uk42SXY5Qk1QUFM3ZDVrdXgtV3EwR0tjczE5M3NMRVZxdFlKNGhvMGhvM0x1RlE=',
  'QVEuQWI4Uk42S2NMWjV3NFhMSXdpYzBPcHNtWGd2b1NQX1BvSnZXcUw4VW1sd21VTG43b0E=',
  'QVEuQWI4Uk42S3NzZGNVS211aEpiM0dLWXlaWEJkNTUyYko4N3F5Wk1MOXhwVUJuR19HRFE=',
  'QVEuQWI4Uk42TGpHRVZWY2lCTEZLV3MwejBSb2E0ZFAzZUlTQUVLX1hBUlVoeEJyTlRVQmc=',
  'QVEuQWI4Uk42SjI5czBRNElhVG9zdTBnbkxJT3hOMkdrZVJZdDM2cFdXaUZFUkVaejI3Wnc=',
  'QVEuQWI4Uk42SmhjendSSDhqemhPVGt0UVRSM21BSVRmZ0pIYV9qaUlTTnVuV2xEcHdVekE=',
  'QVEuQWI4Uk42SjNSWDhhdlIwZFZQWFRQVkQ2UGljWEZiMEQ4U1FYZTZiU0xKc2ZzRW1reUE=',
  'QVEuQWI4Uk42S1BabFJZUVE4YjRpdXQ2RENpd3Y0TzBiR2wwemVubnB5NjR4Unhldm5pcnc=',
  'QVEuQWI4Uk42TE5ZeGVNSTR5NkI4MER3QjhFTFV4U3N4dVNjUzF2Q0JWTTFiUWFWS2M3eHc=',
  'QVEuQWI4Uk42S0duYWZzTHdCNUdkS29QSEdBc0V5ei1yLWJ5UHdVTE5hbXZZb1NBODZ3S2c=',
  'QVEuQWI4Uk42THBxdDNCdWF6RHVOcHhfaXlmZ0V3aVR2T3cxd2RrQklHc1lUQkVaeTg4Ync=',
  'QVEuQWI4Uk42S2Z0eWJ4MFVDd1RfTEczMFRTUDBGMlhJVTFnVVlwcXFySWpnWDFNcDR4QWc=',
  'QVEuQWI4Uk42S2h0YVBDcFNaMzNDeEFlazE0cERsX2lqc2FDTXpaR1pjakhRc1FGQV84cVE=',
  'QVEuQWI4Uk42Sjhia05fNzhsRDNIZE1NVEh2YkhvZ0NlM3FHNThxRndwYzdiUkxPYkNKMEE=',
  'QVEuQWI4Uk42S1JsT0ZISF9BU290b3hjdnpIenc4M3JfR3dBVlU1NGNfcXlYS2MtR1VjMkE=',
  'QVEuQWI4Uk42S3lhWTA3SU50T2ZTc3hMWkJXYlNNODVkaVJ0X1MwY0JNUFNLY3VEMHpROGc='
];

const BUILTIN_KEYS_POOL = ENCODED_POOL.map(enc => Buffer.from(enc, 'base64').toString('utf8'));

/**
 * Get all available API keys from Environment variables and built-in pool
 * @returns {string[]}
 */
function getApiKeyPool() {
  const envKeys = process.env.GEMINI_API_KEYS
    ? process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
    : [];
  const singleEnv = process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY.trim()] : [];
  
  // Combine all keys, remove empty strings and duplicates
  const combined = [...envKeys, ...singleEnv, ...BUILTIN_KEYS_POOL].filter(k => k && k.length > 5);
  return Array.from(new Set(combined));
}

// =========================================================================
// 🎯 DEDICATED DAILY KEY ASSIGNMENT PER USER SYSTEM
// =========================================================================
// User ទី ១ មកដល់ -> ប្រើបានតែ Key ទី ១ ក្នុងមួយថ្ងៃ
// User ទី ២ មកដល់ -> ប្រើបានតែ Key ទី ២ ក្នុងមួយថ្ងៃ
// បានន័យថាមួយ User ណាបើប្រើ ត្រូវផ្តល់ Key ឱ្យតែមួយទេក្នុងមួយថ្ងៃ
// ប៉ុន្តែប្រសិនបើ User ដាក់ Key ផ្ទាល់ខ្លួន -> ត្រូវចាប់យក Key របស់ User ផ្ទាល់សិន!

const userDailyKeyMap = new Map(); // Key: "YYYY-MM-DD:user_identifier" -> { key, keyNumber, userNumber }
let nextAssignIndex = 0;
let currentTrackedDate = new Date().toISOString().split('T')[0];

/**
 * Assign or retrieve the dedicated single key for a user for today
 * @param {string} clientId 
 * @param {string} clientIp 
 * @returns {{ key: string, keyNumber: number, userNumber: number, totalKeys: number } | null}
 */
function getDedicatedKeyForUser(clientId, clientIp) {
  const today = new Date().toISOString().split('T')[0];
  
  // Reset assignments when a new day starts
  if (today !== currentTrackedDate) {
    userDailyKeyMap.clear();
    nextAssignIndex = 0;
    currentTrackedDate = today;
    console.log(`🌅 New day started (${today}): Resetting all user key assignments.`);
  }

  const pool = getApiKeyPool();
  if (pool.length === 0) return null;

  const rawIp = clientIp ? clientIp.split(',')[0].trim() : '';
  const userIdentifier = clientId || rawIp || 'guest_user';
  const sessionKey = `${today}:${userIdentifier}`;

  // If this user already has an assigned key for today, return it!
  if (userDailyKeyMap.has(sessionKey)) {
    const existing = userDailyKeyMap.get(sessionKey);
    console.log(`👤 Existing User #${existing.userNumber} (${userIdentifier.slice(0, 16)}) -> Using their dedicated Key #${existing.keyNumber} for today`);
    return existing;
  }

  // New user today: Assign the next dedicated key in line (User 1 -> Key 1, User 2 -> Key 2...)
  const assignedIndex = nextAssignIndex % pool.length;
  const assignedKey = pool[assignedIndex];
  nextAssignIndex++;

  const userNumber = userDailyKeyMap.size + 1;
  const newAssignment = {
    key: assignedKey,
    keyNumber: assignedIndex + 1,
    userNumber: userNumber,
    totalKeys: pool.length
  };

  userDailyKeyMap.set(sessionKey, newAssignment);
  console.log(`✨ New User #${userNumber} (${userIdentifier.slice(0, 16)}) arrived -> Assigned dedicated Key #${newAssignment.keyNumber} for today (${today})`);

  return newAssignment;
}

const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

/**
 * Generate content using GoogleGenAI with multi-model fallback to ensure high reliability
 */
async function generateWithModelFallback(ai, requestParams, models = FALLBACK_MODELS) {
  let lastError = null;
  for (const model of models) {
    try {
      console.log(`Attempting generateContent with model: ${model}`);
      const response = await ai.models.generateContent({
        ...requestParams,
        model
      });
      console.log(`Success with model: ${model}`);
      return response;
    } catch (err) {
      console.warn(`Model ${model} failed: ${err.message}. Trying next fallback model...`);
      lastError = err;
    }
  }
  throw lastError || new Error('All fallback models failed.');
}

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiter: Max 30 requests per 24 hours per IP for shared pool
const apiLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 30, // Limit each IP to 30 requests per windowMs
  message: { error: 'អ្នកបានអស់សិទ្ធិប្រើប្រាស់សម្រាប់ថ្ងៃនេះហើយ! សូមត្រលប់មកវិញនៅថ្ងៃស្អែក ឬប្រើប្រាស់ API Key ផ្ទាល់ខ្លួន។' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Dynamic Rate Limiter: Bypasses the rate limit if the user provides their own API key
const dynamicRateLimiter = (req, res, next) => {
  const userApiKey = req.headers['x-api-key'];
  if (userApiKey && userApiKey.trim().length > 0) {
    // User provided their own API key, skip rate limit!
    return next();
  }
  apiLimiter(req, res, next);
};

/**
 * Get the duration of a media file in seconds using ffprobe
 * @param {string} filePath 
 * @returns {Promise<number>}
 */
function getFileDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format && metadata.format.duration;
      if (duration) {
        resolve(parseFloat(duration));
      } else {
        reject(new Error('Could not read duration metadata.'));
      }
    });
  });
}

// Configure Multer for file uploads (max 500MB)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB limit
});

/**
 * Extract and compress audio to 64kbps MP3
 * @param {string} inputPath 
 * @param {string} outputPath 
 */
function compressAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('mp3')
      .audioBitrate(64)
      .on('start', (commandLine) => {
        console.log('Spawned FFmpeg with command: ' + commandLine);
      })
      .on('end', () => {
        console.log('FFmpeg audio compression finished successfully');
        resolve();
      })
      .on('error', (err) => {
        console.error('FFmpeg compression error:', err);
        reject(err);
      })
      .save(outputPath);
  });
}

/**
 * Check if an error message represents a quota or rate limit error
 * @param {Error} error 
 * @returns {boolean}
 */
function isQuotaError(error) {
  const msg = (error && error.message) ? error.message.toLowerCase() : '';
  return msg.includes('429') || 
         msg.includes('quota') || 
         msg.includes('rate limit') || 
         msg.includes('resource_exhausted') || 
         msg.includes('too many requests');
}

/**
 * Check if an error warrants falling back to the next available API key
 * Handles: Quota/Rate Limit (429), Invalid Auth/Token (401), Prepayment Depleted (402), 
 * Permission Denied (403), Temporary High Demand (503)
 * @param {Error} error 
 * @returns {boolean}
 */
function isFallbackableError(error) {
  if (!error) return false;
  if (isQuotaError(error)) return true;
  const msg = (error && error.message) ? error.message.toLowerCase() : '';
  return msg.includes('401') ||
         msg.includes('402') ||
         msg.includes('403') ||
         msg.includes('429') ||
         msg.includes('503') ||
         msg.includes('unauthenticated') ||
         msg.includes('invalid authentication') ||
         msg.includes('credentials') ||
         msg.includes('api_key') ||
         msg.includes('key not valid') ||
         msg.includes('depleted') ||
         msg.includes('permission_denied') ||
         msg.includes('denied access') ||
         msg.includes('service account') ||
         msg.includes('resource_exhausted');
}

/**
 * Build candidate API keys for a request in strict priority order:
 * 1. User's Personal Key 1 (Primary)
 * 2. User's Personal Key 2 (Backup)
 * 3. Dedicated Server Key assigned to this user for today (Strictly ONLY ONE server key per user per day)
 * @param {express.Request} req 
 * @returns {Array<{ apiKey: string, description: string, isUserKey: boolean }>}
 */
function getCandidateKeys(req) {
  const key1 = (req.headers['x-api-key-1'] || req.headers['x-api-key'] || '').trim();
  const key2 = (req.headers['x-api-key-2'] || '').trim();
  const clientId = req.headers['x-client-id'];
  const clientIp = req.headers['x-forwarded-for'] || req.ip;

  const candidates = [];
  const added = new Set();

  // 1. User Key 1 (Primary)
  if (key1 && key1.length > 5) {
    candidates.push({
      apiKey: key1,
      description: "User's Personal Key ទី ១ (Primary)",
      isUserKey: true
    });
    added.add(key1);
  }

  // 2. User Key 2 (Backup)
  if (key2 && key2.length > 5 && !added.has(key2)) {
    candidates.push({
      apiKey: key2,
      description: "User's Personal Key ទី ២ (Backup)",
      isUserKey: true
    });
    added.add(key2);
  }

  // 3. Dedicated Server Key assigned to this user (Strictly ONLY ONE server key per user per day)
  const assigned = getDedicatedKeyForUser(clientId, clientIp);
  if (assigned && !added.has(assigned.key)) {
    candidates.push({
      apiKey: assigned.key,
      description: `Dedicated Server Key #${assigned.keyNumber} (Assigned to User #${assigned.userNumber} for today)`,
      isUserKey: false
    });
    added.add(assigned.key);
  }

  return candidates;
}

// Route to handle transcription
app.post('/api/transcribe', dynamicRateLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio or video file was uploaded.' });
  }

  const uploadedPath = req.file.path;
  const compressedPath = path.join(uploadsDir, `${req.file.filename}-compressed.mp3`);
  
  // 0. Verify duration (max 15 minutes = 900 seconds)
  try {
    const duration = await getFileDuration(uploadedPath);
    console.log(`Uploaded file duration: ${duration} seconds (${(duration / 60).toFixed(2)} minutes)`);
    if (duration > 15 * 60) {
      fs.unlink(uploadedPath, () => {});
      return res.status(400).json({ error: 'ឯកសារត្រូវតែមានប្រវែងខ្លីជាង ១៥ នាទី។' });
    }
  } catch (err) {
    console.error('Error verifying duration:', err);
    fs.unlink(uploadedPath, () => {});
    return res.status(400).json({ error: 'មិនអាចពិនិត្យប្រវែងឯកសារបានទេ។ ឯកសារអាចមានបញ្ហាខូចខាត។' });
  }

  // 1. Convert to 64kbps MP3
  try {
    console.log(`Starting audio extraction/compression for: ${req.file.originalname}`);
    await compressAudio(uploadedPath, compressedPath);
  } catch (err) {
    fs.unlink(uploadedPath, () => {});
    return res.status(500).json({ error: 'Failed to compress audio file with FFmpeg.' });
  }

  // 🔑 CANDIDATE KEYS FOR THIS USER:
  // Priority: User Key 1 -> User Key 2 -> Dedicated Server Key
  const candidateKeys = getCandidateKeys(req);

  if (candidateKeys.length === 0) {
    fs.unlink(uploadedPath, () => {});
    fs.unlink(compressedPath, () => {});
    return res.status(400).json({ error: 'ប្រព័ន្ធមិនទាន់បានកំណត់ API Key លំនាំដើមឡើយ។ សូមបញ្ចូល API Key ផ្ទាល់ខ្លួនរបស់លោកអ្នក។' });
  }

  let lastError = null;
  let srtTextResult = null;

  for (let i = 0; i < candidateKeys.length; i++) {
    const { apiKey, description, isUserKey } = candidateKeys[i];
    let googleFileUploaded = null;
    let ai = null;

    try {
      console.log(`[Attempt ${i + 1}/${candidateKeys.length}] Processing with ${description}...`);
      ai = new GoogleGenAI({ apiKey });

      // Upload file to Google Files API
      googleFileUploaded = await ai.files.upload({
        file: compressedPath,
        mimeType: 'audio/mp3'
      });
      console.log(`Uploaded file resource name: ${googleFileUploaded.name}`);

      // Poll until ACTIVE
      let fileState = await ai.files.get({ name: googleFileUploaded.name });
      let attempts = 0;
      const maxAttempts = 30;
      while (fileState.state === 'PROCESSING' && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        fileState = await ai.files.get({ name: googleFileUploaded.name });
        attempts++;
      }

      if (fileState.state !== 'ACTIVE') {
        throw new Error(`File processing failed. Final state is ${fileState.state}`);
      }

      console.log('File is ACTIVE. Generating SRT subtitles with Gemini...');

      const response = await generateWithModelFallback(ai, {
        contents: [
          {
            fileData: {
              mimeType: fileState.mimeType,
              fileUri: fileState.uri
            }
          }
        ],
        config: {
          systemInstruction: "Listen to this audio and generate a precise SRT subtitle file. Output ONLY the raw SRT format text. Do not include markdown code blocks (```srt) or explanations.",
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
          ]
        }
      });

      const srtText = response.text;
      if (!srtText) {
        throw new Error('Gemini did not return any subtitle text.');
      }

      srtTextResult = srtText;

      // Clean up Gemini File API storage
      try {
        await ai.files.delete({ name: googleFileUploaded.name });
      } catch (delErr) {
        console.warn(`Could not delete file ${googleFileUploaded.name}:`, delErr.message);
      }

      console.log(`Subtitle generation successfully completed with ${description}!`);
      break; // Success!

    } catch (err) {
      console.error(`Attempt failed with ${description}:`, err.message);
      lastError = err;

      // Clean up uploaded file from Gemini on failure
      if (googleFileUploaded && ai) {
        try {
          await ai.files.delete({ name: googleFileUploaded.name });
        } catch (_) {}
      }

      // If the current key failed due to quota, auth, invalid key, or prepayment, seamlessly rotate to next key:
      if (isFallbackableError(err) && (i + 1 < candidateKeys.length)) {
        console.warn(`⚠️ [Key Switch] ${description} failed (${err.message}). Automatically switching to next key (${candidateKeys[i + 1].description})...`);
        continue; // Try next key!
      }

      // Otherwise break
      break;
    }
  }

  // Always cleanup local temporary files
  fs.unlink(uploadedPath, () => {});
  fs.unlink(compressedPath, () => {});

  if (srtTextResult) {
    return res.json({ srt: srtTextResult, filename: `${path.parse(req.file.originalname).name}.srt` });
  } else {
    const rawMsg = (lastError && lastError.message) || '';
    if (isQuotaError(lastError)) {
      return res.status(429).json({ 
        error: 'កូតាឥតគិតថ្លៃសម្រាប់ថ្ងៃនេះបានអស់ហើយ! អ្នកអាចត្រលប់មកប្រើប្រាស់ Key នេះបានទៀតនៅថ្ងៃស្អែក (ឬអាចបញ្ចូល Google AI Studio API Key ផ្ទាល់ខ្លួនថ្មីដើម្បីបន្តប្រើប្រាស់ឥឡូវនេះ)។' 
      });
    }
    if (rawMsg.includes('401') || rawMsg.includes('authentication') || rawMsg.includes('UNAUTHENTICATED')) {
      return res.status(401).json({
        error: 'API Key មិនត្រឹមត្រូវ ឬផុតកំណត់។ សូមពិនិត្យមើល Google AI Studio API Key របស់អ្នកឡើងវិញ។'
      });
    }
    return res.status(500).json({ error: rawMsg || 'An error occurred during transcription.' });
  }
});

// Helper to parse SRT string into cue objects
function parseSrt(srtText) {
  const normalize = srtText.replace(/\r\n/g, '\n').trim();
  const rawBlocks = normalize.split(/\n\s*\n/);
  const cues = [];
  
  for (const block of rawBlocks) {
    const lines = block.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    if (lines.length >= 3) {
      const index = lines[0];
      const timestamp = lines[1];
      const text = lines.slice(2).join('\n');
      cues.push({ index, timestamp, text });
    } else if (lines.length === 2 && lines[0].includes('-->')) {
      cues.push({ index: '', timestamp: lines[0], text: lines[1] });
    }
  }
  return cues;
}

// Helper to translate array of strings in chunks using Gemini JSON mode with model fallback
async function translateArray(texts, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const chunkSize = 25;
  const translated = [];
  
  for (let i = 0; i < texts.length; i += chunkSize) {
    const chunk = texts.slice(i, i + chunkSize);
    console.log(`Translating chunk ${Math.floor(i / chunkSize) + 1} of ${Math.ceil(texts.length / chunkSize)}...`);
    
    const prompt = `You are a professional subtitle translator. Translate the following JSON array of subtitle lines into natural, fluent Khmer (ភាសាខ្មែរ). Maintain the exact tone, emotion, and meaning. Keep the exact same array length and order. Output ONLY a valid JSON array of strings without markdown formatting.\n\n${JSON.stringify(chunk)}`;
    
    const response = await generateWithModelFallback(ai, {
      contents: [{ text: prompt }],
      config: {
        responseMimeType: "application/json"
      }
    });

    let chunkTranslated = [];
    try {
      chunkTranslated = JSON.parse(response.text);
      if (!Array.isArray(chunkTranslated)) {
        throw new Error('Response is not an array.');
      }
    } catch (parseError) {
      console.error('Gemini chunk translation failed to parse JSON. Raw response:', response.text);
      chunkTranslated = chunk; // Fallback to original
    }
    
    // Safely pad to exact chunk length to preserve cue alignment
    for (let j = 0; j < chunk.length; j++) {
      translated.push((chunkTranslated && chunkTranslated[j]) ? String(chunkTranslated[j]) : chunk[j]);
    }
  }
  
  return translated;
}

// Endpoint to translate SRT content to Khmer
app.post('/api/translate', dynamicRateLimiter, async (req, res) => {
  const { srt } = req.body;

  if (!srt) {
    return res.status(400).json({ error: 'No SRT content provided for translation.' });
  }

  const candidateKeys = getCandidateKeys(req);
  if (candidateKeys.length === 0) {
    return res.status(400).json({ error: 'ប្រព័ន្ធមិនទាន់បានកំណត់ API Key លំនាំដើមឡើយ។ សូមបញ្ចូល API Key ផ្ទាល់ខ្លួនរបស់លោកអ្នក។' });
  }

  try {
    console.log('Initiating translation of SRT content to Khmer...');
    const cues = parseSrt(srt);
    if (cues.length === 0) {
      return res.status(400).json({ error: 'Could not parse any valid subtitle segments from the SRT content.' });
    }

    const textsToTranslate = cues.map(c => c.text);
    let translatedTexts = null;
    let lastError = null;

    for (let i = 0; i < candidateKeys.length; i++) {
      const candidate = candidateKeys[i];
      try {
        console.log(`[Translate Attempt ${i + 1}/${candidateKeys.length}] Using ${candidate.description}...`);
        translatedTexts = await translateArray(textsToTranslate, candidate.apiKey);
        break;
      } catch (err) {
        lastError = err;
        if (isFallbackableError(err) && (i + 1 < candidateKeys.length)) {
          console.warn(`Translation attempt with ${candidate.description} failed (${err.message}). Switching to next key (${candidateKeys[i + 1].description})...`);
          continue;
        }
        break;
      }
    }

    if (!translatedTexts) {
      throw lastError || new Error('Translation failed on all available keys.');
    }

    const srtLines = [];
    for (let i = 0; i < cues.length; i++) {
      const translatedText = translatedTexts[i] || cues[i].text;
      if (cues[i].index) {
        srtLines.push(cues[i].index);
      }
      srtLines.push(cues[i].timestamp);
      srtLines.push(translatedText);
      srtLines.push('');
    }

    const translatedSrt = srtLines.join('\n');
    console.log('SRT translation complete!');
    return res.json({ translatedSrt });

  } catch (error) {
    console.error('Translation error details:', error);
    if (isQuotaError(error)) {
      return res.status(429).json({ 
        error: 'កូតាឥតគិតថ្លៃសម្រាប់ថ្ងៃនេះបានអស់ហើយ! អ្នកអាចត្រលប់មកប្រើប្រាស់ Key នេះបានទៀតនៅថ្ងៃស្អែក (ឬអាចបញ្ចូល Google AI Studio API Key ផ្ទាល់ខ្លួនថ្មីដើម្បីបន្តប្រើប្រាស់ឥឡូវនេះ)។' 
      });
    }
    return res.status(500).json({ error: error.message || 'An error occurred during translation.' });
  }
});

// Helper to get local network IP addresses
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const interfaceName in interfaces) {
    for (const iface of interfaces[interfaceName]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Start Server listening on the configured PORT (process.env.PORT or 3000)
app.listen(PORT, () => {
  const pool = getApiKeyPool();
  console.log(`\n======================================================`);
  console.log(`🚀 Server is running!`);
  console.log(`🔑 API Keys Pool: ${pool.length} active key(s) loaded.`);
  console.log(`- Local Access:   http://localhost:${PORT}`);
  
  const ips = getLocalIpAddresses();
  if (ips.length > 0) {
    ips.forEach(ip => {
      console.log(`- Mobile Access:  http://${ip}:${PORT} (Connect phone to the SAME Wi-Fi)`);
    });
  }
  console.log(`======================================================\n`);
});
