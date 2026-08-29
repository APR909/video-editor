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
  return clips.reduce((sum, c) => sum + Math.max(0, c.trimEnd - c.trimStart), 0);
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
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const len = clip.trimEnd - clip.trimStart;
    if (t < acc + len || i === clips.length - 1) {
      const local = clip.trimStart + Math.max(0, Math.min(len, t - acc));
      return { index: i, localTime: local, clipGlobalStart: acc };
    }
    acc += len;
  }
  return { index: -1, localTime: 0, clipGlobalStart: 0 };
}

function clipGlobalStart(index) {
  let acc = 0;
  for (let i = 0; i < index; i++) acc += clips[i].trimEnd - clips[i].trimStart;
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
  }
  sourceVideo.currentTime = localTime;
  await new Promise((resolve) => { sourceVideo.onseeked = resolve; });
}

function drawCurrentFrame() {
  const w = canvas.width, h = canvas.height;
  ctx.save();
  ctx.filter = getCanvasFilter();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  if (sourceVideo.readyState >= 2) {
    // letterbox to fit while preserving aspect ratio
    const vw = sourceVideo.videoWidth || w, vh = sourceVideo.videoHeight || h;
    const scale = Math.min(w / vw, h / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.drawImage(sourceVideo, (w - dw) / 2, (h - dh) / 2, dw, dh);
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

    for (const clip of clips) {
      const clipLen = clip.trimEnd - clip.trimStart;
      const globalStart = processedDuration;

      // ---- video frames ----
      const decodable = await clip.videoTrack.canDecode();
      if (decodable) {
        const sink = new VideoSampleSink(clip.videoTrack);
        for await (const sample of sink.samples(clip.trimStart, clip.trimEnd)) {
          exportCtx.save();
          exportCtx.filter = getCanvasFilter();
          exportCtx.fillStyle = "#000";
          exportCtx.fillRect(0, 0, outWidth, outHeight);
          const scale = Math.min(outWidth / sample.displayWidth, outHeight / sample.displayHeight);
          const dw = sample.displayWidth * scale, dh = sample.displayHeight * scale;
          sample.draw(exportCtx, (outWidth - dw) / 2, (outHeight - dh) / 2, dw, dh);
          exportCtx.restore();

          const globalTime = globalStart + (sample.timestamp - clip.trimStart);
          drawOverlaysOnContext(exportCtx, outWidth, outHeight, globalTime);

          const outTimestamp = globalStart + Math.max(0, sample.timestamp - clip.trimStart);
          await videoSource.add(outTimestamp, sample.duration);
          sample.close();

          processedDuration = Math.min(totalDuration, globalStart + Math.max(0, sample.timestamp - clip.trimStart));
          setExportProgress(totalDuration ? processedDuration / totalDuration : 0);
        }
      }

      // ---- audio ----
      if (audioSource) {
        const audioTrack = await clip.input.getPrimaryAudioTrack();
        const audioDecodable = audioTrack && (await audioTrack.canDecode());
        if (audioDecodable) {
          const sink = new AudioSampleSink(audioTrack);
          for await (const sample of sink.samples(clip.trimStart, clip.trimEnd)) {
            await audioSource.add(sample.toAudioBuffer());
            sample.close();
          }
        } else {
          await audioSource.add(await silentAudioBuffer(clipLen, targetSampleRate, targetChannels));
        }
      }

      processedDuration = globalStart + clipLen;
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
