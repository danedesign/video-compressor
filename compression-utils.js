function parseFrameRate(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  if (!denominator) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function frameRatePreserved(source, output) {
  const sourceRate = parseFrameRate(source);
  const outputRate = parseFrameRate(output);
  if (sourceRate === null || outputRate === null) return source === output;

  // MP4 time-base rounding can slightly change ffprobe's displayed average rate
  // even when FFmpeg passes every source frame through without duplication/drop.
  const tolerance = Math.max(0.05, sourceRate * 0.001);
  return Math.abs(sourceRate - outputRate) <= tolerance;
}

const RESOLUTION_PRESETS = {
  original: null,
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440]
};

function displayDimensions(width, height, rotation = 0) {
  const quarterTurns = Math.abs(Math.round(Number(rotation || 0) / 90)) % 2;
  return quarterTurns ? { width: height, height: width } : { width, height };
}

function fitDimensions(width, height, resolution) {
  const bounds = RESOLUTION_PRESETS[resolution];
  if (!bounds) return { width, height };
  const scale = Math.min(bounds[0] / width, bounds[1] / height);
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2)
  };
}

module.exports = {
  parseFrameRate,
  frameRatePreserved,
  RESOLUTION_PRESETS,
  displayDimensions,
  fitDimensions
};
