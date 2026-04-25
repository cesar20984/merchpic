import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const GENERATED_DIR = path.join(__dirname, 'generated');
const DB_PATH = path.join(DATA_DIR, 'app.json');

for (const dir of [DATA_DIR, UPLOAD_DIR, GENERATED_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const defaultSettings = {
  textModel: 'gpt-4.1-mini',
  imageModel: 'gpt-image-1',
  imageSize: '1024x1024',
  imageQuality: 'medium',
  promptCount: '8',
  textPrompt: `Analiza las fotos del producto y crea prompts profesionales para generar fotografias comerciales.
Devuelve SOLO JSON valido con esta forma:
{"product_summary":"descripcion corta","prompts":[{"title":"Fondo blanco","prompt":"..." }]}
Los prompts deben mantener el mismo producto y variar: varios angulos, interior o detalles si aplica, producto puesto o en uso, fondo blanco, referencias de tamano, lifestyle, empaque, macro detalle y comparativa de escala.`,
  imagePromptSuffix: `Fotografia comercial realista de producto, alta nitidez, iluminacion profesional, materiales fieles, sin texto inventado, sin logos falsos, sin deformar el producto.`
};

function emptyDb() {
  return {
    counters: { projects: 1, sourcePhotos: 1, generatedImages: 1 },
    settings: { ...defaultSettings },
    projects: [],
    sourcePhotos: [],
    generatedImages: []
  };
}

function readDb() {
  if (!fs.existsSync(DB_PATH)) return emptyDb();
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  return {
    ...emptyDb(),
    ...data,
    counters: { ...emptyDb().counters, ...(data.counters || {}) },
    settings: { ...defaultSettings, ...(data.settings || {}) }
  };
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function now() {
  return new Date().toISOString();
}

function nextId(db, key) {
  const id = db.counters[key] || 1;
  db.counters[key] = id + 1;
  return id;
}

function publicUrl(kind, filename) {
  return `/${kind}/${encodeURIComponent(filename)}`;
}

function projectDto(project) {
  return {
    ...project,
    thumbnailUrl: project.thumbnail_path ? publicUrl('uploads', project.thumbnail_path) : null
  };
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'missing-key' });
const app = express();
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.-]+/g, '-');
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}-${safe}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|webp)$/i.test(file.mimetype));
  }
});

if (!fs.existsSync(DB_PATH)) writeDb(emptyDb());

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/generated', express.static(GENERATED_DIR, {
  setHeaders(res) {
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, openaiConfigured: Boolean(process.env.OPENAI_API_KEY) });
});

app.get('/api/settings', (_req, res) => {
  res.json(readDb().settings);
});

app.put('/api/settings', (req, res) => {
  const db = readDb();
  for (const key of Object.keys(defaultSettings)) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
      db.settings[key] = String(req.body[key] ?? '');
    }
  }
  writeDb(db);
  res.json(db.settings);
});

app.get('/api/models', async (_req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Falta OPENAI_API_KEY en .env' });
  }
  const list = await client.models.list();
  const ids = list.data.map((model) => model.id).sort();
  const imageModels = ids.filter((id) => /image|dall-e/i.test(id));
  const textModels = ids.filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !/image|audio|tts|transcribe|realtime|search/i.test(id));
  res.json({ textModels, imageModels, allModels: ids });
});

app.get('/api/projects', (_req, res) => {
  const db = readDb();
  const projects = [...db.projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  res.json(projects.map(projectDto));
});

app.post('/api/projects', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'El nombre del proyecto es obligatorio.' });
  const db = readDb();
  const project = {
    id: nextId(db, 'projects'),
    name,
    thumbnail_path: null,
    created_at: now(),
    updated_at: now()
  };
  db.projects.push(project);
  writeDb(db);
  res.status(201).json(projectDto(project));
});

app.get('/api/projects/:id', (req, res) => {
  const db = readDb();
  const project = db.projects.find((item) => item.id === Number(req.params.id));
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado.' });
  const photos = db.sourcePhotos
    .filter((photo) => photo.project_id === project.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((photo) => ({ ...photo, url: publicUrl('uploads', photo.filename) }));
  const images = db.generatedImages
    .filter((image) => image.project_id === project.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((image) => ({ ...image, url: publicUrl('generated', image.filename), downloadUrl: `/api/images/${image.id}/download` }));
  res.json({ project: projectDto(project), photos, images });
});

app.post('/api/projects/:id/photos', upload.array('photos', 20), (req, res) => {
  const db = readDb();
  const project = db.projects.find((item) => item.id === Number(req.params.id));
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado.' });
  const files = req.files || [];
  for (const file of files) {
    db.sourcePhotos.push({
      id: nextId(db, 'sourcePhotos'),
      project_id: project.id,
      filename: file.filename,
      original_name: file.originalname,
      mime_type: file.mimetype,
      created_at: now()
    });
  }
  if (!project.thumbnail_path && files[0]) project.thumbnail_path = files[0].filename;
  project.updated_at = now();
  writeDb(db);
  res.status(201).json({ uploaded: files.length });
});

app.get('/api/images/:id/download', (req, res) => {
  const db = readDb();
  const image = db.generatedImages.find((item) => item.id === Number(req.params.id));
  if (!image) return res.status(404).json({ error: 'Imagen no encontrada.' });
  res.download(path.join(GENERATED_DIR, image.filename), image.filename);
});

app.post('/api/projects/:id/generate', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Falta OPENAI_API_KEY en .env' });
  }

  const db = readDb();
  const project = db.projects.find((item) => item.id === Number(req.params.id));
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const photos = db.sourcePhotos.filter((photo) => photo.project_id === project.id).slice(0, 8);
  if (!photos.length) return res.status(400).json({ error: 'Sube al menos una foto del producto antes de generar.' });

  const settings = db.settings;
  const textModel = String(req.body?.textModel || settings.textModel);
  const imageModel = String(req.body?.imageModel || settings.imageModel);
  const requestedSize = String(req.body?.imageSize || settings.imageSize);
  const apiSize = normalizeImageSize(imageModel, requestedSize);
  const count = Math.max(1, Math.min(12, Number(req.body?.count || settings.promptCount || 8)));
  const quality = String(req.body?.imageQuality || settings.imageQuality || 'medium');
  const suffix = String(settings.imagePromptSuffix || '');

  const promptPlan = await buildPromptPlan({ photos, textModel, promptTemplate: settings.textPrompt, count });
  const selectedPrompts = promptPlan.prompts.slice(0, count);
  const generated = [];

  for (const item of selectedPrompts) {
    const prompt = `${item.prompt}\n\n${suffix}`.trim();
    const response = await client.images.generate({
      model: imageModel,
      prompt,
      size: apiSize,
      quality,
      n: 1
    });

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI no devolvio datos de imagen.');

    const filename = `${project.id}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
    await fs.promises.writeFile(path.join(GENERATED_DIR, filename), Buffer.from(b64, 'base64'));

    const image = {
      id: nextId(db, 'generatedImages'),
      project_id: project.id,
      filename,
      title: item.title || 'Imagen generada',
      prompt,
      size: requestedSize,
      model: imageModel,
      created_at: now()
    };
    db.generatedImages.push(image);
    generated.push({ ...image, url: publicUrl('generated', filename), downloadUrl: `/api/images/${image.id}/download` });
  }

  project.updated_at = now();
  writeDb(db);
  res.json({ productSummary: promptPlan.product_summary, generated, prompts: selectedPrompts });
});

function normalizeImageSize(model, requestedSize) {
  if (requestedSize === 'auto') return 'auto';
  if (/dall-e-2/i.test(model)) {
    return requestedSize === '1024x1024' ? requestedSize : '1024x1024';
  }
  return ['1024x1024', '1536x1024', '1024x1536'].includes(requestedSize) ? requestedSize : '1024x1024';
}

async function buildPromptPlan({ photos, textModel, promptTemplate, count }) {
  const imageInputs = photos.map((photo) => {
    const fullPath = path.join(UPLOAD_DIR, photo.filename);
    const data = fs.readFileSync(fullPath).toString('base64');
    return {
      type: 'input_image',
      image_url: `data:${photo.mime_type || 'image/jpeg'};base64,${data}`
    };
  });

  const response = await client.responses.create({
    model: textModel,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: `${promptTemplate}\n\nCrea exactamente ${count} prompts.` },
        ...imageInputs
      ]
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'product_image_prompt_plan',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['product_summary', 'prompts'],
          properties: {
            product_summary: { type: 'string' },
            prompts: {
              type: 'array',
              minItems: 1,
              maxItems: 12,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'prompt'],
                properties: {
                  title: { type: 'string' },
                  prompt: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  });

  const parsed = JSON.parse(response.output_text || '{}');
  return {
    product_summary: parsed.product_summary || '',
    prompts: Array.isArray(parsed.prompts) ? parsed.prompts : []
  };
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Error interno.' });
});

app.listen(PORT, () => {
  console.log(`App lista en http://localhost:${PORT}`);
});
