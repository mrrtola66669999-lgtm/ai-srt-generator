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
  'QVEuQWI4Uk42STQwM0x2WGxwX3g4S0F6NW9xVFhLSVRwUzAzbWdWUzdnQnhVM0ZDMVNmbVE=',
  'QVEuQWI4Uk42SUZOTDVaRnlIM0o1LVJzdjliaHdVclQ3dW8wcExmVFUwMEFUSU5XREtSbUE=',
  'QVEuQWI4Uk42S3NzZGNVS211aEpiM0dLWXlaWEJkNTUyYko4N3F5Wk1MOXhwVUJuR19HRFE=',
  'QVEuQWI4Uk42TGpHRVZWY2lCTEZLV3MwejBSb2E0ZFAzZUlTQUVLX1hBUlVoeEJyTlRVQmc=',
  'QVEuQWI4Uk42SjI5czBRNElhVG9zdTBnbkxJT3hOMkdrZVJZdDM2cFdXaUZFUkVaejI3Wnc=',
  'QVEuQWI4Uk42SmhjendSSDhqemhPVGt0UVRSM21BSVRmZ0pIYV9qaUlTTnVuV2xEcHdVekE=',
  'QVEuQWI4Uk42SkFnSVlwLWhlWEpjUjgzSkllNm16aGx0WUxYa2dMVmlJakttejJSOXBJWHc=',
  'QVEuQWI4Uk42SjNSWDhhdlIwZFZQWFRQVkQ2UGljWEZiMEQ4U1FYZTZiU0xKc2ZzRW1reUE=',
  'QVEuQWI4Uk42S1BabFJZUVE4YjRpdXQ2RENpd3Y0TzBiR2wwemVubnB5NjR4Unhldm5pcnc=',
  'QVEuQWI4Uk42TE5ZeGVNSTR5NkI4MER3QjhFTFV4U3N4dVNjUzF2Q0JWTTFiUWFWS2M3eHc=',
  'QVEuQWI4Uk42SkBNOTROdmV1U3lORGRKTk9vVjY4WEVvbGtHZXdDeDdhR1pwaTJENFFpT0E=',
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

let keyRotationIndex = 0;

/**
 * Get next API key using Round-Robin rotation
 * @returns {{ key: string, index: number, total: number } | null}
 */
function getNextPoolKey() {
  const pool = getApiKeyPool();
  if (pool.length === 0) return null;
  const currentIndex = keyRotationIndex % pool.length;
  const key = pool[currentIndex];
  keyRotationIndex = (keyRotationIndex + 1) % pool.length;
  return { key, index: currentIndex + 1, total: pool.length };
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
app.use(express.json());
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

// Route to handle transcription
app.post('/api/transcribe', dynamicRateLimiter, upload.single('file'), async (req, res) => {
  const userApiKey = req.headers['x-api-key'];
  const isCustomUserKey = !!(userApiKey && userApiKey.trim().length > 0);
  
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

  // Determine candidate keys:
  // If user provided their own key, only use that.
  // Otherwise, use keys from the pool with rotation and smart auto-failover!
  const pool = getApiKeyPool();
  let candidateKeys = [];

  if (isCustomUserKey) {
    candidateKeys = [userApiKey.trim()];
  } else {
    if (pool.length === 0) {
      fs.unlink(uploadedPath, () => {});
      fs.unlink(compressedPath, () => {});
      return res.status(400).json({ error: 'ប្រព័ន្ធមិនទាន់បានកំណត់ API Key លំនាំដើមឡើយ។ សូមបញ្ចូល API Key ផ្ទាល់ខ្លួនរបស់លោកអ្នក។' });
    }
    // Pick keys starting from the current rotation index
    const poolKeyObj = getNextPoolKey();
    const startIndex = poolKeyObj ? (poolKeyObj.index - 1) : 0;
    
    // Arrange keys starting from startIndex and wrapping around
    for (let i = 0; i < pool.length; i++) {
      candidateKeys.push(pool[(startIndex + i) % pool.length]);
    }
    console.log(`Using Key Pool: Rotating to Key #${startIndex + 1} of ${pool.length}`);
  }

  let lastError = null;
  let srtTextResult = null;

  // Try candidate keys (auto-failover if quota exceeded)
  for (let keyIdx = 0; keyIdx < candidateKeys.length; keyIdx++) {
    const currentApiKey = candidateKeys[keyIdx];
    let googleFileUploaded = null;
    let ai = null;

    try {
      console.log(`Attempting transcription with ${isCustomUserKey ? 'custom user key' : `Pool Key [${keyIdx + 1}/${candidateKeys.length}]`}`);
      
      ai = new GoogleGenAI({ apiKey: currentApiKey });

      // Upload file to Google Files API
      googleFileUploaded = await ai.files.upload({
        file: compressedPath,
        mimeType: 'audio/mp3'
      });
      console.log(`Uploaded file resource name: ${googleFileUploaded.name}`);

      // Poll until the file becomes ACTIVE
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

      console.log('File is ACTIVE. Generating SRT subtitles with Gemini fallback models...');
      
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

      // Success! Break loop
      break;

    } catch (err) {
      console.error(`Transcription attempt failed with key #${keyIdx + 1}:`, err.message);
      lastError = err;

      // Cleanup uploaded file from Google File API on error
      if (googleFileUploaded && ai) {
        try {
          await ai.files.delete({ name: googleFileUploaded.name });
        } catch (_) {}
      }

      // If it's a quota error and we have more keys in the pool, continue to next key!
      if (!isCustomUserKey && isQuotaError(err) && (keyIdx + 1 < candidateKeys.length)) {
        console.warn(`Key #${keyIdx + 1} hit rate limit / quota! Auto-switching to next Key in pool...`);
        continue;
      }

      // If user's own key or non-quota error, don't loop endlessly
      if (isCustomUserKey) {
        break;
      }
    }
  }

  // Always cleanup local temporary files
  fs.unlink(uploadedPath, () => {});
  fs.unlink(compressedPath, () => {});

  if (srtTextResult) {
    console.log('Subtitle generation successfully completed!');
    return res.json({ srt: srtTextResult, filename: `${path.parse(req.file.originalname).name}.srt` });
  } else {
    return res.status(500).json({ error: (lastError && lastError.message) || 'An error occurred during transcription.' });
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
  const chunkSize = 20;
  const translated = [];
  
  for (let i = 0; i < texts.length; i += chunkSize) {
    const chunk = texts.slice(i, i + chunkSize);
    console.log(`Translating chunk ${Math.floor(i / chunkSize) + 1} of ${Math.ceil(texts.length / chunkSize)}...`);
    
    const prompt = `You are a professional subtitle translator. Translate the following JSON array of subtitle lines into natural Khmer. Keep the exact same array length and order. Output ONLY a valid JSON array of strings without markdown formatting.\n\n${JSON.stringify(chunk)}`;
    
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
    
    translated.push(...chunkTranslated);
  }
  
  return translated;
}

// Endpoint to translate SRT content to Khmer
app.post('/api/translate', dynamicRateLimiter, async (req, res) => {
  const { srt } = req.body;
  let userApiKey = req.headers['x-api-key'];

  if (!srt) {
    return res.status(400).json({ error: 'No SRT content provided for translation.' });
  }

  let activeApiKey = userApiKey;
  if (!activeApiKey || activeApiKey.trim().length === 0) {
    const poolKeyObj = getNextPoolKey();
    activeApiKey = poolKeyObj ? poolKeyObj.key : null;
  }

  if (!activeApiKey) {
    return res.status(400).json({ error: 'ប្រព័ន្ធមិនទាន់បានកំណត់ API Key លំនាំដើមឡើយ។ សូមបញ្ចូល API Key ផ្ទាល់ខ្លួនរបស់លោកអ្នក។' });
  }

  try {
    console.log('Initiating translation of SRT content to Khmer using Gemini fallback models...');
    const cues = parseSrt(srt);
    if (cues.length === 0) {
      return res.status(400).json({ error: 'Could not parse any valid subtitle segments from the SRT content.' });
    }

    const textsToTranslate = cues.map(c => c.text);
    const translatedTexts = await translateArray(textsToTranslate, activeApiKey);

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
