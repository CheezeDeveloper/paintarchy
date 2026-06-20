// ===== SOCKET =====
const socket = io({
  transports: ['websocket'],
});

// ===== CANVAS =====
const canvas = document.getElementById('main-canvas');
const ctx = canvas.getContext('2d');
const canvasWrapper = document.getElementById('canvas-wrapper');
const canvasContainer = document.getElementById('canvas-container');

let CANVAS_W = 3000;
let CANVAS_H = 3000;

canvas.width = CANVAS_W;
canvas.height = CANVAS_H;
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

// ===== STATE =====
let currentColor = '#ff0000';
let brushSize = 4;
let currentTool = 'brush';
let isDrawing = false;
let lastX = null;
let lastY = null;
let recentColors = [];

// Pan/zoom
let scale = 1;
let panX = 0;
let panY = 0;
let isPanning = false;
let panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;

// Stroke tracking
// Each local stroke gets a unique ID so remote clients can track continuity
let currentStrokeId = null;
let strokePointBuffer = [];   // buffer of {x,y} to send
let strokeFlushTimer = null;
let isFirstSegment = false;

// Remote stroke tracking: strokeId -> last {x, y}
const remoteStrokes = new Map();

// ===== WIN98 PALETTE =====
const PALETTE = [
  '#000000','#808080','#800000','#808000',
  '#008000','#008080','#000080','#800080',
  '#c0c0c0','#ffffff','#ff0000','#ffff00',
  '#00ff00','#00ffff','#0000ff','#ff00ff',
  '#ff8040','#804000','#004000','#004040',
  '#0040ff','#8000ff','#ff0080','#ff8080',
];

// ===== UI REFS =====
const colorPicker     = document.getElementById('color-picker');
const brushSizeInput  = document.getElementById('brush-size');
const brushSizeLabel  = document.getElementById('brush-size-label');
const statusCoords    = document.getElementById('status-coords');
const statusTool      = document.getElementById('status-tool');
const statusSize      = document.getElementById('status-size');
const statusUsers     = document.getElementById('status-users');
const statusConn      = document.getElementById('status-conn');
const recentColorsEl  = document.getElementById('recent-colors');
const paletteEl       = document.getElementById('palette');
const loading         = document.getElementById('loading');
const loadingBar      = document.getElementById('loading-bar');
const toast           = document.getElementById('toast');
const toastBody       = document.getElementById('toast-body');
const helpDialog      = document.getElementById('help-dialog');

// ===== INIT PALETTE =====
PALETTE.forEach(color => {
  const s = document.createElement('div');
  s.className = 'palette-swatch';
  s.style.background = color;
  s.title = color;
  s.addEventListener('click', () => {
    currentColor = color;
    colorPicker.value = color;
  });
  paletteEl.appendChild(s);
});

// ===== TOAST =====
let toastTimer = null;
function showToast(msg, duration = 3000) {
  toastBody.textContent = msg;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, duration);
}

// ===== RECENT COLORS =====
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
    s.addEventListener('click', () => {
      currentColor = color;
      colorPicker.value = color;
    });
    recentColorsEl.appendChild(s);
  });
}

// ===== TRANSFORM =====
function applyTransform() {
  canvasContainer.style.transform =
    `translate(${panX}px, ${panY}px) scale(${scale})`;
}

function fitCanvas() {
  const ww = canvasWrapper.clientWidth;
  const wh = canvasWrapper.clientHeight;
  // Show a viewport-sized portion, 1:1 pixels initially
  scale = 1;
  // Start view at top-left of canvas
  panX = 4;
  panY = 4;
  applyTransform();
}

function zoomAt(cx, cy, factor) {
  const newScale = Math.min(Math.max(scale * factor, 0.1), 16);
  const ratio = newScale / scale;
  panX = cx - ratio * (cx - panX);
  panY = cy - ratio * (cy - panY);
  scale = newScale;
  applyTransform();
}

function getCanvasPos(clientX, clientY) {
  const rect = canvasWrapper.getBoundingClientRect();
  return {
    x: (clientX - rect.left - panX) / scale,
    y: (clientY - rect.top  - panY) / scale
  };
}

// ===== DRAWING PRIMITIVES =====
function drawDot(x, y, color, size) {
  const half = Math.floor(size / 2);
  ctx.fillStyle = color;
  ctx.fillRect(Math.floor(x) - half, Math.floor(y) - half, size, size);
}

// Draw line on local canvas, returns array of pixel positions covered
function drawLineLocal(x0, y0, x1, y1, color, size) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(Math.ceil(dist), 1);
  const half = Math.floor(size / 2);

  ctx.fillStyle = color;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    ctx.fillRect(x - half, y - half, size, size);
  }
}

// Replay a received segment on canvas
// prevPoint: {x,y} or null if isFirst
function replaySegment(points, color, size, prevPoint) {
  if (points.length === 0) return;

  ctx.fillStyle = color;
  const half = Math.floor(size / 2);

  function drawStep(x, y) {
    ctx.fillRect(Math.floor(x) - half, Math.floor(y) - half, size, size);
  }

  function drawSegLine(x0, y0, x1, y1) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(Math.ceil(dist), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      drawStep(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t));
    }
  }

  // Connect from previous point if not first segment
  const allPoints = prevPoint && !isNaN(prevPoint.x)
    ? [prevPoint, ...points]
    : points;

  if (allPoints.length === 1) {
    drawStep(allPoints[0].x, allPoints[0].y);
    return;
  }

  for (let i = 1; i < allPoints.length; i++) {
    drawSegLine(allPoints[i-1].x, allPoints[i-1].y, allPoints[i].x, allPoints[i].y);
  }
}

// ===== FLOOD FILL =====
function floodFill(startX, startY, fillColor) {
  startX = Math.floor(startX);
  startY = Math.floor(startY);

  const imageData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
  const data = imageData.data;

  function idx(x, y) { return (y * CANVAS_W + x) * 4; }

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

  ctx.putImageData(imageData, 0, 0);

  // Emit in batches of 500
  for (let i = 0; i < changed.length; i += 500) {
    socket.emit('fill:place', { pixels: changed.slice(i, i+500), color: fillColor });
  }
}

// ===== EYEDROPPER =====
function pickColor(x, y) {
  const p = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  currentColor = rgbToHex(p[0], p[1], p[2]);
  colorPicker.value = currentColor;
  addRecentColor(currentColor);
  setTool('brush');
  showToast('Color picked: ' + currentColor);
}

// ===== COLOR UTILS =====
function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1,3),16),
    parseInt(hex.slice(3,5),16),
    parseInt(hex.slice(5,7),16)
  ];
}
function rgbToHex(r,g,b) {
  return '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
}

// ===== STROKE BUFFERING (LOCAL -> SERVER) =====
// We send segments of points regularly so the server+others can replay smoothly.
// Key fix: each segment carries isFirst and the strokeId so receivers
// can stitch segments together without gaps.

function flushStroke() {
  if (strokePointBuffer.length === 0) return;
  socket.emit('stroke:segment', {
    strokeId: currentStrokeId,
    points: [...strokePointBuffer],
    color: currentTool === 'eraser' ? '#ffffff' : currentColor,
    size: brushSize,
    isFirst: isFirstSegment
  });
  isFirstSegment = false;
  // Keep last point as overlap so next segment connects seamlessly
  strokePointBuffer = [strokePointBuffer[strokePointBuffer.length - 1]];
}

function scheduleFlush() {
  if (!strokeFlushTimer) {
    strokeFlushTimer = setTimeout(() => {
      flushStroke();
      strokeFlushTimer = null;
    }, 30); // 30ms batching - low latency
  }
}

// ===== TOOL SELECTION =====
function setTool(tool) {
  currentTool = tool;
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });

  const toolNames = { brush:'Brush', eraser:'Eraser', fill:'Fill', eyedropper:'Color Picker' };
  statusTool.textContent = 'Tool: ' + (toolNames[tool] || tool);

  switch(tool) {
    case 'eyedropper': canvasWrapper.style.cursor = 'crosshair'; break;
    case 'fill':       canvasWrapper.style.cursor = 'cell'; break;
    default:           canvasWrapper.style.cursor = 'crosshair';
  }
}

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    setTool(btn.dataset.tool);
  });
});

// ===== COLOR / SIZE CONTROLS =====
colorPicker.addEventListener('input', e => { currentColor = e.target.value; });
colorPicker.addEventListener('change', e => { addRecentColor(e.target.value); });

brushSizeInput.addEventListener('input', e => {
  brushSize = parseInt(e.target.value);
  brushSizeLabel.textContent = brushSize;
  statusSize.textContent = 'Size: ' + brushSize + 'px';
});

// ===== MOUSE EVENTS =====
canvasWrapper.addEventListener('mousedown', (e) => {
  e.preventDefault();

  // Middle or right click -> pan
  if (e.button === 1 || e.button === 2) {
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOriginX = panX;
    panOriginY = panY;
    canvasWrapper.style.cursor = 'move';
    return;
  }

  if (e.button !== 0) return;

  const { x, y } = getCanvasPos(e.clientX, e.clientY);
  if (x < 0 || x >= CANVAS_W || y < 0 || y >= CANVAS_H) return;

  if (currentTool === 'eyedropper') { pickColor(x, y); return; }
  if (currentTool === 'fill')       { floodFill(x, y, currentColor); return; }

  // Start stroke
  isDrawing = true;
  lastX = x;
  lastY = y;
  currentStrokeId = Date.now() + '_' + Math.random().toString(36).slice(2);
  isFirstSegment = true;
  strokePointBuffer = [{ x: Math.floor(x), y: Math.floor(y) }];

  const color = currentTool === 'eraser' ? '#ffffff' : currentColor;
  drawDot(x, y, color, brushSize);
  scheduleFlush();
});

canvasWrapper.addEventListener('mousemove', (e) => {
  const { x, y } = getCanvasPos(e.clientX, e.clientY);
  statusCoords.textContent = `X: ${Math.floor(x)}, Y: ${Math.floor(y)}`;

  if (isPanning) {
    panX = panOriginX + (e.clientX - panStartX);
    panY = panOriginY + (e.clientY - panStartY);
    applyTransform();
    return;
  }

  if (!isDrawing) return;
  if (currentTool !== 'brush' && currentTool !== 'eraser') return;

  const color = currentTool === 'eraser' ? '#ffffff' : currentColor;
  const cx = Math.floor(x), cy = Math.floor(y);
  const lx = Math.floor(lastX), ly = Math.floor(lastY);

  // Draw locally
  drawLineLocal(lx, ly, cx, cy, color, brushSize);

  // Buffer for network
  strokePointBuffer.push({ x: cx, y: cy });
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

  // Flush remaining buffer
  clearTimeout(strokeFlushTimer);
  strokeFlushTimer = null;
  flushStroke();
  strokePointBuffer = [];
  currentStrokeId = null;

  addRecentColor(currentColor);
  lastX = null;
  lastY = null;
});

// Scroll to zoom
canvasWrapper.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : (1/1.15);
  zoomAt(e.clientX - canvasWrapper.getBoundingClientRect().left,
         e.clientY - canvasWrapper.getBoundingClientRect().top, factor);
}, { passive: false });

canvasWrapper.addEventListener('contextmenu', e => e.preventDefault());

// ===== KEYBOARD =====
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  switch(e.key.toLowerCase()) {
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

// ===== MENU =====
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
  link.href = canvas.toDataURL();
  link.click();
  showToast('Canvas saved as PNG.');
});

document.getElementById('zoom-in-btn').addEventListener('click', () => {
  zoomAt(canvasWrapper.clientWidth/2, canvasWrapper.clientHeight/2, 1.5);
});
document.getElementById('zoom-out-btn').addEventListener('click', () => {
  zoomAt(canvasWrapper.clientWidth/2, canvasWrapper.clientHeight/2, 1/1.5);
});
document.getElementById('zoom-reset-btn').addEventListener('click', fitCanvas);
document.getElementById('zoom-fit-btn').addEventListener('click', () => {
  const ww = canvasWrapper.clientWidth;
  const wh = canvasWrapper.clientHeight;
  const s = Math.min(ww / CANVAS_W, wh / CANVAS_H);
  scale = s;
  panX = (ww - CANVAS_W * s) / 2;
  panY = (wh - CANVAS_H * s) / 2;
  applyTransform();
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

// ===== SOCKET EVENTS =====
socket.on('connect', () => {
  statusConn.textContent = 'Connected';
});

socket.on('disconnect', () => {
  statusConn.textContent = 'Disconnected';
  showToast('Disconnected from server. Reconnecting...');
});

socket.on('canvas:init', ({ width, height, pixels }) => {
  CANVAS_W = width;
  CANVAS_H = height;
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Animate loading bar while drawing pixels
  const total = pixels.length;
  let i = 0;
  const BATCH = 5000;

  function drawBatch() {
    const end = Math.min(i + BATCH, total);
    for (; i < end; i++) {
      const { x, y, color } = pixels[i];
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
    loadingBar.style.width = (total > 0 ? (i / total * 100) : 100) + '%';
    if (i < total) {
      requestAnimationFrame(drawBatch);
    } else {
      loading.style.display = 'none';
      fitCanvas();
      showToast('Welcome to Paintarchy. Total anarchy awaits.');
    }
  }

  if (total === 0) {
    loading.style.display = 'none';
    fitCanvas();
    showToast('Welcome to Paintarchy. Total anarchy awaits.');
  } else {
    drawBatch();
  }
});

// Remote stroke segments - stitch together using strokeId
socket.on('stroke:segment', ({ strokeId, points, color, size, isFirst }) => {
  // Get the last known point for this stroke
  let prevPoint = null;
  if (!isFirst && remoteStrokes.has(strokeId)) {
    prevPoint = remoteStrokes.get(strokeId);
  }

  replaySegment(points, color, size, prevPoint);

  // Store last point of this segment for next segment connection
  if (points.length > 0) {
    remoteStrokes.set(strokeId, points[points.length - 1]);
  }

  // Cleanup old strokes (keep map lean)
  if (remoteStrokes.size > 200) {
    const firstKey = remoteStrokes.keys().next().value;
    remoteStrokes.delete(firstKey);
  }
});

socket.on('fill:place', ({ pixels, color }) => {
  ctx.fillStyle = color;
  pixels.forEach(({ x, y }) => ctx.fillRect(x, y, 1, 1));
});

socket.on('users:count', (count) => {
  statusUsers.textContent = 'Users: ' + count;
});
