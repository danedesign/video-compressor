const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  frameRatePreserved,
  RESOLUTION_PRESETS,
  displayDimensions,
  fitDimensions
} = require('./compression-utils');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.wmv', '.mpeg', '.mpg']);
let mainWindow;
let cancelRequested = false;
let activeProcess;

function binaryPath(name, packagePath) {
  return app.isPackaged ? path.join(process.resourcesPath, name) : packagePath;
}

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(stderr.trim() || `${path.basename(binary)} exited with code ${code}`)));
  });
}

function getBinaries() {
  if (app.isPackaged) {
    return {
      ffmpeg: path.join(process.resourcesPath, 'ffmpeg.exe'),
      ffprobe: path.join(process.resourcesPath, 'ffprobe.exe')
    };
  }
  return {
    ffmpeg: require('ffmpeg-static'),
    ffprobe: require('ffprobe-static').path
  };
}

async function inspect(filePath) {
  const absolute = path.resolve(filePath);
  const stat = await fs.promises.stat(absolute);
  if (!stat.isFile() || !VIDEO_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
    throw new Error(`Not a supported video file: ${path.basename(absolute)}`);
  }
  const { ffprobe } = getBinaries();
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', absolute
  ]);
  const probe = JSON.parse(stdout);
  const video = (probe.streams || []).find(stream => stream.codec_type === 'video');
  if (!video || !video.width || !video.height) throw new Error('No readable video stream was found.');
  const rotation = Number(video.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
  const displaySize = displayDimensions(video.width, video.height, rotation);
  const duration = Number(probe.format?.duration || video.duration || 0);
  const audioStreams = (probe.streams || []).filter(stream => stream.codec_type === 'audio').length;
  return {
    path: absolute,
    name: path.basename(absolute),
    size: stat.size,
    duration,
    width: video.width,
    height: video.height,
    displayWidth: displaySize.width,
    displayHeight: displaySize.height,
    rotation,
    frameRate: video.avg_frame_rate || video.r_frame_rate || 'unknown',
    audioStreams
  };
}

function send(type, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('compressor:event', { type, ...data });
}

function makeOutputPath(outputDir, filePath, resolution) {
  const stem = path.parse(filePath).name;
  const suffix = resolution === 'original' ? 'compressed' : `${resolution}.compressed`;
  let output = path.join(outputDir, `${stem}.${suffix}.mp4`);
  let index = 1;
  while (fs.existsSync(output)) {
    output = path.join(outputDir, `${stem}.${suffix} (${index++}).mp4`);
  }
  return output;
}

function parseProgress(text, duration) {
  const values = Object.fromEntries(text.trim().split(/\r?\n/).map(line => {
    const separator = line.indexOf('=');
    return separator < 0 ? ['', ''] : [line.slice(0, separator), line.slice(separator + 1)];
  }).filter(([key]) => key));
  const microseconds = Number(values.out_time_us || values.out_time_ms || 0);
  return duration > 0 ? Math.min(99, (microseconds / 1_000_000 / duration) * 100) : 0;
}

async function compressOne(file, outputDir, crf, resolution, index, total) {
  const output = makeOutputPath(outputDir, file.path, resolution);
  const { ffmpeg } = getBinaries();
  const target = RESOLUTION_PRESETS[resolution];
  const args = [
    '-hide_banner', '-y', '-i', file.path,
    '-map', '0:v:0', '-map', '0:a?',
  ];
  if (target) {
    args.push('-vf', `scale=${target[0]}:${target[1]}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`);
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough',
    '-c:a', 'copy', '-map_metadata', '0', '-map_chapters', '0',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output
  );

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcess = child;
    let progressText = '';
    let errorText = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      progressText += chunk;
      const blocks = progressText.split(/\r?\n\r?\n/);
      progressText = blocks.pop() || '';
      for (const block of blocks) {
        send('progress', {
          index, total, name: file.name, path: file.path,
          percent: parseProgress(block, file.duration)
        });
      }
    });
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-12000); });
    child.once('error', error => {
      activeProcess = undefined;
      reject(error);
    });
    child.once('close', async code => {
      activeProcess = undefined;
      if (code !== 0) {
        await fs.promises.rm(output, { force: true }).catch(() => {});
        reject(new Error(cancelRequested ? 'Cancelled.' : (errorText.trim().split(/\r?\n/).slice(-4).join(' ') || `FFmpeg exited with code ${code}`)));
        return;
      }
      try {
        const outputStat = await fs.promises.stat(output);
        if (outputStat.size >= file.size && resolution === 'original') {
          await fs.promises.rm(output, { force: true });
          resolve({ status: 'not-smaller', inputSize: file.size, outputSize: outputStat.size });
          return;
        }
        const resultProbe = await inspect(output);
        const expectedSize = fitDimensions(file.displayWidth, file.displayHeight, resolution);
        const checks = {
          resolutionMatchesSelection: resultProbe.width === expectedSize.width && resultProbe.height === expectedSize.height,
          frameRatePreserved: frameRatePreserved(file.frameRate, resultProbe.frameRate),
          durationPreserved: Math.abs(resultProbe.duration - file.duration) <= Math.max(1, file.duration * 0.005),
          audioPresencePreserved: (file.audioStreams > 0) === (resultProbe.audioStreams > 0)
        };
        if (Object.values(checks).some(value => !value)) {
          await fs.promises.rm(output, { force: true });
          throw new Error(`Output validation failed: ${Object.entries(checks).filter(([, value]) => !value).map(([key]) => key).join(', ')}`);
        }
        resolve({
          status: outputStat.size < file.size ? 'compressed' : 'ready',
          output, inputSize: file.size, outputSize: outputStat.size,
          outputWidth: resultProbe.width, outputHeight: resultProbe.height, checks
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 820,
    minHeight: 640,
    backgroundColor: '#f4f7fb',
    title: 'SL Video Compressor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  ipcMain.handle('compressor:choose-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose videos to compress',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video files', extensions: [...VIDEO_EXTENSIONS].map(ext => ext.slice(1)) }]
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('compressor:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose output folder',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('compressor:inspect', async (_event, paths) => {
    if (!Array.isArray(paths)) throw new Error('Invalid file list.');
    const results = await Promise.all(paths.map(async filePath => {
      try { return { ok: true, file: await inspect(filePath) }; }
      catch (error) { return { ok: false, path: filePath, error: error.message }; }
    }));
    return results;
  });
  ipcMain.handle('compressor:start', async (_event, options) => {
    if (!options || !Array.isArray(options.files) || !options.files.length) throw new Error('Add at least one video first.');
    if (!options.outputDir || !fs.existsSync(options.outputDir)) throw new Error('Choose an output folder that exists.');
    const crf = Number(options.crf);
    if (![24, 26, 28, 30, 32].includes(crf)) throw new Error('Choose a supported quality setting.');
    const resolution = options.resolution;
    if (!Object.hasOwn(RESOLUTION_PRESETS, resolution)) throw new Error('Choose a supported output resolution.');
    cancelRequested = false;
    const results = [];
    for (let index = 0; index < options.files.length; index++) {
      if (cancelRequested) break;
      const file = await inspect(options.files[index]);
      send('file-start', { index: index + 1, total: options.files.length, name: file.name, path: file.path });
      try {
        const result = await compressOne(file, options.outputDir, crf, resolution, index + 1, options.files.length);
        const item = { name: file.name, ...result };
        results.push(item);
        send('file-result', { ...item, path: file.path });
      } catch (error) {
        const item = { name: file.name, status: cancelRequested ? 'cancelled' : 'error', error: error.message };
        results.push(item);
        send('file-result', { ...item, path: file.path });
        if (cancelRequested) break;
      }
    }
    send('batch-complete', { results });
    return results;
  });
  ipcMain.handle('compressor:cancel', () => {
    cancelRequested = true;
    if (activeProcess) activeProcess.kill('SIGTERM');
    return true;
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
