import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';
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

const exactProductInstruction = `Usa las imagenes de entrada como referencia estricta del producto exacto. Conserva su forma, proporciones, materiales, colores, textura, detalles visibles, empaque, marcas o etiquetas reales si existen. No inventes un producto parecido ni cambies el diseno. Solo cambia camara, escena, fondo, iluminacion, uso o contexto segun se pida.`;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'missing-key' });
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|webp)$/i.test(file.mimetype));
  }
});

app.use(express.json({ limit: '2mb' }));
app.get('/favicon.ico', (_req, res) => res.status(204).end());
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
      CREATE TABLE IF NOT EXISTS generation_tasks (
        id BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        openai_response_id TEXT,
        response_status TEXT,
        image_model TEXT,
        image_size TEXT,
        image_quality TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS openai_response_id TEXT`;
    await sql`ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS response_status TEXT`;
    await sql`ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS image_model TEXT`;
    await sql`ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS image_size TEXT`;
    await sql`ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS image_quality TEXT`;
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

function taskDto(task) {
  return {
    id: asNumber(task.id),
    project_id: asNumber(task.project_id),
    title: task.title,
    prompt: task.prompt,
    status: task.status,
    error: task.error,
    openai_response_id: task.openai_response_id,
    response_status: task.response_status,
    image_model: task.image_model,
    image_size: task.image_size,
    image_quality: task.image_quality,
    created_at: task.created_at,
    updated_at: task.updated_at
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
  const imageModels = ids.filter((id) => /gpt-image/i.test(id));
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

app.delete('/api/projects/:id', async (req, res) => {
  await ensureDatabase();
  const deleted = await sql`
    DELETE FROM projects
    WHERE id = ${req.params.id}
    RETURNING id
  `;
  if (!deleted.length) return res.status(404).json({ error: 'Proyecto no encontrado.' });
  res.json({ ok: true });
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
  const tasks = await sql`
    SELECT id, project_id, title, prompt, status, error, openai_response_id, response_status, image_model, image_size, image_quality, created_at, updated_at
    FROM generation_tasks
    WHERE project_id = ${req.params.id}
    ORDER BY created_at ASC
  `;

  res.json({
    project: projectDto(project),
    photos: photos.map(photoDto),
    images: images.map(imageDto),
    tasks: tasks.map(taskDto)
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

app.delete('/api/images/:id', async (req, res) => {
  await ensureDatabase();
  const deleted = await sql`
    DELETE FROM generated_images
    WHERE id = ${req.params.id}
    RETURNING id
  `;
  if (!deleted.length) return res.status(404).json({ error: 'Imagen no encontrada.' });
  res.json({ ok: true });
});

app.post('/api/projects/:id/generate', async (req, res) => {
  await ensureDatabase();
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Falta OPENAI_API_KEY en variables de entorno.' });
  }

  const [project] = await sql`SELECT * FROM projects WHERE id = ${req.params.id}`;
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const photos = await sql`
    SELECT id, original_name, mime_type, encode(image_data, 'base64') AS image_base64
    FROM source_photos
    WHERE project_id = ${req.params.id}
    ORDER BY created_at ASC
    LIMIT 8
  `;
  if (!photos.length) return res.status(400).json({ error: 'Sube al menos una foto del producto antes de generar.' });

  const settings = await settingsObject();
  const textModel = String(req.body?.textModel || settings.textModel);
  const selectedImageModel = String(req.body?.imageModel || settings.imageModel);
  const imageModel = /gpt-image/i.test(selectedImageModel) ? selectedImageModel : 'gpt-image-1';
  const requestedSize = String(req.body?.imageSize || settings.imageSize);
  const apiSize = normalizeImageSize(imageModel, requestedSize);
  const count = Math.max(1, Math.min(12, Number(req.body?.count || settings.promptCount || 8)));
  const quality = String(req.body?.imageQuality || settings.imageQuality || 'medium');
  const suffix = String(settings.imagePromptSuffix || '');

  const promptPlan = await buildPromptPlan({ photos, textModel, promptTemplate: settings.textPrompt, count });
  const selectedPrompts = promptPlan.prompts.slice(0, count);
  const referenceFiles = await Promise.all(photos.map((photo, index) => {
    const extension = mimeExtension(photo.mime_type);
    const name = photo.original_name || `product-reference-${index + 1}.${extension}`;
    return toFile(Buffer.from(photo.image_base64, 'base64'), name, { type: photo.mime_type });
  }));
  const generated = [];

  for (const item of selectedPrompts) {
    const prompt = `${exactProductInstruction}\n\n${item.prompt}\n\n${suffix}`.trim();
    const { response, mimeType } = await createReferencedImage({
      model: imageModel,
      image: referenceFiles,
      prompt,
      size: apiSize,
      quality,
      outputFormat: 'jpeg',
      outputCompression: 90
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
        ${mimeType},
        decode(${Buffer.from(b64, 'base64').toString('hex')}, 'hex')
      )
      RETURNING id, project_id, title, prompt, size, model, mime_type, created_at
    `;

    generated.push(imageDto(image));
  }

  await sql`UPDATE projects SET updated_at = now() WHERE id = ${req.params.id}`;
  res.json({ productSummary: promptPlan.product_summary, generated, prompts: selectedPrompts });
});

app.post('/api/projects/:id/generate-plan', async (req, res) => {
  await ensureDatabase();
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Falta OPENAI_API_KEY en variables de entorno.' });
  }

  const [project] = await sql`SELECT * FROM projects WHERE id = ${req.params.id}`;
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const photos = await referencePhotos(req.params.id);
  if (!photos.length) return res.status(400).json({ error: 'Sube al menos una foto del producto antes de generar.' });

  const settings = await settingsObject();
  const count = Math.max(1, Math.min(12, Number(req.body?.count || settings.promptCount || 8)));
  const textModel = String(req.body?.textModel || settings.textModel);
  const promptPlan = await buildPromptPlan({ photos, textModel, promptTemplate: settings.textPrompt, count });
  const selectedPrompts = promptPlan.prompts.slice(0, count);

  await sql`DELETE FROM generation_tasks WHERE project_id = ${req.params.id} AND status <> 'processing'`;

  const tasks = [];
  for (const item of selectedPrompts) {
    const [task] = await sql`
      INSERT INTO generation_tasks (project_id, title, prompt)
      VALUES (${req.params.id}, ${item.title || 'Imagen generada'}, ${item.prompt})
      RETURNING id, project_id, title, prompt, status, error, openai_response_id, response_status, image_model, image_size, image_quality, created_at, updated_at
    `;
    tasks.push(taskDto(task));
  }

  res.json({
    productSummary: promptPlan.product_summary,
    tasks
  });
});

app.post('/api/projects/:id/generate-one', async (req, res) => {
  await ensureDatabase();
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Falta OPENAI_API_KEY en variables de entorno.' });
  }

  const [project] = await sql`SELECT * FROM projects WHERE id = ${req.params.id}`;
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const item = {
    title: String(req.body?.title || 'Imagen generada'),
    prompt: String(req.body?.prompt || '').trim()
  };
  if (!item.prompt) return res.status(400).json({ error: 'Falta el prompt de la imagen.' });

  const photos = await referencePhotos(req.params.id);
  if (!photos.length) return res.status(400).json({ error: 'Sube al menos una foto del producto antes de generar.' });

  const settings = await settingsObject();
  const image = await generateAndStoreImage({
    projectId: req.params.id,
    item,
    photos,
    settings,
    body: req.body || {}
  });

  await sql`UPDATE projects SET updated_at = now() WHERE id = ${req.params.id}`;
  res.json({ generated: image });
});

app.post('/api/generation-tasks/:taskId/generate', async (req, res) => {
  await ensureDatabase();
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Falta OPENAI_API_KEY en variables de entorno.' });
  }

  const [task] = await sql`
    SELECT id, project_id, title, prompt, status, openai_response_id, image_model, image_size, image_quality
    FROM generation_tasks
    WHERE id = ${req.params.taskId}
  `;
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada.' });

  if (task.openai_response_id && task.status === 'processing') {
    const result = await finalizeBackgroundTask(task);
    return res.json(result);
  }

  try {
    const photos = await referencePhotos(task.project_id);
    if (!photos.length) return res.status(400).json({ error: 'Sube al menos una foto del producto antes de generar.' });

    const settings = await settingsObject();
    const selectedImageModel = String(req.body?.imageModel || settings.imageModel);
    const imageModel = /gpt-image/i.test(selectedImageModel) ? selectedImageModel : 'gpt-image-1';
    const requestedSize = String(req.body?.imageSize || settings.imageSize);
    const apiSize = normalizeImageSize(imageModel, requestedSize);
    const quality = String(req.body?.imageQuality || settings.imageQuality || 'medium');
    const suffix = String(settings.imagePromptSuffix || '');
    const prompt = `${exactProductInstruction}\n\n${task.prompt}\n\n${suffix}`.trim();
    const response = await createBackgroundImageResponse({
      model: imageModel,
      photos,
      prompt,
      size: apiSize,
      quality
    });
    const [updatedTask] = await sql`
      UPDATE generation_tasks
      SET
        status = 'processing',
        error = NULL,
        openai_response_id = ${response.id},
        response_status = ${response.status || 'queued'},
        image_model = ${imageModel},
        image_size = ${requestedSize},
        image_quality = ${quality},
        updated_at = now()
      WHERE id = ${req.params.taskId}
      RETURNING id, project_id, title, prompt, status, error, openai_response_id, response_status, image_model, image_size, image_quality, created_at, updated_at
    `;
    res.json({ task: taskDto(updatedTask) });
  } catch (error) {
    await sql`
      UPDATE generation_tasks
      SET status = 'failed', error = ${error.message || 'No se pudo generar la imagen.'}, updated_at = now()
      WHERE id = ${req.params.taskId}
    `;
    throw error;
  }
});

app.get('/api/cron/poll-tasks', async (req, res) => {
  await ensureDatabase();
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Falta OPENAI_API_KEY en variables de entorno.' });
  }

  const tasks = await sql`
    SELECT id, project_id, title, prompt, status, openai_response_id, image_model, image_size, image_quality
    FROM generation_tasks
    WHERE status = 'processing' AND openai_response_id IS NOT NULL
    ORDER BY updated_at ASC
    LIMIT 5
  `;
  const results = [];
  for (const task of tasks) {
    try {
      results.push(await finalizeBackgroundTask(task));
    } catch (error) {
      results.push({ taskId: asNumber(task.id), error: error.message });
    }
  }
  res.json({ checked: tasks.length, results });
});

function normalizeImageSize(model, requestedSize) {
  if (requestedSize === 'auto') return 'auto';
  if (/dall-e-2/i.test(model)) return '1024x1024';
  return ['1024x1024', '1536x1024', '1024x1536'].includes(requestedSize) ? requestedSize : '1024x1024';
}

async function referencePhotos(projectId) {
  return sql`
    SELECT id, original_name, mime_type, encode(image_data, 'base64') AS image_base64
    FROM source_photos
    WHERE project_id = ${projectId}
    ORDER BY created_at ASC
    LIMIT 8
  `;
}

async function generateAndStoreImage({ projectId, item, photos, settings, body }) {
  const selectedImageModel = String(body?.imageModel || settings.imageModel);
  const imageModel = /gpt-image/i.test(selectedImageModel) ? selectedImageModel : 'gpt-image-1';
  const requestedSize = String(body?.imageSize || settings.imageSize);
  const apiSize = normalizeImageSize(imageModel, requestedSize);
  const quality = String(body?.imageQuality || settings.imageQuality || 'medium');
  const suffix = String(settings.imagePromptSuffix || '');
  const referenceFiles = await Promise.all(photos.map((photo, index) => {
    const extension = mimeExtension(photo.mime_type);
    const name = photo.original_name || `product-reference-${index + 1}.${extension}`;
    return toFile(Buffer.from(photo.image_base64, 'base64'), name, { type: photo.mime_type });
  }));
  const prompt = `${exactProductInstruction}\n\n${item.prompt}\n\n${suffix}`.trim();
  const { response, mimeType } = await createReferencedImage({
    model: imageModel,
    image: referenceFiles,
    prompt,
    size: apiSize,
    quality,
    outputFormat: 'jpeg',
    outputCompression: 90
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI no devolvio datos de imagen.');

  const [image] = await sql`
    INSERT INTO generated_images (project_id, title, prompt, size, model, mime_type, image_data)
    VALUES (
      ${projectId},
      ${item.title || 'Imagen generada'},
      ${prompt},
      ${requestedSize},
      ${imageModel},
      ${mimeType},
      decode(${Buffer.from(b64, 'base64').toString('hex')}, 'hex')
    )
    RETURNING id, project_id, title, prompt, size, model, mime_type, created_at
  `;

  return imageDto(image);
}

async function createBackgroundImageResponse({ model, photos, prompt, size, quality }) {
  const content = [
    { type: 'input_text', text: prompt },
    ...photos.map((photo) => ({
      type: 'input_image',
      image_url: `data:${photo.mime_type || 'image/jpeg'};base64,${photo.image_base64}`
    }))
  ];

  const tool = {
    type: 'image_generation',
    model: 'gpt-image-1',
    size,
    quality,
    output_format: 'jpeg',
    output_compression: 90
  };

  if (supportsInputFidelity(model)) {
    tool.input_fidelity = 'high';
  }

  const body = {
    model: responseModelForImageWork(),
    background: true,
    store: true,
    input: [{ role: 'user', content }],
    tools: [tool],
    tool_choice: { type: 'image_generation' }
  };

  const optionalParams = ['input_fidelity', 'output_compression', 'output_format'];
  while (true) {
    try {
      return await client.responses.create(body);
    } catch (error) {
      const message = String(error.message || '');
      const rejectedParam = optionalParams.find((param) => message.includes(`'${param}'`) || message.includes(param));
      if (!rejectedParam || !Object.prototype.hasOwnProperty.call(tool, rejectedParam)) throw error;
      delete tool[rejectedParam];
    }
  }
}

function responseModelForImageWork() {
  return process.env.OPENAI_RESPONSE_MODEL || 'gpt-4.1';
}

async function finalizeBackgroundTask(task) {
  const response = await client.responses.retrieve(task.openai_response_id);
  const status = response.status || 'unknown';

  if (status === 'queued' || status === 'in_progress') {
    const [updatedTask] = await sql`
      UPDATE generation_tasks
      SET response_status = ${status}, updated_at = now()
      WHERE id = ${task.id}
      RETURNING id, project_id, title, prompt, status, error, openai_response_id, response_status, image_model, image_size, image_quality, created_at, updated_at
    `;
    return { task: taskDto(updatedTask) };
  }

  if (status !== 'completed') {
    const errorMessage = response.error?.message || `OpenAI termino con estado: ${status}`;
    const [updatedTask] = await sql`
      UPDATE generation_tasks
      SET status = 'failed', response_status = ${status}, error = ${errorMessage}, updated_at = now()
      WHERE id = ${task.id}
      RETURNING id, project_id, title, prompt, status, error, openai_response_id, response_status, image_model, image_size, image_quality, created_at, updated_at
    `;
    return { task: taskDto(updatedTask) };
  }

  const b64 = extractImageResult(response);
  if (!b64) {
    const [updatedTask] = await sql`
      UPDATE generation_tasks
      SET status = 'failed', response_status = ${status}, error = 'OpenAI completo la respuesta, pero no devolvio una imagen.', updated_at = now()
      WHERE id = ${task.id}
      RETURNING id, project_id, title, prompt, status, error, openai_response_id, response_status, image_model, image_size, image_quality, created_at, updated_at
    `;
    return { task: taskDto(updatedTask) };
  }

  const [stillPending] = await sql`
    SELECT id
    FROM generation_tasks
    WHERE id = ${task.id}
  `;
  if (!stillPending) return { task: null };

  const [image] = await sql`
    INSERT INTO generated_images (project_id, title, prompt, size, model, mime_type, image_data)
    VALUES (
      ${task.project_id},
      ${task.title || 'Imagen generada'},
      ${task.prompt},
      ${task.image_size || '1024x1024'},
      ${task.image_model || 'gpt-image-1'},
      ${'image/jpeg'},
      decode(${Buffer.from(b64, 'base64').toString('hex')}, 'hex')
    )
    RETURNING id, project_id, title, prompt, size, model, mime_type, created_at
  `;

  await sql`DELETE FROM generation_tasks WHERE id = ${task.id}`;
  await sql`UPDATE projects SET updated_at = now() WHERE id = ${task.project_id}`;
  return { generated: imageDto(image) };
}

function extractImageResult(response) {
  for (const item of response.output || []) {
    if (item.type === 'image_generation_call' && item.result) return item.result;
  }
  return null;
}

async function createReferencedImage({ model, image, prompt, size, quality, outputFormat, outputCompression }) {
  const body = {
    model,
    image,
    prompt,
    size,
    quality,
    n: 1,
    output_format: outputFormat,
    output_compression: outputCompression
  };

  if (supportsInputFidelity(model)) {
    body.input_fidelity = 'high';
  }

  const optionalParams = ['input_fidelity', 'output_compression', 'output_format'];
  while (true) {
    try {
      const response = await client.images.edit(body);
      const mimeType = body.output_format === 'jpeg' ? 'image/jpeg' : body.output_format === 'webp' ? 'image/webp' : 'image/png';
      return { response, mimeType };
    } catch (error) {
      const message = String(error.message || '');
      const rejectedParam = optionalParams.find((param) => message.includes(`'${param}'`) || message.includes(param));
      if (!rejectedParam || !Object.prototype.hasOwnProperty.call(body, rejectedParam)) throw error;
      delete body[rejectedParam];
    }
  }
}

function supportsInputFidelity(model) {
  return /gpt-image-1(?:\.5|-mini)?$/i.test(model);
}

function mimeExtension(mimeType = '') {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  return 'jpg';
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
