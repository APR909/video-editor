import {
  Input, ALL_FORMATS, BlobSource, CanvasSink,
  Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat,
  CanvasSource, AudioBufferSource, VideoSampleSink, AudioSampleSink,
  Quality, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
} from "./vendor/mediabunny.min.mjs";

// ============================================================
// STATE
// ============================================================
let clips = [];      // { id, file, input, videoTrack, duration, trimStart, trimEnd, thumbUrl, objectUrl, width, height }
let overlays = [];   // { id, text, start, end, color, position }
let nextClipId = 1;
let nextOverlayId = 1;

let activeClipIndex = -1;
let isPlaying = false;
let isSeeking = false;
let rafId = null;

// ============================================================
// DOM refs
// ============================================================
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileError = document.getElementById("file-error");
const loadingNote = document.getElementById("loading-note");

const timelinePanel = document.getElementById("timeline-panel");
const previewPanel = document.getElementById("preview-panel");
const fxPanel = document.getElementById("fx-panel");
const exportPanel = document.getElementById("export-panel");

const clipListEl = document.getElementById("clip-list");
const totalDurationEl = document.getElementById("total-duration");

const canvas = document.getElementById("preview-canvas");
const ctx = canvas.getContext("2d");
const sourceVideo = document.getElementById("source-video");
const sourceVideoB = document.getElementById("source-video-b");

const btnPlay = document.getElementById("btn-play");
const iconPlay = document.getElementById("icon-play");
const iconPause = document.getElementById("icon-pause");
const seekEl = document.getElementById("seek");
const timeCurrentEl = document.getElementById("time-current");
const timeDurationEl = document.getElementById("time-duration");

const overlayListEl = document.getElementById("overlay-list");
const btnAddOverlay = document.getElementById("btn-add-overlay");

const filterPresetEl = document.getElementById("filter-preset");
const filterBrightnessEl = document.getElementById("filter-brightness");
const filterContrastEl = document.getElementById("filter-contrast");
const filterSaturateEl = document.getElementById("filter-saturate");

// ============================================================
// IMPORT
// ============================================================
dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) importFiles([...fileInput.files]);
  fileInput.value = "";
});
["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("drag-over"); })
);
dropzone.addEventListener("drop", (e) => {
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("video/"));
  if (files.length) importFiles(files);
});

async function importFiles(files) {
  fileError.classList.add("hidden");
  loadingNote.classList.remove("hidden");

  for (const file of files) {
    if (!file.type.startsWith("video/")) continue;
    try {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) throw new Error("no video track");

      const duration = await input.computeDuration();
      const width = await videoTrack.getDisplayWidth();
      const height = await videoTrack.getDisplayHeight();

      // thumbnail — a bit into the clip so it's rarely a black opening frame
      const thumbSink = new CanvasSink(videoTrack, { width: 160 });
      const thumbT = Math.min(duration * 0.1, 1);
      const thumbResult = await thumbSink.getCanvas(thumbT);
      const thumbUrl = thumbResult ? thumbResult.canvas.toDataURL("image/jpeg", 0.8) : "";

      const objectUrl = URL.createObjectURL(file);

      clips.push({
        id: nextClipId++,
        file, input, videoTrack, duration, width, height,
        trimStart: 0, trimEnd: duration,
        thumbUrl, objectUrl,
        volume: 1, muted: false,
        transitionOut: 0,
      });
    } catch (err) {
      fileError.textContent = `No se ha podido leer "${file.name}". Prueba con otro archivo.`;
      fileError.classList.remove("hidden");
    }
  }

  loadingNote.classList.add("hidden");
  if (clips.length) {
    timelinePanel.classList.remove("hidden");
    previewPanel.classList.remove("hidden");
    fxPanel.classList.remove("hidden");
    exportPanel.classList.remove("hidden");
    renderTimeline();
    resetPlayhead();
  }
}

// ============================================================
// TIMELINE
// ============================================================
function formatTime(sec) {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function getTotalDuration() {
  let total = 0;
  clips.forEach((c, i) => {
    total += Math.max(0, c.trimEnd - c.trimStart);
    if (i < clips.length - 1) total -= (c.transitionOut || 0);
  });
  return Math.max(0, total);
}

function renderTimeline() {
  clipListEl.innerHTML = "";
  clips.forEach((clip, i) => {
    const row = document.createElement("div");
    row.className = "clip-row";
    row.innerHTML = `
      <img class="clip-thumb" src="${clip.thumbUrl}" alt="">
      <div class="clip-info">
        <p class="clip-name">${clip.file.name}</p>
        <div class="clip-trim">
          <input type="number" class="trim-start" min="0" step="0.1" value="${clip.trimStart.toFixed(1)}">
          <span>→</span>
          <input type="number" class="trim-end" min="0" step="0.1" value="${clip.trimEnd.toFixed(1)}">
          <span>de ${formatTime(clip.duration)}</span>
        </div>
        <div class="clip-audio">
          <button class="btn-mute ${clip.muted ? "is-muted" : ""}" title="${clip.muted ? "Activar sonido" : "Silenciar"}">
            <svg class="icon-vol-on" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 8a5 5 0 0 1 0 8M18.5 5.5a9 9 0 0 1 0 13"/></svg>
            <svg class="icon-vol-off" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>
          </button>
          <input type="range" class="clip-volume" min="0" max="1" step="0.05" value="${clip.volume}" ${clip.muted ? "disabled" : ""}>
        </div>
        ${i < clips.length - 1 ? `
        <div class="clip-transition">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12h4l3-7 4 14 3-7h2"/></svg>
          <input type="range" class="clip-trans" min="0" max="${Math.min(2, (clip.trimEnd - clip.trimStart) / 2, ((clips[i+1]?.trimEnd - clips[i+1]?.trimStart) || 2) / 2).toFixed(2)}" step="0.1" value="${clip.transitionOut}">
          <span class="trans-value mono">${clip.transitionOut.toFixed(1)}s</span>
        </div>` : ""}
      </div>
      <div class="clip-actions">
        <button class="btn-up" title="Mover arriba" ${i === 0 ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        </button>
        <button class="btn-down" title="Mover abajo" ${i === clips.length - 1 ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
        </button>
        <button class="btn-remove danger" title="Quitar clip">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
        </button>
      </div>
    `;

    row.querySelector(".trim-start").addEventListener("change", (e) => {
      const v = Math.max(0, Math.min(clip.duration - 0.1, parseFloat(e.target.value) || 0));
      clip.trimStart = Math.min(v, clip.trimEnd - 0.1);
      e.target.value = clip.trimStart.toFixed(1);
      updateTotalDuration();
      resetPlayhead();
    });
    row.querySelector(".trim-end").addEventListener("change", (e) => {
      const v = Math.max(0.1, Math.min(clip.duration, parseFloat(e.target.value) || clip.duration));
      clip.trimEnd = Math.max(v, clip.trimStart + 0.1);
      e.target.value = clip.trimEnd.toFixed(1);
      updateTotalDuration();
      resetPlayhead();
    });
    row.querySelector(".btn-up").addEventListener("click", () => {
      if (i === 0) return;
      [clips[i - 1], clips[i]] = [clips[i], clips[i - 1]];
      renderTimeline();
      resetPlayhead();
    });
    row.querySelector(".btn-down").addEventListener("click", () => {
      if (i === clips.length - 1) return;
      [clips[i + 1], clips[i]] = [clips[i], clips[i + 1]];
      renderTimeline();
      resetPlayhead();
    });
    row.querySelector(".btn-remove").addEventListener("click", () => {
      URL.revokeObjectURL(clip.objectUrl);
      clips.splice(i, 1);
      renderTimeline();
      if (!clips.length) {
        [timelinePanel, previewPanel, fxPanel, exportPanel].forEach((p) => p.classList.add("hidden"));
      } else {
        resetPlayhead();
      }
    });
    row.querySelector(".btn-mute").addEventListener("click", () => {
      clip.muted = !clip.muted;
      renderTimeline();
      applyActiveClipVolume();
    });
    row.querySelector(".clip-volume").addEventListener("input", (e) => {
      clip.volume = parseFloat(e.target.value);
      applyActiveClipVolume();
    });
    const transEl = row.querySelector(".clip-trans");
    if (transEl) {
      transEl.addEventListener("input", (e) => {
        clip.transitionOut = parseFloat(e.target.value);
        row.querySelector(".trans-value").textContent = `${clip.transitionOut.toFixed(1)}s`;
        updateTotalDuration();
      });
    }

    clipListEl.appendChild(row);
  });
  updateTotalDuration();
}

function updateTotalDuration() {
  const total = getTotalDuration();
  totalDurationEl.textContent = formatTime(total);
  seekEl.max = total;
  timeDurationEl.textContent = formatTime(total);
}

// ============================================================
// TEXT OVERLAYS
// ============================================================
btnAddOverlay.addEventListener("click", () => {
  overlays.push({
    id: nextOverlayId++,
    text: "Texto",
    start: 0,
    end: Math.min(3, getTotalDuration() || 3),
    color: "#ffffff",
    position: "bottom",
  });
  renderOverlays();
});

function renderOverlays() {
  overlayListEl.innerHTML = "";
  overlays.forEach((ov) => {
    const row = document.createElement("div");
    row.className = "overlay-row";
    row.innerHTML = `
      <input type="text" class="ov-text" value="${ov.text.replace(/"/g, "&quot;")}" placeholder="Texto del rótulo">
      <input type="number" class="ov-start" min="0" step="0.1" value="${ov.start.toFixed(1)}" title="Inicio (s)">
      <span class="mono" style="color:var(--ink-soft);font-size:0.75rem;">→</span>
      <input type="number" class="ov-end" min="0" step="0.1" value="${ov.end.toFixed(1)}" title="Fin (s)">
      <select class="ov-position">
        <option value="top" ${ov.position === "top" ? "selected" : ""}>Arriba</option>
        <option value="center" ${ov.position === "center" ? "selected" : ""}>Centro</option>
        <option value="bottom" ${ov.position === "bottom" ? "selected" : ""}>Abajo</option>
      </select>
      <input type="color" class="ov-color" value="${ov.color}">
      <button class="overlay-remove" title="Quitar rótulo">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    `;
    row.querySelector(".ov-text").addEventListener("input", (e) => { ov.text = e.target.value; });
    row.querySelector(".ov-start").addEventListener("change", (e) => { ov.start = Math.max(0, parseFloat(e.target.value) || 0); });
    row.querySelector(".ov-end").addEventListener("change", (e) => { ov.end = Math.max(ov.start + 0.1, parseFloat(e.target.value) || ov.start + 1); });
    row.querySelector(".ov-position").addEventListener("change", (e) => { ov.position = e.target.value; });
    row.querySelector(".ov-color").addEventListener("input", (e) => { ov.color = e.target.value; });
    row.querySelector(".overlay-remove").addEventListener("click", () => {
      overlays = overlays.filter((o) => o.id !== ov.id);
      renderOverlays();
    });
    overlayListEl.appendChild(row);
  });
}

// ============================================================
// FILTERS
// ============================================================
const FILTER_PRESETS = {
  none: { brightness: 100, contrast: 100, saturate: 100 },
  warm: { brightness: 108, contrast: 105, saturate: 118 },
  cool: { brightness: 100, contrast: 108, saturate: 88 },
  bw: { brightness: 105, contrast: 112, saturate: 0 },
};

function applyPreset(name) {
  const p = FILTER_PRESETS[name];
  if (!p) return;
  filterBrightnessEl.value = p.brightness;
  filterContrastEl.value = p.contrast;
  filterSaturateEl.value = p.saturate;
}

filterPresetEl.addEventListener("change", () => {
  if (filterPresetEl.value !== "custom") applyPreset(filterPresetEl.value);
});
[filterBrightnessEl, filterContrastEl, filterSaturateEl].forEach((el) => {
  el.addEventListener("input", () => { filterPresetEl.value = "custom"; });
});

function getCanvasFilter() {
  return `brightness(${filterBrightnessEl.value}%) contrast(${filterContrastEl.value}%) saturate(${filterSaturateEl.value}%)`;
}

// ============================================================
// TIMELINE MATH — convert a global playhead time into
// (clip index, local time within that clip's source file)
// ============================================================
function globalTimeToClip(t) {
  for (let i = clips.length - 1; i >= 0; i--) {
    const start = clipGlobalStart(i);
    if (t >= start || i === 0) {
      const len = clips[i].trimEnd - clips[i].trimStart;
      const local = clips[i].trimStart + Math.max(0, Math.min(len, t - start));
      return { index: i, localTime: local, clipGlobalStart: start };
    }
  }
  return { index: -1, localTime: 0, clipGlobalStart: 0 };
}

function clipGlobalStart(index) {
  let acc = 0;
  for (let i = 0; i < index; i++) {
    acc += clips[i].trimEnd - clips[i].trimStart;
    acc -= (clips[i].transitionOut || 0);
  }
  return acc;
}

// ============================================================
// OVERLAY DRAWING
// ============================================================
function drawOverlaysAt(globalTime) {
  drawOverlaysOnContext(ctx, canvas.width, canvas.height, globalTime);
}

// ============================================================
// PREVIEW PLAYBACK
// ============================================================
function applyActiveClipVolume() {
  const clip = clips[activeClipIndex];
  if (!clip) return;
  sourceVideo.volume = clip.muted ? 0 : clip.volume;
}

function resetPlayhead() {
  isPlaying = false;
  activeClipIndex = -1;
  iconPlay.classList.remove("hidden");
  iconPause.classList.add("hidden");
  cancelAnimationFrame(rafId);
  seekEl.value = 0;
  timeCurrentEl.textContent = "0:00";
  updateTotalDuration();
  seekToGlobalTime(0).then(() => drawCurrentFrame());
}

async function seekToGlobalTime(t) {
  const { index, localTime } = globalTimeToClip(t);
  if (index === -1) return;
  if (index !== activeClipIndex) {
    activeClipIndex = index;
    sourceVideo.src = clips[index].objectUrl;
    await new Promise((resolve) => {
      sourceVideo.onloadedmetadata = resolve;
    });
    applyActiveClipVolume();
    transitionPrepared = false;
    preloadedForClip = -1;
    sourceVideoB.pause();
  }
  sourceVideo.currentTime = localTime;
  await new Promise((resolve) => { sourceVideo.onseeked = resolve; });
}

let transitionPrepared = false;
let preloadedForClip = -1; // which clip index we've already preloaded sourceVideoB for

function drawVideoLetterboxed(video, w, h, alpha) {
  if (video.readyState < 2 || alpha <= 0) return;
  const vw = video.videoWidth || w, vh = video.videoHeight || h;
  const scale = Math.min(w / vw, h / vh);
  const dw = vw * scale, dh = vh * scale;
  ctx.globalAlpha = alpha;
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.globalAlpha = 1;
}

// loads the next clip's metadata into sourceVideoB well ahead of the actual
// transition window, so activating it later is just a quick seek — without
// this, the network+decode delay of a cold load eats into the blend itself
function preloadNextClipForTransition() {
  const clip = clips[activeClipIndex];
  if (!clip || !clip.transitionOut || activeClipIndex >= clips.length - 1) return;
  if (preloadedForClip === activeClipIndex) return;
  preloadedForClip = activeClipIndex;
  sourceVideoB.src = clips[activeClipIndex + 1].objectUrl;
  sourceVideoB.load();
}

async function activateTransition() {
  transitionPrepared = true;
  const nextClip = clips[activeClipIndex + 1];
  if (!nextClip) return;
  if (sourceVideoB.readyState < 1) {
    await new Promise((resolve) => { sourceVideoB.onloadedmetadata = resolve; });
  }
  sourceVideoB.currentTime = nextClip.trimStart;
  await new Promise((resolve) => { sourceVideoB.onseeked = resolve; });
  if (isPlaying) sourceVideoB.play().catch(() => {});
}

function drawCurrentFrame() {
  const w = canvas.width, h = canvas.height;
  ctx.save();
  ctx.filter = getCanvasFilter();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const clip = clips[activeClipIndex];
  const transDur = clip ? (clip.transitionOut || 0) : 0;
  const hasNext = activeClipIndex >= 0 && activeClipIndex < clips.length - 1;
  const timeLeft = clip ? clip.trimEnd - sourceVideo.currentTime : Infinity;
  const inTransition = hasNext && transDur > 0 && timeLeft <= transDur && timeLeft > -0.2;
  // start preloading a little before the window opens, not right when it does
  if (hasNext && transDur > 0 && timeLeft <= transDur + 0.6) preloadNextClipForTransition();

  if (inTransition) {
    if (!transitionPrepared) activateTransition();
    const p = Math.max(0, Math.min(1, 1 - timeLeft / transDur));
    drawVideoLetterboxed(sourceVideo, w, h, 1 - p);
    drawVideoLetterboxed(sourceVideoB, w, h, p);
  } else {
    if (transitionPrepared) { sourceVideoB.pause(); transitionPrepared = false; }
    if (sourceVideo.readyState >= 2) drawVideoLetterboxed(sourceVideo, w, h, 1);
  }

  ctx.restore();
  const globalTime = clipGlobalStart(activeClipIndex) + (sourceVideo.currentTime - (clips[activeClipIndex]?.trimStart || 0));
  drawOverlaysAt(globalTime);
}

btnPlay.addEventListener("click", async () => {
  if (!clips.length) return;
  if (isPlaying) {
    isPlaying = false;
    sourceVideo.pause();
    iconPlay.classList.remove("hidden");
    iconPause.classList.add("hidden");
    cancelAnimationFrame(rafId);
    return;
  }
  if (activeClipIndex === -1) await seekToGlobalTime(0);
  isPlaying = true;
  iconPlay.classList.add("hidden");
  iconPause.classList.remove("hidden");
  await sourceVideo.play();
  playLoop();
});

function playLoop() {
  if (!isPlaying) return;
  const clip = clips[activeClipIndex];
  if (clip && sourceVideo.currentTime >= clip.trimEnd - 0.03) {
    advanceToNextClip();
    return;
  }
  const globalTime = clipGlobalStart(activeClipIndex) + (sourceVideo.currentTime - clip.trimStart);
  if (!isSeeking) {
    seekEl.value = globalTime;
    timeCurrentEl.textContent = formatTime(globalTime);
  }
  drawCurrentFrame();
  rafId = requestAnimationFrame(playLoop);
}

async function advanceToNextClip() {
  sourceVideo.pause();
  if (activeClipIndex >= clips.length - 1) {
    isPlaying = false;
    iconPlay.classList.remove("hidden");
    iconPause.classList.add("hidden");
    await seekToGlobalTime(0);
    drawCurrentFrame();
    return;
  }
  activeClipIndex++;
  const clip = clips[activeClipIndex];
  sourceVideo.src = clip.objectUrl;
  await new Promise((resolve) => { sourceVideo.onloadedmetadata = resolve; });
  applyActiveClipVolume();
  transitionPrepared = false;
  preloadedForClip = -1;
  sourceVideoB.pause();
  sourceVideo.currentTime = clip.trimStart;
  await new Promise((resolve) => { sourceVideo.onseeked = resolve; });
  if (isPlaying) {
    await sourceVideo.play();
    rafId = requestAnimationFrame(playLoop);
  }
}

seekEl.addEventListener("input", () => {
  isSeeking = true;
  timeCurrentEl.textContent = formatTime(parseFloat(seekEl.value));
});
seekEl.addEventListener("change", async () => {
  const wasPlaying = isPlaying;
  if (wasPlaying) { sourceVideo.pause(); isPlaying = false; cancelAnimationFrame(rafId); }
  await seekToGlobalTime(parseFloat(seekEl.value));
  drawCurrentFrame();
  isSeeking = false;
  if (wasPlaying) {
    isPlaying = true;
    await sourceVideo.play();
    playLoop();
  } else {
    iconPlay.classList.remove("hidden");
    iconPause.classList.add("hidden");
  }
});

// ============================================================
// EXPORT — walks the timeline clip by clip, decoding real frames
// and audio via Mediabunny, drawing each frame (with filters and
// any active text overlay) onto an export canvas, and feeding the
// result into a new muxed video file for download.
// ============================================================
const btnExport = document.getElementById("btn-export");
const exportStatusEl = document.getElementById("export-status");
const exportProgressWrap = document.getElementById("export-progress-wrap");
const exportProgressBar = document.getElementById("export-progress-bar");

function setExportProgress(frac) {
  exportProgressWrap.classList.remove("hidden");
  exportProgressBar.style.width = `${Math.round(frac * 100)}%`;
}

async function silentAudioBuffer(seconds, sampleRate, numberOfChannels) {
  const ctx2 = new OfflineAudioContext(numberOfChannels, Math.ceil(seconds * sampleRate), sampleRate);
  return ctx2.createBuffer(numberOfChannels, Math.ceil(seconds * sampleRate), sampleRate);
}

btnExport.addEventListener("click", async () => {
  if (!clips.length) return;
  btnExport.disabled = true;
  exportStatusEl.className = "mono export-status";
  exportStatusEl.textContent = "Preparando…";
  setExportProgress(0);

  try {
    // pick the best video/audio codec this browser can actually encode,
    // and the matching container format — H.264+MP4 where available,
    // falling back to VP9/WebM (which is what my own test sandbox uses)
    const mp4Video = await getFirstEncodableVideoCodec(new Mp4OutputFormat().getSupportedVideoCodecs());
    const useMp4 = !!mp4Video;
    const outputFormat = useMp4 ? new Mp4OutputFormat() : new WebMOutputFormat();
    const videoCodec = useMp4 ? mp4Video : await getFirstEncodableVideoCodec(outputFormat.getSupportedVideoCodecs());
    const audioCodec = await getFirstEncodableAudioCodec(outputFormat.getSupportedAudioCodecs());

    const outWidth = clips[0].width;
    const outHeight = clips[0].height;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = outWidth;
    exportCanvas.height = outHeight;
    const exportCtx = exportCanvas.getContext("2d");

    const output = new Output({ format: outputFormat, target: new BufferTarget() });

    const videoSource = new CanvasSource(exportCanvas, { codec: videoCodec, quality: new Quality("high") });
    output.addVideoTrack(videoSource);

    let audioSource = null;
    let targetSampleRate = 44100, targetChannels = 2;
    if (audioCodec) {
      for (const clip of clips) {
        const track = await clip.input.getPrimaryAudioTrack();
        if (track) {
          targetSampleRate = await track.getSampleRate();
          targetChannels = await track.getNumberOfChannels();
          break;
        }
      }
      audioSource = new AudioBufferSource({ codec: audioCodec, quality: new Quality("high") });
      output.addAudioTrack(audioSource);
    }

    await output.start();

    const totalDuration = getTotalDuration();
    let processedDuration = 0;

    function drawCanvasLetterboxed(srcCanvas, w, h, alpha) {
      if (!srcCanvas || alpha <= 0) return;
      const scale = Math.min(w / srcCanvas.width, h / srcCanvas.height);
      const dw = srcCanvas.width * scale, dh = srcCanvas.height * scale;
      exportCtx.globalAlpha = alpha;
      exportCtx.drawImage(srcCanvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
      exportCtx.globalAlpha = 1;
    }

    for (let ci = 0; ci < clips.length; ci++) {
      const clip = clips[ci];
      const transIn = ci > 0 ? (clips[ci - 1].transitionOut || 0) : 0;
      const transOut = ci < clips.length - 1 ? (clip.transitionOut || 0) : 0;
      const globalStart = processedDuration;
      const normalStart = clip.trimStart + transIn;
      const normalEnd = clip.trimEnd - transOut;

      // ---- normal (non-blended) video frames ----
      const decodable = await clip.videoTrack.canDecode();
      if (decodable && normalEnd > normalStart) {
        const sink = new VideoSampleSink(clip.videoTrack);
        for await (const sample of sink.samples(normalStart, normalEnd)) {
          exportCtx.save();
          exportCtx.filter = getCanvasFilter();
          exportCtx.fillStyle = "#000";
          exportCtx.fillRect(0, 0, outWidth, outHeight);
          const scale = Math.min(outWidth / sample.displayWidth, outHeight / sample.displayHeight);
          const dw = sample.displayWidth * scale, dh = sample.displayHeight * scale;
          sample.draw(exportCtx, (outWidth - dw) / 2, (outHeight - dh) / 2, dw, dh);
          exportCtx.restore();

          const globalTime = globalStart + Math.max(0, sample.timestamp - normalStart);
          drawOverlaysOnContext(exportCtx, outWidth, outHeight, globalTime);

          const outTimestamp = globalStart + Math.max(0, sample.timestamp - normalStart);
          await videoSource.add(outTimestamp, sample.duration);
          sample.close();

          processedDuration = Math.max(processedDuration, outTimestamp);
          setExportProgress(totalDuration ? processedDuration / totalDuration : 0);
        }
      }

      // ---- cross-fade blend into the next clip ----
      if (transOut > 0 && ci < clips.length - 1) {
        const nextClip = clips[ci + 1];
        const fps = 20;
        const steps = Math.max(1, Math.round(transOut * fps));
        const thisSink = decodable ? new CanvasSink(clip.videoTrack, { width: outWidth }) : null;
        const nextDecodable = await nextClip.videoTrack.canDecode();
        const nextSink = nextDecodable ? new CanvasSink(nextClip.videoTrack, { width: outWidth }) : null;
        const blendStart = globalStart + (normalEnd - normalStart);

        for (let s = 0; s <= steps; s++) {
          const frac = s / steps;
          const tThis = clip.trimEnd - transOut + frac * transOut;
          const tNext = nextClip.trimStart + frac * transOut;

          exportCtx.save();
          exportCtx.filter = getCanvasFilter();
          exportCtx.fillStyle = "#000";
          exportCtx.fillRect(0, 0, outWidth, outHeight);

          const resThis = thisSink ? await thisSink.getCanvas(tThis) : null;
          drawCanvasLetterboxed(resThis ? resThis.canvas : null, outWidth, outHeight, 1 - frac);
          const resNext = nextSink ? await nextSink.getCanvas(tNext) : null;
          drawCanvasLetterboxed(resNext ? resNext.canvas : null, outWidth, outHeight, frac);
          exportCtx.restore();

          const globalTime = blendStart + frac * transOut;
          drawOverlaysOnContext(exportCtx, outWidth, outHeight, globalTime);

          const outTimestamp = blendStart + frac * transOut;
          await videoSource.add(outTimestamp, 1 / fps);

          processedDuration = Math.max(processedDuration, outTimestamp);
          setExportProgress(totalDuration ? processedDuration / totalDuration : 0);
        }
      }

      // ---- audio (skips the head portion already covered by the previous
      // clip's transition-out, so total audio length matches total video
      // length exactly — otherwise audio would run longer than video and
      // drift out of sync after every transition) ----
      if (audioSource) {
        const audioTrack = await clip.input.getPrimaryAudioTrack();
        const audioDecodable = audioTrack && (await audioTrack.canDecode());
        const clipVol = clip.muted ? 0 : clip.volume;
        const audioStart = clip.trimStart + transIn;
        const audioLen = Math.max(0, clip.trimEnd - audioStart);
        if (audioDecodable && audioLen > 0) {
          const sink = new AudioSampleSink(audioTrack);
          for await (const sample of sink.samples(audioStart, clip.trimEnd)) {
            const buf = sample.toAudioBuffer();
            if (clipVol !== 1) {
              for (let ch = 0; ch < buf.numberOfChannels; ch++) {
                const data = buf.getChannelData(ch);
                for (let i = 0; i < data.length; i++) data[i] *= clipVol;
                buf.copyToChannel(data, ch);
              }
            }
            await audioSource.add(buf);
            sample.close();
          }
        } else if (audioLen > 0) {
          await audioSource.add(await silentAudioBuffer(audioLen, targetSampleRate, targetChannels));
        }
      }

      processedDuration = globalStart + (normalEnd - normalStart) + transOut;
      setExportProgress(totalDuration ? processedDuration / totalDuration : 0);
    }

    await output.finalize();

    const buffer = output.target.buffer;
    const blob = new Blob([buffer], { type: outputFormat.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `video-editado.${useMp4 ? "mp4" : "webm"}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    exportStatusEl.textContent = "¡Listo! Descarga iniciada.";
    exportStatusEl.className = "mono export-status success";
  } catch (err) {
    exportStatusEl.textContent = "No se ha podido exportar. Prueba con otros clips.";
    exportStatusEl.className = "mono export-status error";
  } finally {
    btnExport.disabled = false;
  }
});

// shared overlay-drawing routine usable on any canvas context (preview or export)
function drawOverlaysOnContext(targetCtx, w, h, globalTime) {
  const active = overlays.filter((o) => globalTime >= o.start && globalTime < o.end && o.text.trim());
  if (!active.length) return;
  active.forEach((ov) => {
    const fontSize = Math.round(h * 0.06);
    targetCtx.font = `700 ${fontSize}px "Work Sans", sans-serif`;
    targetCtx.textAlign = "center";
    const y = ov.position === "top" ? fontSize * 1.6 : ov.position === "center" ? h / 2 : h - fontSize * 1.2;
    const metrics = targetCtx.measureText(ov.text);
    const padX = 20, padY = 12;
    targetCtx.fillStyle = "rgba(0,0,0,0.45)";
    targetCtx.fillRect(w / 2 - metrics.width / 2 - padX, y - fontSize, metrics.width + padX * 2, fontSize + padY);
    targetCtx.fillStyle = ov.color;
    targetCtx.textBaseline = "alphabetic";
    targetCtx.fillText(ov.text, w / 2, y);
  });
}
