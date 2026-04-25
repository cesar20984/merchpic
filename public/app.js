const state = {
  projects: [],
  currentProjectId: null,
  projectDetail: null,
  settings: {},
  stream: null
};

const $ = (id) => document.getElementById(id);

const els = {
  screenTitle: $('screenTitle'),
  backButton: $('backButton'),
  settingsButton: $('settingsButton'),
  projectsScreen: $('projectsScreen'),
  detailScreen: $('detailScreen'),
  settingsScreen: $('settingsScreen'),
  projectForm: $('projectForm'),
  projectName: $('projectName'),
  projectsList: $('projectsList'),
  projectThumb: $('projectThumb'),
  projectTitle: $('projectTitle'),
  cameraVideo: $('cameraVideo'),
  captureCanvas: $('captureCanvas'),
  cameraButton: $('cameraButton'),
  captureButton: $('captureButton'),
  burstButton: $('burstButton'),
  fileInput: $('fileInput'),
  generateButton: $('generateButton'),
  sourcePhotos: $('sourcePhotos'),
  generatedImages: $('generatedImages'),
  photoCount: $('photoCount'),
  imageCount: $('imageCount'),
  refreshModelsButton: $('refreshModelsButton'),
  saveSettingsButton: $('saveSettingsButton'),
  textModel: $('textModel'),
  imageModel: $('imageModel'),
  imageSize: $('imageSize'),
  imageQuality: $('imageQuality'),
  promptCount: $('promptCount'),
  textPrompt: $('textPrompt'),
  imagePromptSuffix: $('imagePromptSuffix'),
  toast: $('toast')
};

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la accion.');
  return data;
}

function showScreen(name) {
  for (const screen of [els.projectsScreen, els.detailScreen, els.settingsScreen]) {
    screen.classList.remove('active');
  }
  $(`${name}Screen`).classList.add('active');
  els.backButton.hidden = name === 'projects';
  els.screenTitle.textContent = name === 'projects' ? 'Proyectos' : name === 'settings' ? 'Settings' : 'Producto';
}

function optionList(select, values, selected) {
  const unique = [...new Set([selected, ...values].filter(Boolean))];
  select.innerHTML = unique.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  select.value = selected || unique[0] || '';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjects();
}

function renderProjects() {
  if (!state.projects.length) {
    els.projectsList.innerHTML = '<div class="placeholder-thumb">Crea tu primer proyecto</div>';
    return;
  }
  els.projectsList.innerHTML = state.projects.map((project) => `
    <button class="project-card" type="button" data-project="${project.id}">
      ${project.thumbnailUrl ? `<img src="${project.thumbnailUrl}" alt="">` : '<div class="placeholder-thumb">Sin fotos</div>'}
      <span class="card-body">
        <strong>${escapeHtml(project.name)}</strong>
        <span>${new Date(project.updated_at).toLocaleString()}</span>
      </span>
    </button>
  `).join('');
}

async function openProject(id) {
  state.currentProjectId = id;
  state.projectDetail = await api(`/api/projects/${id}`);
  renderProjectDetail();
  showScreen('detail');
}

function renderProjectDetail() {
  const detail = state.projectDetail;
  const project = detail.project;
  els.projectTitle.textContent = project.name;
  els.projectThumb.src = project.thumbnailUrl || '';
  els.projectThumb.alt = project.name;
  els.photoCount.textContent = detail.photos.length;
  els.imageCount.textContent = detail.images.length;
  els.sourcePhotos.innerHTML = detail.photos.map((photo) => `<img src="${photo.url}" alt="">`).join('');
  els.generatedImages.innerHTML = detail.images.map((image) => `
    <article class="image-card">
      <img src="${image.url}" alt="${escapeHtml(image.title)}">
      <div class="card-body">
        <strong>${escapeHtml(image.title)}</strong>
        <span>${escapeHtml(image.size)} · ${escapeHtml(image.model)}</span>
        <a href="${image.downloadUrl}">Descargar</a>
      </div>
    </article>
  `).join('');
}

async function uploadFiles(files) {
  if (!state.currentProjectId || !files.length) return;
  const form = new FormData();
  for (const file of files) form.append('photos', file);
  await api(`/api/projects/${state.currentProjectId}/photos`, { method: 'POST', body: form });
  state.projectDetail = await api(`/api/projects/${state.currentProjectId}`);
  renderProjectDetail();
  showToast(`${files.length} foto(s) guardada(s).`);
}

async function startCamera() {
  if (state.stream) {
    stopCamera();
    return;
  }
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
    audio: false
  });
  els.cameraVideo.srcObject = state.stream;
  els.cameraButton.textContent = 'Cerrar';
  els.captureButton.disabled = false;
  els.burstButton.disabled = false;
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  els.cameraVideo.srcObject = null;
  els.cameraButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3l-1.5-2Z"/><path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg>Cámara';
  els.captureButton.disabled = true;
  els.burstButton.disabled = true;
}

async function capturePhoto() {
  const video = els.cameraVideo;
  const canvas = els.captureCanvas;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  return new File([blob], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' });
}

async function captureAndUpload() {
  const file = await capturePhoto();
  await uploadFiles([file]);
}

async function burstCapture() {
  els.burstButton.disabled = true;
  const files = [];
  for (let i = 0; i < 5; i += 1) {
    files.push(await capturePhoto());
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  await uploadFiles(files);
  els.burstButton.disabled = false;
}

async function generateImages() {
  if (!state.currentProjectId) return;
  els.generateButton.disabled = true;
  els.generateButton.textContent = 'Generando...';
  try {
    const data = await api(`/api/projects/${state.currentProjectId}/generate`, { method: 'POST' });
    showToast(`${data.generated.length} imagen(es) generada(s).`);
    state.projectDetail = await api(`/api/projects/${state.currentProjectId}`);
    renderProjectDetail();
  } finally {
    els.generateButton.disabled = false;
    els.generateButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/></svg>Generar';
  }
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  optionList(els.textModel, [], state.settings.textModel);
  optionList(els.imageModel, [], state.settings.imageModel);
  els.imageSize.value = state.settings.imageSize || '1024x1024';
  els.imageQuality.value = state.settings.imageQuality || 'medium';
  els.promptCount.value = state.settings.promptCount || '8';
  els.textPrompt.value = state.settings.textPrompt || '';
  els.imagePromptSuffix.value = state.settings.imagePromptSuffix || '';
}

async function refreshModels() {
  els.refreshModelsButton.disabled = true;
  try {
    const models = await api('/api/models');
    optionList(els.textModel, models.textModels, els.textModel.value || state.settings.textModel);
    optionList(els.imageModel, models.imageModels, els.imageModel.value || state.settings.imageModel);
    showToast('Modelos actualizados.');
  } finally {
    els.refreshModelsButton.disabled = false;
  }
}

async function saveSettings() {
  state.settings = await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      textModel: els.textModel.value,
      imageModel: els.imageModel.value,
      imageSize: els.imageSize.value,
      imageQuality: els.imageQuality.value,
      promptCount: els.promptCount.value,
      textPrompt: els.textPrompt.value,
      imagePromptSuffix: els.imagePromptSuffix.value
    })
  });
  showToast('Settings guardados.');
}

els.projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const project = await api('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: els.projectName.value })
  });
  els.projectName.value = '';
  await loadProjects();
  await openProject(project.id);
});

els.projectsList.addEventListener('click', (event) => {
  const card = event.target.closest('[data-project]');
  if (card) openProject(card.dataset.project).catch((err) => showToast(err.message));
});

els.backButton.addEventListener('click', () => {
  if (els.settingsScreen.classList.contains('active') && state.currentProjectId) {
    showScreen('detail');
  } else {
    stopCamera();
    showScreen('projects');
    loadProjects().catch((err) => showToast(err.message));
  }
});

els.settingsButton.addEventListener('click', async () => {
  await loadSettings();
  showScreen('settings');
});

els.cameraButton.addEventListener('click', () => startCamera().catch((err) => showToast(err.message)));
els.captureButton.addEventListener('click', () => captureAndUpload().catch((err) => showToast(err.message)));
els.burstButton.addEventListener('click', () => burstCapture().catch((err) => showToast(err.message)));
els.fileInput.addEventListener('change', (event) => uploadFiles([...event.target.files]).catch((err) => showToast(err.message)));
els.generateButton.addEventListener('click', () => generateImages().catch((err) => showToast(err.message)));
els.refreshModelsButton.addEventListener('click', () => refreshModels().catch((err) => showToast(err.message)));
els.saveSettingsButton.addEventListener('click', () => saveSettings().catch((err) => showToast(err.message)));

window.addEventListener('beforeunload', stopCamera);

loadSettings()
  .then(loadProjects)
  .catch((err) => showToast(err.message));
