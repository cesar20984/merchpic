import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { neon } from '@neondatabase/serverless';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

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

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'missing-key' });
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|webp)$/i.test(file.mimetype));
  }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let initPromise;

function ensureDatabase() {
  if (!sql) {
    if (isProduction) throw new Error('Falta DATABASE_URL para conectar Neon.');
    throw new Error('Falta DATABASE_URL. Crea una base Neon y agrega DATABASE_URL en .env.');
  }

  initPromise ||= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS projects (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        thumbnail_photo_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS source_photos (
        id BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        original_name TEXT,
        mime_type TEXT NOT NULL,
        image_data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS generated_images (
        id BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        size TEXT NOT NULL,
        model TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'image/png',
        image_data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;

    for (const [key, value] of Object.entries(defaultSettings)) {
      await sql`
        INSERT INTO settings (key, value)
        VALUES (${key}, ${value})
        ON CONFLICT (key) DO NOTHING
      `;
    }
  })();

  return initPromise;
}

function asNumber(value) {
  return Number(value);
}

function projectDto(project) {
  const id = asNumber(project.id);
  const thumbnailId = project.thumbnail_photo_id ? asNumber(project.thumbnail_photo_id) : null;
  return {
    id,
    name: project.name,
    created_at: project.created_at,
    updated_at: project.updated_at,
    thumbnail_photo_id: thumbnailId,
    thumbnailUrl: thumbnailId ? `/api/photos/${thumbnailId}` : null
  };
}

async function settingsObject() {
  await ensureDatabase();
  const rows = await sql`SELECT key, value FROM settings ORDER BY key`;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function photoDto(photo) {
  return {
    id: asNumber(photo.id),
    project_id: asNumber(photo.project_id),
    original_name: photo.original_name,
    mime_type: photo.mime_type,
    created_at: photo.created_at,
    url: `/api/photos/${photo.id}`
  };
}

function imageDto(image) {
  return {
    id: asNumber(image.id),
    project_id: asNumber(image.project_id),
    title: image.title,
    prompt: image.prompt,
    size: image.size,
    model: image.model,
    mime_type: image.mime_type,
    created_at: image.created_at,
    url: `/api/images/${image.id}`,
    downloadUrl: `/api/images/${image.id}/download`
  };
}

app.get('/api/health', async (_req, res) => {
  try {
    if (sql) await ensureDatabase();
    res.json({
      ok: true,
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      databaseConfigured: Boolean(sql)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/settings', async (_req, res) => {
  res.json(await settingsObject());
});

app.put('/api/settings', async (req, res) => {
  await ensureDatabase();
  for (const key of Object.keys(defaultSettings)) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
      await sql`
        INSERT INTO settings (key, value)
        VALUES (${key}, ${String(req.body[key] ?? '')})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `;
    }
  }
  res.json(await settingsObject());
});

app.get('/api/models', async (_req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Falta OPENAI_API_KEY en variables de entorno.' });
  }
  const list = await client.models.list();
  const ids = list.data.map((model) => model.id).sort();
  const imageModels = ids.filter((id) => /image|dall-e/i.test(id));
  const textModels = ids.filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !/image|audio|tts|transcribe|realtime|search/i.test(id));
  res.json({ textModels, imageModels, allModels: ids });
});

app.get('/api/projects', async (_req, res) => {
  await ensureDatabase();
  const projects = await sql`SELECT * FROM projects ORDER BY updated_at DESC`;
  res.json(projects.map(projectDto));
});

app.post('/api/projects', async (req, res) => {
  await ensureDatabase();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'El nombre del proyecto es obligatorio.' });
  const [project] = await sql`
    INSERT INTO projects (name)
    VALUES (${name})
    RETURNING *
  `;
  res.status(201).json(projectDto(project));
});

app.get('/api/projects/:id', async (req, res) => {
  await ensureDatabase();
  const [project] = await sql`SELECT * FROM projects WHERE id = ${req.params.id}`;
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const photos = await sql`
    SELECT id, project_id, original_name, mime_type, created_at
    FROM source_photos
    WHERE project_id = ${req.params.id}
    ORDER BY created_at DESC
  `;
  const images = await sql`
    SELECT id, project_id, title, prompt, size, model, mime_type, created_at
    FROM generated_images
    WHERE project_id = ${req.params.id}
    ORDER BY created_at DESC
  `;

  res.json({
    project: projectDto(project),
    photos: photos.map(photoDto),
    images: images.map(imageDto)
  });
});

app.post('/api/projects/:id/photos', upload.array('photos', 12), async (req, res) => {
  await ensureDatabase();
  const [project] = await sql`SELECT * FROM projects WHERE id = ${req.params.id}`;
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const files = req.files || [];
  let firstPhotoId = null;

  for (const file of files) {
    const hex = file.buffer.toString('hex');
    const [photo] = await sql`
      INSERT INTO source_photos (project_id, original_name, mime_type, image_data)
      VALUES (${req.params.id}, ${file.originalname}, ${file.mimetype}, decode(${hex}, 'hex'))
      RETURNING id
    `;
    firstPhotoId ||= photo.id;
  }

  if (!project.thumbnail_photo_id && firstPhotoId) {
    await sql`
      UPDATE projects
      SET thumbnail_photo_id = ${firstPhotoId}, updated_at = now()
      WHERE id = ${req.params.id}
    `;
  } else {
    await sql`UPDATE projects SET updated_at = now() WHERE id = ${req.params.id}`;
  }

  res.status(201).json({ uploaded: files.length });
});

app.get('/api/photos/:id', async (req, res) => {
  await ensureDatabase();
  const [photo] = await sql`
    SELECT original_name, mime_type, encode(image_data, 'base64') AS image_base64
    FROM source_photos
    WHERE id = ${req.params.id}
  `;
  if (!photo) return res.status(404).json({ error: 'Foto no encontrada.' });
  res.setHeader('Content-Type', photo.mime_type);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(photo.image_base64, 'base64'));
});

app.get('/api/images/:id', async (req, res) => {
  await ensureDatabase();
  const [image] = await sql`
    SELECT mime_type, encode(image_data, 'base64') AS image_base64
    FROM generated_images
    WHERE id = ${req.params.id}
  `;
  if (!image) return res.status(404).json({ error: 'Imagen no encontrada.' });
  res.setHeader('Content-Type', image.mime_type);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(image.image_base64, 'base64'));
});

app.get('/api/images/:id/download', async (req, res) => {
  await ensureDatabase();
  const [image] = await sql`
    SELECT title, mime_type, encode(image_data, 'base64') AS image_base64
    FROM generated_images
    WHERE id = ${req.params.id}
  `;
  if (!image) return res.status(404).json({ error: 'Imagen no encontrada.' });
  const filename = `${image.title.replace(/[^\w.-]+/g, '-') || 'imagen-producto'}.png`;
  res.setHeader('Content-Type', image.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(image.image_base64, 'base64'));
});

app.post('/api/projects/:id/generate', async (req, res) => {
  await ensureDatabase();
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Falta OPENAI_API_KEY en variables de entorno.' });
  }

  const [project] = await sql`SELECT * FROM projects WHERE id = ${req.params.id}`;
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const photos = await sql`
    SELECT id, mime_type, encode(image_data, 'base64') AS image_base64
    FROM source_photos
    WHERE project_id = ${req.params.id}
    ORDER BY created_at ASC
    LIMIT 8
  `;
  if (!photos.length) return res.status(400).json({ error: 'Sube al menos una foto del producto antes de generar.' });

  const settings = await settingsObject();
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

    const [image] = await sql`
      INSERT INTO generated_images (project_id, title, prompt, size, model, mime_type, image_data)
      VALUES (
        ${req.params.id},
        ${item.title || 'Imagen generada'},
        ${prompt},
        ${requestedSize},
        ${imageModel},
        ${'image/png'},
        decode(${Buffer.from(b64, 'base64').toString('hex')}, 'hex')
      )
      RETURNING id, project_id, title, prompt, size, model, mime_type, created_at
    `;

    generated.push(imageDto(image));
  }

  await sql`UPDATE projects SET updated_at = now() WHERE id = ${req.params.id}`;
  res.json({ productSummary: promptPlan.product_summary, generated, prompts: selectedPrompts });
});

function normalizeImageSize(model, requestedSize) {
  if (requestedSize === 'auto') return 'auto';
  if (/dall-e-2/i.test(model)) return '1024x1024';
  return ['1024x1024', '1536x1024', '1024x1536'].includes(requestedSize) ? requestedSize : '1024x1024';
}

async function buildPromptPlan({ photos, textModel, promptTemplate, count }) {
  const imageInputs = photos.map((photo) => ({
    type: 'input_image',
    image_url: `data:${photo.mime_type || 'image/jpeg'};base64,${photo.image_base64}`
  }));

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

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`App lista en http://localhost:${PORT}`);
  });
}

export default app;
