const state = {
  projects: [],
  currentProjectId: null,
  projectDetail: null,
  settings: {},
  stream: null,
  generatingTaskId: null,
  pollTimer: null
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
  fileInput: $('fileInput'),
  generateButton: $('generateButton'),
  reviewAllButton: $('reviewAllButton'),
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
  imageModal: $('imageModal'),
  modalTitle: $('modalTitle'),
  modalImage: $('modalImage'),
  modalDownload: $('modalDownload'),
  modalSaveButton: $('modalSaveButton'),
  modalRegenerateButton: $('modalRegenerateButton'),
  modalDeleteButton: $('modalDeleteButton'),
  modalCloseButton: $('modalCloseButton'),
  toast: $('toast')
};

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
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

function rememberProject(id) {
  if (id) localStorage.setItem('merchpic.currentProjectId', String(id));
  else localStorage.removeItem('merchpic.currentProjectId');
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

function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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
    <article class="project-card" data-project="${project.id}">
      <button class="project-open" type="button" data-project="${project.id}">
        ${project.thumbnailUrl ? `<img src="${project.thumbnailUrl}" alt="">` : '<span class="placeholder-thumb">Sin fotos</span>'}
      </button>
      <div class="card-body">
        <strong>${escapeHtml(project.name)}</strong>
        <span>${new Date(project.updated_at).toLocaleString()}</span>
        <span class="card-actions">
          <button class="danger-button compact" type="button" data-delete-project="${project.id}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
            Borrar
          </button>
        </span>
      </div>
    </article>
  `).join('');
}

async function openProject(id) {
  state.currentProjectId = id;
  rememberProject(id);
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
  const tasks = detail.tasks || [];
  els.imageCount.textContent = detail.images.length + tasks.length;
  els.sourcePhotos.innerHTML = detail.photos.map((photo) => `<img src="${photo.url}" alt="">`).join('');
  const taskCards = tasks.map((task) => {
    const isGenerating = String(state.generatingTaskId) === String(task.id);
    const isProcessing = task.status === 'processing';
    const isActive = isGenerating || isProcessing;
    const statusText = isGenerating
      ? 'Consultando OpenAI...'
      : isProcessing
        ? 'OpenAI sigue trabajando'
        : task.status === 'failed'
          ? 'Falló, puedes reintentar'
          : 'Lista para crear';
    const buttonText = isGenerating
      ? 'Revisando...'
      : isProcessing
        ? 'Revisar'
        : task.status === 'failed'
          ? 'Reintentar'
          : 'Crear imagen';
    return `
    <article class="image-card task-card ${isActive ? 'skeleton-card' : ''}">
      <div class="${isActive ? 'skeleton-image' : 'planned-image'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/></svg>
      </div>
      <div class="card-body">
        <strong>${escapeHtml(task.title)}</strong>
        <span>${statusText}</span>
        <span class="image-actions">
          <button class="primary-button task-generate-button" type="button" data-generate-task="${task.id}" ${isGenerating ? 'disabled' : ''}>
            ${buttonText}
          </button>
        </span>
      </div>
    </article>
  `;
  }).join('');
  const imageCards = detail.images.map((image) => `
    <article class="image-card" data-open-image="${image.id}">
      <img src="${image.url}" alt="${escapeHtml(image.title)}">
      <div class="card-body">
        <strong>${escapeHtml(image.title)}</strong>
        <span>${escapeHtml(image.size)} · ${escapeHtml(image.model)}</span>
        <span class="image-actions">
          ${isIOSDevice()
            ? `<button class="download-button" type="button" data-save-image="${image.id}">Guardar</button>`
            : `<a class="download-button" href="${image.downloadUrl}">Descargar</a>`}
          <button class="secondary-button compact" type="button" data-regenerate-image="${image.id}">Rehacer</button>
          <button class="danger-button compact" type="button" data-delete-image="${image.id}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
            Borrar
          </button>
        </span>
      </div>
    </article>
  `).join('');
  els.generatedImages.innerHTML = imageCards + taskCards;
  updateTaskPolling();
}

function openImageModal(id) {
  const image = state.projectDetail?.images.find((item) => String(item.id) === String(id));
  if (!image) return;
  els.modalTitle.textContent = image.title;
  els.modalImage.src = image.url;
  els.modalImage.alt = image.title;
  els.modalDownload.href = image.downloadUrl;
  els.modalDownload.hidden = isIOSDevice();
  els.modalSaveButton.hidden = !isIOSDevice();
  els.modalSaveButton.dataset.saveImage = image.id;
  els.modalRegenerateButton.dataset.regenerateImage = image.id;
  els.modalDeleteButton.dataset.deleteImage = image.id;
  els.imageModal.hidden = false;
  document.body.classList.add('modal-open');
}

function closeImageModal() {
  els.imageModal.hidden = true;
  els.modalImage.src = '';
  document.body.classList.remove('modal-open');
}

async function deleteProject(id) {
  if (!confirm('Borrar este proyecto y todo su contenido?')) return;
  await api(`/api/projects/${id}`, { method: 'DELETE' });
  if (String(state.currentProjectId) === String(id)) {
    state.currentProjectId = null;
    state.projectDetail = null;
    rememberProject(null);
    stopCamera();
    showScreen('projects');
  }
  await loadProjects();
  showToast('Proyecto borrado.');
}

async function deleteGeneratedImage(id) {
  if (!confirm('Borrar esta imagen generada?')) return;
  await api(`/api/images/${id}`, { method: 'DELETE' });
  closeImageModal();
  state.projectDetail = await api(`/api/projects/${state.currentProjectId}`);
  renderProjectDetail();
  showToast('Imagen borrada.');
}

async function regenerateImage(id) {
  const result = await api(`/api/images/${id}/regenerate`, { method: 'POST' });
  state.projectDetail = await api(`/api/projects/${state.currentProjectId}`);
  renderProjectDetail();
  closeImageModal();
  showToast(result.task ? 'Nueva tarea creada.' : 'No se pudo crear la tarea.');
}

async function saveImageToPhone(id) {
  const image = state.projectDetail?.images.find((item) => String(item.id) === String(id));
  if (!image) return;

  if (!navigator.share || typeof File === 'undefined') {
    showToast('Tu navegador no permite guardar en galeria desde la app.');
    return;
  }

  const response = await fetch(image.url);
  const blob = await response.blob();
  const file = new File([blob], `${image.title.replace(/[^\w.-]+/g, '-') || 'imagen-producto'}.jpg`, { type: blob.type || 'image/jpeg' });
  if (navigator.canShare && !navigator.canShare({ files: [file] })) {
    showToast('Tu navegador no permite compartir esta imagen.');
    return;
  }

  await navigator.share({
    files: [file],
    title: image.title
  });
}

async function uploadFiles(files) {
  if (!state.currentProjectId || !files.length) return;
  const preparedFiles = await prepareUploadFiles(files);
  const form = new FormData();
  for (const file of preparedFiles) form.append('photos', file);
  await api(`/api/projects/${state.currentProjectId}/photos`, { method: 'POST', body: form });
  state.projectDetail = await api(`/api/projects/${state.currentProjectId}`);
  renderProjectDetail();
  showToast(`${preparedFiles.length} foto(s) guardada(s).`);
}

function prepareUploadFiles(files) {
  const selected = files.slice(0, 6);
  if (files.length > selected.length) showToast('Se subiran maximo 6 fotos por vez.');
  return selected;
}

async function startCamera() {
  if (state.stream) {
    stopCamera();
    return;
  }
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false
  });
  els.cameraVideo.srcObject = state.stream;
  els.cameraButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>Cerrar';
  els.captureButton.disabled = false;
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  els.cameraVideo.srcObject = null;
  els.cameraButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3l-1.5-2Z"/><path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg>Cámara';
  els.captureButton.disabled = true;
}

async function capturePhoto() {
  const video = els.cameraVideo;
  const canvas = els.captureCanvas;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.98));
  if (!blob) throw new Error('No se pudo capturar la foto.');
  return new File([blob], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' });
}

async function captureAndUpload() {
  const file = await capturePhoto();
  await uploadFiles([file]);
}

async function generateImages() {
  if (!state.currentProjectId) return;
  els.generateButton.disabled = true;
  const requestedCount = Math.max(1, Math.min(12, Number(state.settings.promptCount || els.promptCount?.value || 8)));
  els.generateButton.textContent = 'Preparando...';
  try {
    await api(`/api/projects/${state.currentProjectId}/generate-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: requestedCount })
    });
    state.projectDetail = await api(`/api/projects/${state.currentProjectId}`);
    renderProjectDetail();
    showToast('Lista de imagenes preparada.');
  } finally {
    els.generateButton.disabled = false;
    els.generateButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/></svg>Generar';
    if (state.projectDetail) renderProjectDetail();
  }
}

async function generateTask(taskId) {
  if (!state.currentProjectId) return;
  state.generatingTaskId = taskId;
  renderProjectDetail();
  try {
    const result = await api(`/api/generation-tasks/${taskId}/generate`, { method: 'POST' });
    state.projectDetail = await api(`/api/projects/${state.currentProjectId}`);
    showToast(result.generated ? 'Imagen creada.' : 'OpenAI sigue generando. Puedes revisar de nuevo en un momento.');
  } finally {
    state.generatingTaskId = null;
    if (state.currentProjectId) {
      state.projectDetail = await api(`/api/projects/${state.currentProjectId}`);
      renderProjectDetail();
    }
  }
}

async function reviewAllTasks({ silent = false } = {}) {
  if (!state.currentProjectId) return;
  const processing = (state.projectDetail?.tasks || []).filter((task) => task.status === 'processing');
  if (!processing.length) {
    stopTaskPolling();
    if (!silent) showToast('No hay imagenes en proceso.');
    return;
  }
  if (!silent) els.reviewAllButton.disabled = true;
  try {
    const result = await api(`/api/projects/${state.currentProjectId}/review-tasks`, { method: 'POST' });
    state.projectDetail = await api(`/api/projects/${state.currentProjectId}`);
    renderProjectDetail();
    const created = (result.results || []).filter((item) => item.generated).length;
    if (!silent) showToast(created ? `${created} imagen(es) recuperada(s).` : 'OpenAI sigue trabajando.');
  } finally {
    els.reviewAllButton.disabled = false;
  }
}

function updateTaskPolling() {
  const hasProcessing = (state.projectDetail?.tasks || []).some((task) => task.status === 'processing');
  if (!hasProcessing || !state.currentProjectId) {
    stopTaskPolling();
    return;
  }
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => {
    reviewAllTasks({ silent: true }).catch((err) => showToast(err.message));
  }, 10000);
}

function stopTaskPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
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
  const deleteButton = event.target.closest('[data-delete-project]');
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    deleteProject(deleteButton.dataset.deleteProject).catch((err) => showToast(err.message));
    return;
  }
  const card = event.target.closest('[data-project]');
  if (card) openProject(card.dataset.project).catch((err) => showToast(err.message));
});

els.generatedImages.addEventListener('click', (event) => {
  const saveButton = event.target.closest('[data-save-image]');
  if (saveButton) {
    event.stopPropagation();
    saveImageToPhone(saveButton.dataset.saveImage).catch((err) => showToast(err.message));
    return;
  }
  const taskButton = event.target.closest('[data-generate-task]');
  if (taskButton) {
    event.stopPropagation();
    generateTask(taskButton.dataset.generateTask).catch((err) => showToast(err.message));
    return;
  }
  const deleteButton = event.target.closest('[data-delete-image]');
  if (deleteButton) {
    event.stopPropagation();
    deleteGeneratedImage(deleteButton.dataset.deleteImage).catch((err) => showToast(err.message));
    return;
  }
  const regenerateButton = event.target.closest('[data-regenerate-image]');
  if (regenerateButton) {
    event.stopPropagation();
    regenerateImage(regenerateButton.dataset.regenerateImage).catch((err) => showToast(err.message));
    return;
  }
  if (event.target.closest('a')) return;
  const card = event.target.closest('[data-open-image]');
  if (card) openImageModal(card.dataset.openImage);
});

els.modalCloseButton.addEventListener('click', closeImageModal);
els.imageModal.addEventListener('click', (event) => {
  if (event.target.closest('[data-close-modal]')) closeImageModal();
});
els.modalDeleteButton.addEventListener('click', () => {
  deleteGeneratedImage(els.modalDeleteButton.dataset.deleteImage).catch((err) => showToast(err.message));
});
els.modalSaveButton.addEventListener('click', () => {
  saveImageToPhone(els.modalSaveButton.dataset.saveImage).catch((err) => showToast(err.message));
});
els.modalRegenerateButton.addEventListener('click', () => {
  regenerateImage(els.modalRegenerateButton.dataset.regenerateImage).catch((err) => showToast(err.message));
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.imageModal.hidden) closeImageModal();
});

els.backButton.addEventListener('click', () => {
  if (els.settingsScreen.classList.contains('active') && state.currentProjectId) {
    showScreen('detail');
  } else {
    stopCamera();
    stopTaskPolling();
    rememberProject(null);
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
els.fileInput.addEventListener('change', (event) => uploadFiles([...event.target.files]).catch((err) => showToast(err.message)));
els.generateButton.addEventListener('click', () => generateImages().catch((err) => showToast(err.message)));
els.reviewAllButton.addEventListener('click', () => reviewAllTasks().catch((err) => showToast(err.message)));
els.refreshModelsButton.addEventListener('click', () => refreshModels().catch((err) => showToast(err.message)));
els.saveSettingsButton.addEventListener('click', () => saveSettings().catch((err) => showToast(err.message)));

window.addEventListener('beforeunload', stopCamera);

loadSettings()
  .then(loadProjects)
  .then(async () => {
    const savedProjectId = localStorage.getItem('merchpic.currentProjectId');
    if (!savedProjectId) return;
    try {
      await openProject(savedProjectId);
    } catch (_err) {
      rememberProject(null);
      showScreen('projects');
    }
  })
  .catch((err) => showToast(err.message));
