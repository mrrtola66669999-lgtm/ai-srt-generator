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

// Rate Limiter: Max 10 requests per 24 hours per IP
const apiLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10, // Limit each IP to 10 requests per windowMs
  message: { error: 'អ្នកបានអស់សិទ្ធិប្រើប្រាស់សម្រាប់ថ្ងៃនេះហើយ! សូមត្រលប់មកវិញនៅថ្ងៃស្អែក' },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Dynamic Rate Limiter: Bypasses the rate limit if the user provides their own API key
const dynamicRateLimiter = (req, res, next) => {
  const userApiKey = req.headers['x-api-key'];
  if (userApiKey && userApiKey.trim().length > 0) {
    // User provided their own API key, skip rate limit!
    return next();
  }
  // No user API key, apply the 5-requests-per-day limit!
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

// Route to handle transcription
app.post('/api/transcribe', dynamicRateLimiter, upload.single('file'), async (req, res) => {
  let apiKey = req.headers['x-api-key'];
  
  // If the user did not provide their own API Key, fall back to the Admin's default key
  if (!apiKey || apiKey.trim().length === 0) {
    apiKey = process.env.GEMINI_API_KEY;
  }
  
  if (!apiKey) {
    // If we have an uploaded file, clean it up immediately
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
    return res.status(400).json({ error: 'ប្រព័ន្ធមិនទាន់បានកំណត់ API Key លំនាំដើមឡើយ។ សូមបញ្ចូល API Key ផ្ទាល់ខ្លួនរបស់លោកអ្នក។' });
  }

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
  
  let googleFileUploaded = null;
  let ai = null;

  try {
    console.log(`Starting audio extraction/compression for: ${req.file.originalname}`);
    // 1. Convert to 64kbps MP3
    await compressAudio(uploadedPath, compressedPath);

    // 2. Initialize Gemini API Client
    ai = new GoogleGenAI({ apiKey });

    console.log('Uploading compressed audio to Google Gen AI Files API...');
    // 3. Upload file to Google Files API
    googleFileUploaded = await ai.files.upload({
      file: compressedPath,
      mimeType: 'audio/mp3'
    });
    console.log(`Uploaded file resource name: ${googleFileUploaded.name}`);

    // 4. Poll until the file becomes ACTIVE
    let fileState = await ai.files.get({ name: googleFileUploaded.name });
    console.log(`Initial file state: ${fileState.state}`);
    
    let attempts = 0;
    const maxAttempts = 30; // 60 seconds max wait time
    while (fileState.state === 'PROCESSING' && attempts < maxAttempts) {
      console.log(`File is still processing... attempt ${attempts + 1}/${maxAttempts}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      fileState = await ai.files.get({ name: googleFileUploaded.name });
      attempts++;
    }

    if (fileState.state !== 'ACTIVE') {
      throw new Error(`File processing failed. Final state is ${fileState.state}`);
    }

    console.log('File is ACTIVE. Generating SRT subtitles using gemini-3.1-flash-lite...');
    
    // 5. Ask Gemini to generate the SRT content
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
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

    console.log('Subtitle generation complete!');
    return res.json({ srt: srtText, filename: `${path.parse(req.file.originalname).name}.srt` });

  } catch (error) {
    console.error('Transcription error details:', error);
    return res.status(500).json({ error: error.message || 'An error occurred during transcription.' });
  } finally {
    // 6. Cleanup local temporary files
    fs.unlink(uploadedPath, (err) => {
      if (err) console.error(`Error deleting uploaded file ${uploadedPath}:`, err);
    });
    fs.unlink(compressedPath, (err) => {
      if (err) console.error(`Error deleting compressed file ${compressedPath}:`, err);
    });

    // 7. Cleanup Gemini File API storage
    if (googleFileUploaded && ai) {
      console.log('Cleaning up files from Gemini API storage...');
      ai.files.delete({ name: googleFileUploaded.name }).then(() => {
        console.log(`Successfully deleted ${googleFileUploaded.name} from Gemini API`);
      }).catch((err) => {
        console.error(`Failed to delete ${googleFileUploaded.name} from Gemini API:`, err);
      });
    }
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
  console.log(`\n======================================================`);
  console.log(`Server is running!`);
  console.log(`- Local Access:   http://localhost:${PORT}`);
  
  const ips = getLocalIpAddresses();
  if (ips.length > 0) {
    ips.forEach(ip => {
      console.log(`- Mobile Access:  http://${ip}:${PORT} (Connect phone to the SAME Wi-Fi)`);
    });
  } else {
    console.log(`- Mobile Access:  Ensure phone is on the same Wi-Fi network.`);
  }
  console.log(`======================================================\n`);
});
