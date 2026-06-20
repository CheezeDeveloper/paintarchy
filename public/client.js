// ===================================================================
// PAINTARCHY - CLIENT
// Uses an OFFSCREEN canvas (full 3000x3000) as the source of truth.
// The VIEW canvas is only as big as the visible area on screen.
// We blit the relevant portion of the offscreen canvas to the view.
// This means the DOM never holds a 3000x3000 element - only the
// offscreen (in memory) ImageData does.
// ===================================================================

// ===== SOCKET =====
const socket = io({ transports: ['websocket', 'polling'] });

// ===== OFFSCREEN CANVAS (full virtual canvas) =====
let CANVAS_W = 3000;
let CANVAS_H = 3000;
const offscreen = document.createElement('canvas');
const offCtx = offscreen.getContext('2d');

// ===== VIEW CANVAS (only what fits on screen) =====
const viewCanvas = document.getElementById('view-canvas');
const viewCtx = viewCanvas.getContext('2d');

// ===== VIEWPORT STATE =====
// panX/panY = top-left corner of the view in offscreen coordinates
let panX = 0;
let panY = 0;
let scale = 1; // pixels per offscreen pixel

// ===== TOOL STATE =====
let currentColor = '#ff0000';
let brushSize = 4;
let currentTool = 'brush';
let isDrawing = false;
let lastX = null; // in offscreen coords
let lastY = null;
let recentColors = [];

// Stroke sending
let currentStrokeId = null;
let strokeBuffer = [];
let strokeFlushTimer = null;
let isFirstSegment = true;

// Remote stroke last-point tracking: strokeId -> {x, y}
const remoteStrokes = new Map();

// Panning
let isPanning = false;
let panStartMouseX = 0, panStartMouseY = 0;
let panStartX = 0, panStartY = 0;

// ===== WIN98 PALETTE =====
const PALETTE = [
  '#000000','#808080','#800000','#808000',
  '#008000','#008080','#000080','#800080',
  '#c0c0c0','#ffffff','#ff0000','#ffff00',
  '#00ff00','#00ffff','#0000ff','#ff00ff',
  '#ff8040','#804000','#004000','#004040',
  '#0040ff','#8000ff','#ff0080','#808040',
];

// ===== UI REFS =====
const colorPicker       = document.getElementById('color-picker');
const brushSizeInput    = document.getElementById('brush-size');
const brushSizeLabel    = document.getElementById('brush-size-label');
const statusCoords      = document.getElementById('status-coords');
const statusTool        = document.getElementById('status-tool');
const statusSize        = document.getElementById('status-size');
const statusUsers       = document.getElementById('status-users');
const statusConn        = document.getElementById('status-conn');
const recentColorsEl    = document.getElementById('recent-colors');
const paletteEl         = document.getElementById('palette');
const loadingOverlay    = document.getElementById('loading-overlay');
const loadingBar        = document.getElementById('loading-bar');
const loadingLabel      = document.getElementById('loading-label');
const toastWindow       = document.getElementById('toast-window');
const toastText         = document.getElementById('toast-text');
const helpDialog        = document.getElementById('help-dialog');
const canvasArea        = document.getElementById('canvas-area');

// ===================================================================
// INIT
// ===================================================================

function initOffscreen() {
  offscreen.width = CANVAS_W;
  offscreen.height = CANVAS_H;
  offCtx.fillStyle = '#ffffff';
  offCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

function resizeViewCanvas() {
  viewCanvas.width  = canvasArea.clientWidth;
  viewCanvas.height = canvasArea.clientHeight;
  renderView();
}

// ===================================================================
// RENDER - blit offscreen -> view
// ===================================================================
function renderView() {
  const vw = viewCanvas.width;
  const vh = viewCanvas.height;

  viewCtx.save();
  viewCtx.fillStyle = '#808080';
  viewCtx.fillRect(0, 0, vw, vh);

  // Source rect in offscreen coords
  const srcW = vw / scale;
  const srcH = vh / scale;

  // Clamp pan so we don't go out of bounds
  panX = Math.max(0, Math.min(panX, CANVAS_W - srcW));
  panY = Math.max(0, Math.min(panY, CANVAS_H - srcH));

  // Draw the offscreen portion into view
  viewCtx.drawImage(
    offscreen,
    panX, panY,         // source x, y
    srcW, srcH,         // source w, h
    0, 0,               // dest x, y
    vw, vh              // dest w, h
  );

  viewCtx.restore();
}

// ===================================================================
// COORDINATE CONVERSION
// ===================================================================

// View (screen) coords -> offscreen canvas coords
function viewToOff(vx, vy) {
  return {
    x: panX + vx / scale,
    y: panY + vy / scale
  };
}

// ===================================================================
// DRAWING ON OFFSCREEN
// ===================================================================

function offDrawDot(x, y, color, size) {
  const half = Math.floor(size / 2);
  offCtx.fillStyle = color;
  offCtx.fillRect(Math.floor(x) - half, Math.floor(y) - half, size, size);
}

function offDrawLine(x0, y0, x1, y1, color, size) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(Math.ceil(dist), 1);
  const half = Math.floor(size / 2);
  offCtx.fillStyle = color;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    offCtx.fillRect(x - half, y - half, size, size);
  }
}

// Replay a received remote segment
function replaySegment(points, color, size, prevPoint) {
  if (points.length === 0) return;
  const half = Math.floor(size / 2);
  offCtx.fillStyle = color;

  function dot(x, y) {
    offCtx.fillRect(Math.floor(x) - half, Math.floor(y) - half, size, size);
  }
  function line(x0, y0, x1, y1) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(Math.ceil(dist), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      dot(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t));
    }
  }

  const all = (prevPoint && !isNaN(prevPoint.x)) ? [prevPoint, ...points] : points;

  if (all.length === 1) {
    dot(all[0].x, all[0].y);
  } else {
    for (let i = 1; i < all.length; i++) {
      line(all[i-1].x, all[i-1].y, all[i].x, all[i].y);
    }
  }
}

// ===================================================================
// FLOOD FILL
// ===================================================================

function floodFill(startX, startY, fillColor) {
  startX = Math.floor(startX);
  startY = Math.floor(startY);
  if (startX < 0 || startX >= CANVAS_W || startY < 0 || startY >= CANVAS_H) return;

  const imageData = offCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
  const data = imageData.data;

  const idx = (x, y) => (y * CANVAS_W + x) * 4;
  const si = idx(startX, startY);
  const sr = data[si], sg = data[si+1], sb = data[si+2];

  const [fr, fg, fb] = hexToRgb(fillColor);
  if (sr === fr && sg === fg && sb === fb) return;

  const stack = [[startX, startY]];
  const visited = new Uint8Array(CANVAS_W * CANVAS_H);
  const changed = [];

  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= CANVAS_W || y < 0 || y >= CANVAS_H) continue;
    const vi = y * CANVAS_W + x;
    if (visited[vi]) continue;
    visited[vi] = 1;
    const i = idx(x, y);
    if (data[i] !== sr || data[i+1] !== sg || data[i+2] !== sb) continue;
    data[i] = fr; data[i+1] = fg; data[i+2] = fb; data[i+3] = 255;
    changed.push({ x, y });
    stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
  }

  offCtx.putImageData(imageData, 0, 0);
  renderView();

  for (let i = 0; i < changed.length; i += 500) {
    socket.emit('fill:place', { pixels: changed.slice(i, i+500), color: fillColor });
  }
}

// ===================================================================
// EYEDROPPER
// ===================================================================

function pickColor(ox, oy) {
  const x = Math.max(0, Math.min(CANVAS_W - 1, Math.floor(ox)));
  const y = Math.max(0, Math.min(CANVAS_H - 1, Math.floor(oy)));
  const p = offCtx.getImageData(x, y, 1, 1).data;
  const c = rgbToHex(p[0], p[1], p[2]);
  currentColor = c;
  colorPicker.value = c;
  addRecentColor(c);
  setTool('brush');
  showToast('Color picked: ' + c);
}

// ===================================================================
// STROKE BUFFERING -> SERVER
// ===================================================================

function flushStroke() {
  if (!currentStrokeId || strokeBuffer.length === 0) return;
  socket.emit('stroke:segment', {
    strokeId: currentStrokeId,
    points: [...strokeBuffer],
    color: currentTool === 'eraser' ? '#ffffff' : currentColor,
    size: brushSize,
    isFirst: isFirstSegment
  });
  isFirstSegment = false;
  // Keep last point as bridge to next segment
  strokeBuffer = [strokeBuffer[strokeBuffer.length - 1]];
}

function scheduleFlush() {
  if (!strokeFlushTimer) {
    strokeFlushTimer = setTimeout(() => {
      flushStroke();
      strokeFlushTimer = null;
    }, 25);
  }
}

// ===================================================================
// TOOLS
// ===================================================================

function setTool(tool) {
  currentTool = tool;
  document.querySelectorAll('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  const names = { brush:'Brush', eraser:'Eraser', fill:'Fill', eyedropper:'Color Picker' };
  statusTool.textContent = 'Tool: ' + (names[tool] || tool);

  switch (tool) {
    case 'fill':       canvasArea.style.cursor = 'cell'; break;
    case 'eyedropper': canvasArea.style.cursor = 'crosshair'; break;
    default:           canvasArea.style.cursor = 'crosshair';
  }
}

// ===================================================================
// PALETTE
// ===================================================================

PALETTE.forEach(color => {
  const s = document.createElement('div');
  s.className = 'palette-swatch';
  s.style.background = color;
  s.title = color;
  s.addEventListener('click', () => { currentColor = color; colorPicker.value = color; });
  paletteEl.appendChild(s);
});

function addRecentColor(color) {
  if (recentColors[0] === color) return;
  recentColors = [color, ...recentColors.filter(c => c !== color)].slice(0, 8);
  renderRecent();
}

function renderRecent() {
  recentColorsEl.innerHTML = '';
  recentColors.forEach(color => {
    const s = document.createElement('div');
    s.className = 'recent-swatch';
    s.style.background = color;
    s.title = color;
    s.addEventListener('click', () => { currentColor = color; colorPicker.value = color; });
    recentColorsEl.appendChild(s);
  });
}

// ===================================================================
// TOAST
// ===================================================================

let toastTimer = null;
function showToast(msg, duration = 3000) {
  toastText.textContent = msg;
  toastWindow.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastWindow.style.display = 'none'; }, duration);
}

// ===================================================================
// ZOOM / PAN
// ===================================================================

function zoomAt(vx, vy, factor) {
  // vx, vy = view-space pivot point
  const offPivotX = panX + vx / scale;
  const offPivotY = panY + vy / scale;

  scale = Math.min(Math.max(scale * factor, 0.2), 12);

  panX = offPivotX - vx / scale;
  panY = offPivotY - vy / scale;

  renderView();
}

// ===================================================================
// MOUSE EVENTS
// ===================================================================

canvasArea.addEventListener('mousedown', (e) => {
  e.preventDefault();

  if (e.button === 1 || e.button === 2) {
    isPanning = true;
    panStartMouseX = e.clientX;
    panStartMouseY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    canvasArea.style.cursor = 'move';
    return;
  }

  if (e.button !== 0) return;

  const rect = canvasArea.getBoundingClientRect();
  const vx = e.clientX - rect.left;
  const vy = e.clientY - rect.top;
  const { x, y } = viewToOff(vx, vy);

  if (x < 0 || x >= CANVAS_W || y < 0 || y >= CANVAS_H) return;

  if (currentTool === 'eyedropper') { pickColor(x, y); return; }
  if (currentTool === 'fill')       { floodFill(x, y, currentColor); return; }

  isDrawing = true;
  lastX = x;
  lastY = y;
  currentStrokeId = Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  isFirstSegment = true;
  strokeBuffer = [{ x: Math.floor(x), y: Math.floor(y) }];

  const color = currentTool === 'eraser' ? '#ffffff' : currentColor;
  offDrawDot(x, y, color, brushSize);
  renderView();
  scheduleFlush();
});

canvasArea.addEventListener('mousemove', (e) => {
  const rect = canvasArea.getBoundingClientRect();
  const vx = e.clientX - rect.left;
  const vy = e.clientY - rect.top;
  const { x, y } = viewToOff(vx, vy);

  statusCoords.textContent = `X: ${Math.floor(x)}, Y: ${Math.floor(y)}`;

  if (isPanning) {
    const dx = (e.clientX - panStartMouseX) / scale;
    const dy = (e.clientY - panStartMouseY) / scale;
    panX = panStartX - dx;
    panY = panStartY - dy;
    renderView();
    return;
  }

  if (!isDrawing) return;
  if (currentTool !== 'brush' && currentTool !== 'eraser') return;

  const color = currentTool === 'eraser' ? '#ffffff' : currentColor;
  const cx = Math.floor(x), cy = Math.floor(y);
  const lx = Math.floor(lastX), ly = Math.floor(lastY);

  offDrawLine(lx, ly, cx, cy, color, brushSize);
  renderView();

  strokeBuffer.push({ x: cx, y: cy });
  scheduleFlush();

  lastX = x;
  lastY = y;
});

window.addEventListener('mouseup', (e) => {
  if (isPanning) {
    isPanning = false;
    setTool(currentTool);
    return;
  }
  if (!isDrawing) return;
  isDrawing = false;

  clearTimeout(strokeFlushTimer);
  strokeFlushTimer = null;
  flushStroke();
  strokeBuffer = [];
  currentStrokeId = null;
  lastX = null;
  lastY = null;
  addRecentColor(currentColor);
});

canvasArea.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvasArea.getBoundingClientRect();
  const vx = e.clientX - rect.left;
  const vy = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
  zoomAt(vx, vy, factor);
}, { passive: false });

canvasArea.addEventListener('contextmenu', e => e.preventDefault());

// ===================================================================
// KEYBOARD
// ===================================================================

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  switch (e.key.toLowerCase()) {
    case 'b': setTool('brush'); break;
    case 'e': setTool('eraser'); break;
    case 'f': setTool('fill'); break;
    case 'i': setTool('eyedropper'); break;
    case '[':
      brushSize = Math.max(1, brushSize - 1);
      brushSizeInput.value = brushSize;
      brushSizeLabel.textContent = brushSize;
      statusSize.textContent = 'Size: ' + brushSize + 'px';
      break;
    case ']':
      brushSize = Math.min(50, brushSize + 1);
      brushSizeInput.value = brushSize;
      brushSizeLabel.textContent = brushSize;
      statusSize.textContent = 'Size: ' + brushSize + 'px';
      break;
  }
});

// ===================================================================
// CONTROLS
// ===================================================================

colorPicker.addEventListener('input', e => { currentColor = e.target.value; });
colorPicker.addEventListener('change', e => { addRecentColor(e.target.value); });

brushSizeInput.addEventListener('input', e => {
  brushSize = parseInt(e.target.value);
  brushSizeLabel.textContent = brushSize;
  statusSize.textContent = 'Size: ' + brushSize + 'px';
});

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('mousedown', (e) => { e.stopPropagation(); setTool(btn.dataset.tool); });
});

// Menu toggles
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = item.classList.contains('open');
    document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('open'));
    if (!wasOpen) item.classList.add('open');
  });
});
window.addEventListener('click', () => {
  document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('open'));
});

document.getElementById('save-btn').addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'paintarchy.png';
  link.href = offscreen.toDataURL();
  link.click();
  showToast('Canvas saved as PNG.');
});

document.getElementById('zoom-in-btn').addEventListener('click', () =>
  zoomAt(viewCanvas.width / 2, viewCanvas.height / 2, 1.5));
document.getElementById('zoom-out-btn').addEventListener('click', () =>
  zoomAt(viewCanvas.width / 2, viewCanvas.height / 2, 1 / 1.5));
document.getElementById('zoom-reset-btn').addEventListener('click', () => {
  scale = 1; panX = 0; panY = 0; renderView();
});

document.getElementById('help-btn').addEventListener('click', () => {
  helpDialog.style.display = 'block';
});
document.getElementById('help-close').addEventListener('click', () => {
  helpDialog.style.display = 'none';
});
document.getElementById('help-ok').addEventListener('click', () => {
  helpDialog.style.display = 'none';
});

// ===================================================================
// RESIZE HANDLER
// ===================================================================

window.addEventListener('resize', resizeViewCanvas);

// ===================================================================
// SOCKET EVENTS
// ===================================================================

socket.on('connect', () => {
  statusConn.textContent = 'Connected';
  loadingLabel.textContent = 'Loading canvas data...';
});

socket.on('disconnect', () => {
  statusConn.textContent = 'Disconnected';
  showToast('Disconnected from server. Attempting to reconnect...', 5000);
});

socket.on('connect_error', (err) => {
  loadingLabel.textContent = 'Connection error: ' + err.message;
  statusConn.textContent = 'Error';
});

socket.on('canvas:meta', ({ width, height }) => {
  CANVAS_W = width;
  CANVAS_H = height;
  initOffscreen();
  loadingLabel.textContent = 'Receiving canvas pixels...';
});

let totalChunksReceived = 0;

socket.on('canvas:chunk', (pixels) => {
  // Draw chunk onto offscreen
  pixels.forEach(({ x, y, color }) => {
    offCtx.fillStyle = color;
    offCtx.fillRect(x, y, 1, 1);
  });
  totalChunksReceived += pixels.length;
  // Rough progress based on chunk count (we don't know total ahead of time)
  const progress = Math.min(90, totalChunksReceived / 100);
  loadingBar.style.width = progress + '%';
});

socket.on('canvas:done', () => {
  loadingBar.style.width = '100%';
  setTimeout(() => {
    loadingOverlay.style.display = 'none';
    resizeViewCanvas(); // size view canvas to fit, then render
    showToast('Welcome to Paintarchy. All is anarchy.');
  }, 200);
});

socket.on('stroke:segment', ({ strokeId, points, color, size, isFirst }) => {
  const prevPoint = (!isFirst && remoteStrokes.has(strokeId))
    ? remoteStrokes.get(strokeId)
    : null;

  replaySegment(points, color, size, prevPoint);

  if (points.length > 0) {
    remoteStrokes.set(strokeId, points[points.length - 1]);
  }

  renderView();

  // Prune old remote strokes
  if (remoteStrokes.size > 500) {
    const firstKey = remoteStrokes.keys().next().value;
    remoteStrokes.delete(firstKey);
  }
});

socket.on('fill:place', ({ pixels, color }) => {
  offCtx.fillStyle = color;
  pixels.forEach(({ x, y }) => offCtx.fillRect(x, y, 1, 1));
  renderView();
});

socket.on('users:count', (count) => {
  statusUsers.textContent = 'Users: ' + count;
});

// ===================================================================
// BOOT
// ===================================================================

// Init offscreen with defaults so we have something to show
initOffscreen();
// View canvas will be sized once canvas:done fires
// but set it up now so resize works
resizeViewCanvas();
