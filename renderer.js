const api = window.videoCompressor;
const queue = document.getElementById('queue');
const addButton = document.getElementById('addFiles');
const startButton = document.getElementById('start');
const cancelButton = document.getElementById('cancel');
const clearButton = document.getElementById('clearQueue');
const outputLabel = document.getElementById('outputPath');
const queueSummary = document.getElementById('queueSummary');
const queueCount = document.getElementById('queueCount');
const dropZone = document.getElementById('dropZone');
const toast = document.getElementById('toast');
const items = new Map();
let outputDir = '';
let running = false;
let toastTimer;

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (!seconds) return 'duration unknown';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

function updateActions() {
  const count = items.size;
  queueCount.textContent = String(count);
  clearButton.disabled = running || count === 0;
  startButton.disabled = running || count === 0 || !outputDir;
  addButton.disabled = running;
  queueSummary.textContent = count ? `${count} video${count === 1 ? '' : 's'} · ${[...items.values()].reduce((sum, item) => sum + (item.size || 0), 0) ? formatSize([...items.values()].reduce((sum, item) => sum + (item.size || 0), 0)) + ' total' : 'reading files…'}` : 'Add videos to get started';
  cancelButton.hidden = !running;
  document.getElementById('chooseFolder').disabled = running;
}

function render() {
  if (!items.size) {
    queue.className = 'queue empty-queue';
    queue.innerHTML = '<div class="empty-state">Your videos will appear here</div>';
    updateActions();
    return;
  }
  queue.className = 'queue';
  queue.replaceChildren();
  for (const item of items.values()) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.dataset.path = item.path;
    const ext = item.name.split('.').pop().slice(0, 4).toUpperCase();
    const hasOutput = item.status === 'compressed' || item.status === 'ready';
    const displayedWidth = hasOutput ? item.outputWidth : item.displayWidth || item.width;
    const displayedHeight = hasOutput ? item.outputHeight : item.displayHeight || item.height;
    const visibleSize = hasOutput ? item.outputSize : item.size;
    const resolution = displayedWidth && displayedHeight ? `${displayedWidth} × ${displayedHeight}` : 'Reading…';
    const errorDetail = item.status === 'error' && item.error
      ? `<div class="file-error" title="${escapeAttribute(item.error)}">${escapeHtml(item.error.replace(/\s+/g, ' ').slice(0, 150))}</div>`
      : '';
    let status = item.status === 'compressed' ? `<span class="status-tag done" title="Saved ${formatSize(item.saved || 0)}">COMPRESSED</span>`
      : item.status === 'ready' ? `<span class="status-tag done" title="Selected output size created; file size may increase">OUTPUT READY</span>`
      : item.status === 'not-smaller' ? `<span class="status-tag" title="${escapeAttribute(item.error || 'No size reduction')}">NO SAVING</span>`
      : item.status === 'error' ? `<span class="status-tag error" title="${escapeAttribute(item.error || 'Compression failed')}">ERROR</span>`
      : item.status === 'working' ? '<span class="status-tag">WORKING</span>'
      : '<button class="remove-file" title="Remove video" aria-label="Remove video">×</button>';
    row.innerHTML = `<div class="file-icon">${ext}</div><div class="file-main"><div class="file-name" title="${escapeAttribute(item.name)}">${escapeHtml(item.name)}</div><div class="file-meta">${item.duration ? `${formatDuration(item.duration)} · ` : ''}${item.audioStreams !== undefined ? `${item.audioStreams} audio track${item.audioStreams === 1 ? '' : 's'}` : 'Inspecting video'}</div>${errorDetail}</div><div class="file-resolution" title="${hasOutput ? 'Output resolution' : 'Input resolution'}">${resolution}</div><div class="file-size" title="${hasOutput ? 'Output file size' : 'Input file size'}">${formatSize(visibleSize)}</div>${status}${item.status === 'working' ? `<div class="item-progress"><span style="width:${item.percent || 0}%"></span></div>` : ''}`;
    row.querySelector('.remove-file')?.addEventListener('click', () => { items.delete(item.path); render(); });
    queue.append(row);
  }
  updateActions();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function escapeAttribute(value) { return escapeHtml(value); }

async function addPaths(paths) {
  const unique = [...new Set(paths)].filter(filePath => ![...items.keys()].some(existing => existing.toLowerCase() === filePath.toLowerCase()));
  if (!unique.length) return;
  for (const filePath of unique) items.set(filePath, { path: filePath, name: filePath.split(/[\\/]/).pop(), status: 'inspecting' });
  render();
  const results = await api.inspect(unique);
  for (const result of results) {
    if (result.ok) items.set(result.file.path, { ...result.file, status: 'queued' });
    else {
      items.delete(result.path);
      notify(`${result.path.split(/[\\/]/).pop()}: ${result.error}`);
    }
  }
  render();
}

addButton.addEventListener('click', async () => addPaths(await api.chooseFiles()));
document.getElementById('chooseFolder').addEventListener('click', async () => {
  const folder = await api.chooseFolder();
  if (folder) { outputDir = folder; outputLabel.textContent = folder; outputLabel.title = folder; updateActions(); }
});
clearButton.addEventListener('click', () => { if (!running) { items.clear(); render(); } });
startButton.addEventListener('click', async () => {
  if (running || !outputDir || !items.size) return;
  running = true;
  for (const item of items.values()) { item.status = 'queued'; item.percent = 0; }
  render();
  updateActions();
  try {
      await api.start({
        files: [...items.keys()],
        outputDir,
        crf: Number(document.getElementById('quality').value),
        resolution: document.getElementById('resolution').value
      });
  } catch (error) {
    notify(error.message);
  }
});
cancelButton.addEventListener('click', () => api.cancel());

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, event => { event.preventDefault(); dropZone.classList.add('dragging'); });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, event => { event.preventDefault(); dropZone.classList.remove('dragging'); });
}
dropZone.addEventListener('drop', async event => {
  await addPaths([...event.dataTransfer.files].map(file => api.getPathForFile(file)).filter(Boolean));
});

api.onEvent(event => {
  if (event.type === 'file-start') {
    const item = items.get(event.path);
    if (item) { item.status = 'working'; item.percent = 0; }
    render();
  } else if (event.type === 'progress') {
    const item = items.get(event.path);
    if (item) { item.status = 'working'; item.percent = event.percent; }
    render();
  } else if (event.type === 'file-result') {
    const item = items.get(event.path);
    if (item) {
      item.status = event.status;
      item.percent = 100;
      item.output = event.output;
      item.outputWidth = event.outputWidth;
      item.outputHeight = event.outputHeight;
      item.outputSize = event.outputSize;
      item.error = event.error;
      if (event.status === 'compressed') item.saved = event.inputSize - event.outputSize;
      if (event.status === 'not-smaller') item.error = 'Already compact; no smaller output was kept.';
    }
    render();
  } else if (event.type === 'batch-complete') {
    running = false;
    const completed = event.results.filter(result => result.status === 'compressed' || result.status === 'ready');
    const netSavings = completed.reduce((sum, result) => sum + result.inputSize - result.outputSize, 0);
    const errors = event.results.filter(result => result.status === 'error').length;
    const noSaving = event.results.filter(result => result.status === 'not-smaller').length;
    const cancelled = event.results.filter(result => result.status === 'cancelled').length;
    const netMessage = netSavings >= 0 ? `saved ${formatSize(netSavings)}` : `grew by ${formatSize(-netSavings)}`;
    if (errors) notify(`Finished with ${errors} error${errors === 1 ? '' : 's'}. ${completed.length} output${completed.length === 1 ? '' : 's'} ready; details are shown in the queue.`);
    else if (completed.length) notify(`Done — ${completed.length} output${completed.length === 1 ? '' : 's'} ready; ${netMessage}.`);
    else if (cancelled) notify('Compression cancelled. Originals were kept.');
    else notify(noSaving ? 'Done — no smaller outputs were produced. Originals were kept.' : 'No files were compressed.');
    render();
  }
});

window.addEventListener('beforeunload', event => {
  if (running) { event.preventDefault(); event.returnValue = ''; }
});
updateActions();
