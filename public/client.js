// ===== SOCKET =====
const socket = io();

// ===== CANVAS SETUP =====
const canvas = document.getElementById('main-canvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('canvas-container');
const wrapper = document.getElementById('canvas-wrapper');

let CANVAS_W = 1000;
let CANVAS_H = 1000;

canvas.width = CANVAS_W;
canvas.height = CANVAS_H;

// Fill white background
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

// ===== STATE =====
let currentColor = '#e63946';
let brushSize = 4;
let currentTool = 'brush';
let isDrawing = false;
let lastX = null;
let lastY = null;
let recentColors = [];

// Pan/zoom state
let scale = 1;
let panX = 0;
let panY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;

// Stroke buffer (batch pixel sends)
let strokeBuffer = [];
let strokeFlushTimer = null;

// ===== UI ELEMENTS =====
const colorPicker = document.getElementById('color-picker');
const brushSizeInput = document.getElementById('brush-size');
const brushSizeLabel = document.getElementById('brush-size-label');
const zoomLabel = document.getElementById('zoom-label');
const coordsDisplay = document.getElementById('coords');
const countNum = document.getElementById('count-num');
const cursorPreview = document.getElementById('cursor-preview');
const recentColorsEl = document.getElementById('recent-colors');
const loading = document.getElementById('loading');
const toast = document.getElementById('toast');

// ===== HELPERS =====
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function addRecentColor(color) {
  if (recentColors[0] === color) return;
  recentColors = [color, ...recentColors.filter(c => c !== color)].slice(0, 8);
  renderRecentColors();
}

function renderRecentColors() {
  recentColorsEl.innerHTML = '';
  recentColors.forEach(color => {
    const div = document.createElement('div');
    div.className = 'recent-color';
    div.style.background = color;
    div.title = color;
    div.addEventListener('click', () => {
      currentColor = color;
      colorPicker.value = color;
    });
    recentColorsEl.appendChild(div);
  });
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ===== TRANSFORM =====
function applyTransform() {
  container.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  zoomLabel.textContent = Math.round(scale * 100) + '%';
}

function centerCanvas() {
  const ww = wrapper.clientWidth;
  const wh = wrapper.clientHeight;
  // Fit to screen
  const scaleX = ww / CANVAS_W;
  const scaleY = wh / CANVAS_H;
  scale = Math.min(scaleX, scaleY) * 0.9;
  panX = (ww - CANVAS_W * scale) / 2;
  panY = (wh - CANVAS_H * scale) / 2;
  applyTransform();
}

function getCanvasPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / scale,
    y: (clientY - rect.top) / scale
  };
}

// ===== DRAWING =====
function drawPixel(x, y, color, size) {
  const half = Math.floor(size / 2);
  ctx.fillStyle = color;
  ctx.fillRect(Math.floor(x) - half, Math.floor(y) - half, size, size);
}

function drawLine(x0, y0, x1, y1, color, size) {
  // Bresenham-style interpolation
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(Math.ceil(dist), 1);
  const pixels = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.floor(x0 + (x1 - x0) * t);
    const y = Math.floor(y0 + (y1 - y0) * t);
    drawPixel(x, y, color, size);

    // Collect all pixels in the square
    const half = Math.floor(size / 2);
    for (let dx = -half; dx < size - half; dx++) {
      for (let dy = -half; dy < size - half; dy++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && px < CANVAS_W && py >= 0 && py < CANVAS_H) {
          pixels.push({ x: px, y: py, color });
        }
      }
    }
  }

  return pixels;
}

// Flood fill
function floodFill(startX, startY, fillColor) {
  startX = Math.floor(startX);
  startY = Math.floor(startY);

  const imageData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
  const data = imageData.data;

  const idx = (y, x) => (y * CANVAS_W + x) * 4;
  const startIdx = idx(startY, startX);
  const sr = data[startIdx];
  const sg = data[startIdx + 1];
  const sb = data[startIdx + 2];

  const [fr, fg, fb] = hexToRgb(fillColor);

  if (sr === fr && sg === fg && sb === fb) return;

  const stack = [[startX, startY]];
  const visited = new Set();
  const changedPixels = [];

  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= CANVAS_W || y < 0 || y >= CANVAS_H) continue;

    const key = `${x},${y}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const i = idx(y, x);
    if (data[i] !== sr || data[i + 1] !== sg || data[i + 2] !== sb) continue;

    data[i] = fr;
    data[i + 1] = fg;
    data[i + 2] = fb;
    data[i + 3] = 255;
    changedPixels.push({ x, y, color: fillColor });

    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  ctx.putImageData(imageData, 0, 0);

  // Send in batches
  for (let i = 0; i < changedPixels.length; i += 500) {
    socket.emit('stroke:place', changedPixels.slice(i, i + 500));
  }
}

// Eyedropper
function pickColor(x, y) {
  const pixel = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  const color = rgbToHex(pixel[0], pixel[1], pixel[2]);
  currentColor = color;
  colorPicker.value = color;
  addRecentColor(color);
  showToast(`🎨 Picked ${color}`);
  setTool('brush');
}

// ===== STROKE BUFFERING =====
function flushStrokeBuffer() {
  if (strokeBuffer.length === 0) return;
  socket.emit('stroke:place', [...strokeBuffer]);
  strokeBuffer = [];
}

function bufferPixels(pixels) {
  strokeBuffer.push(...pixels);
  // Flush every 50ms or if buffer is large
  if (!strokeFlushTimer) {
    strokeFlushTimer = setTimeout(() => {
      flushStrokeBuffer();
      strokeFlushTimer = null;
    }, 50);
  }
  if (strokeBuffer.length >= 400) {
    clearTimeout(strokeFlushTimer);
    strokeFlushTimer = null;
    flushStrokeBuffer();
  }
}

// ===== EVENT HANDLERS =====
function setTool(tool) {
  currentTool = tool;
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });

  // Update cursor
  if (tool === 'eyedropper') {
    wrapper.style.cursor = 'crosshair';
  } else if (tool === 'fill') {
    wrapper.style.cursor = 'cell';
  } else {
    wrapper.style.cursor = 'none';
  }
}

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

colorPicker.addEventListener('input', (e) => {
  currentColor = e.target.value;
});

colorPicker.addEventListener('change', (e) => {
  addRecentColor(e.target.value);
});

brushSizeInput.addEventListener('input', (e) => {
  brushSize = parseInt(e.target.value);
  brushSizeLabel.textContent = brushSize + 'px';
  updateCursorPreview();
});

// Zoom buttons
document.getElementById('zoom-in').addEventListener('click', () => {
  const cx = wrapper.clientWidth / 2;
  const cy = wrapper.clientHeight / 2;
  zoomAt(cx, cy, 1.25);
});

document.getElementById('zoom-out').addEventListener('click', () => {
  const cx = wrapper.clientWidth / 2;
  const cy = wrapper.clientHeight / 2;
  zoomAt(cx, cy, 0.8);
});

document.getElementById('zoom-reset').addEventListener('click', centerCanvas);

function zoomAt(cx, cy, factor) {
  const newScale = Math.min(Math.max(scale * factor, 0.1), 20);
  const scaleChange = newScale / scale;
  panX = cx - scaleChange * (cx - panX);
  panY = cy - scaleChange * (cy - panY);
  scale = newScale;
  applyTransform();
}

// Save PNG
document.getElementById('save-btn').addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'paintarchy.png';
  link.href = canvas.toDataURL();
  link.click();
  showToast('💾 Canvas saved!');
});

// ===== CURSOR PREVIEW =====
function updateCursorPreview(clientX, clientY) {
  const size = brushSize * scale;
  cursorPreview.style.width = size + 'px';
  cursorPreview.style.height = size + 'px';
  if (clientX !== undefined) {
    cursorPreview.style.left = clientX + 'px';
    cursorPreview.style.top = clientY + 'px';
  }
}

// ===== MOUSE EVENTS =====
wrapper.addEventListener('mousemove', (e) => {
  const { x, y } = getCanvasPos(e.clientX, e.clientY);
  coordsDisplay.textContent = `X: ${Math.floor(x)}, Y: ${Math.floor(y)}`;

  // Cursor preview
  if (currentTool === 'brush' || currentTool === 'eraser') {
    cursorPreview.style.display = 'block';
    updateCursorPreview(e.clientX, e.clientY);
    cursorPreview.style.borderColor =
      currentTool === 'eraser' ? '#999' : currentColor;
  } else {
    cursorPreview.style.display = 'none';
  }

  // Panning
  if (isPanning) {
    panX = panOriginX + (e.clientX - panStartX);
    panY = panOriginY + (e.clientY - panStartY);
    applyTransform();
    return;
  }

  // Drawing
  if (isDrawing && (currentTool === 'brush' || currentTool === 'eraser')) {
    const color = currentTool === 'eraser' ? '#ffffff' : currentColor;
    if (lastX !== null) {
      const pixels = drawLine(lastX, lastY, x, y, color, brushSize);
      bufferPixels(pixels);
    } else {
      const pixels = [];
      drawPixel(x, y, color, brushSize);
      const half = Math.floor(brushSize / 2);
      for (let dx = -half; dx < brushSize - half; dx++) {
        for (let dy = -half; dy < brushSize - half; dy++) {
          const px = Math.floor(x) + dx;
          const py = Math.floor(y) + dy;
          if (px >= 0 && px < CANVAS_W && py >= 0 && py < CANVAS_H) {
            pixels.push({ x: px, y: py, color });
          }
        }
      }
      bufferPixels(pixels);
    }
    lastX = x;
    lastY = y;
  }
});

wrapper.addEventListener('mousedown', (e) => {
  if (e.button === 1 || e.button === 2) {
    // Middle or right click = pan
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOriginX = panX;
    panOriginY = panY;
    wrapper.style.cursor = 'grabbing';
    return;
  }

  if (e.button !== 0) return;

  const { x, y } = getCanvasPos(e.clientX, e.clientY);

  if (currentTool === 'eyedropper') {
    pickColor(x, y);
    return;
  }

  if (currentTool === 'fill') {
    floodFill(x, y, currentColor);
    return;
  }

  isDrawing = true;
  lastX = x;
  lastY = y;

  const color = currentTool === 'eraser' ? '#ffffff' : currentColor;
  drawPixel(x, y, color, brushSize);

  const pixels = [];
  const half = Math.floor(brushSize / 2);
  for (let dx = -half; dx < brushSize - half; dx++) {
    for (let dy = -half; dy < brushSize - half; dy++) {
      const px = Math.floor(x) + dx;
      const py = Math.floor(y) + dy;
      if (px >= 0 && px < CANVAS_W && py >= 0 && py < CANVAS_H) {
        pixels.push({ x: px, y: py, color });
      }
    }
  }
  bufferPixels(pixels);
});

window.addEventListener('mouseup', (e) => {
  if (isPanning) {
    isPanning = false;
    setTool(currentTool); // restore cursor
    return;
  }
  isDrawing = false;
  lastX = null;
  lastY = null;
  flushStrokeBuffer();
  addRecentColor(currentColor);
});

// Scroll to zoom
wrapper.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  zoomAt(e.clientX, e.clientY, factor);
}, { passive: false });

// Prevent context menu on canvas
wrapper.addEventListener('contextmenu', e => e.preventDefault());

// Touch support (basic)
let lastTouchDist = null;

wrapper.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    lastTouchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    return;
  }
  const touch = e.touches[0];
  const mouseEvent = new MouseEvent('mousedown', {
    clientX: touch.clientX, clientY: touch.clientY, button: 0
  });
  wrapper.dispatchEvent(mouseEvent);
}, { passive: true });

wrapper.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2) {
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (lastTouchDist) {
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      zoomAt(midX, midY, dist / lastTouchDist);
    }
    lastTouchDist = dist;
    return;
  }
  e.preventDefault();
  const touch = e.touches[0];
  const mouseEvent = new MouseEvent('mousemove', {
    clientX: touch.clientX, clientY: touch.clientY
  });
  wrapper.dispatchEvent(mouseEvent);
}, { passive: false });

wrapper.addEventListener('touchend', () => {
  lastTouchDist = null;
  window.dispatchEvent(new MouseEvent('mouseup'));
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  switch (e.key.toLowerCase()) {
    case 'b': setTool('brush'); break;
    case 'f': setTool('fill'); break;
    case 'e': setTool('eraser'); break;
    case 'i': setTool('eyedropper'); break;
    case '[': brushSize = Math.max(1, brushSize - 2);
      brushSizeInput.value = brushSize;
      brushSizeLabel.textContent = brushSize + 'px';
      updateCursorPreview();
      break;
    case ']': brushSize = Math.min(50, brushSize + 2);
      brushSizeInput.value = brushSize;
      brushSizeLabel.textContent = brushSize + 'px';
      updateCursorPreview();
      break;
  }
});

// ===== SOCKET EVENTS =====
socket.on('canvas:init', ({ width, height, pixels }) => {
  CANVAS_W = width;
  CANVAS_H = height;
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Draw existing pixels
  pixels.forEach(({ x, y, color }) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
  });

  // Hide loading
  loading.style.opacity = '0';
  setTimeout(() => loading.style.display = 'none', 500);

  centerCanvas();
  showToast('🎨 Welcome to Paintarchy! Total anarchy awaits...');
});

socket.on('pixel:update', ({ x, y, color }) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
});

socket.on('stroke:update', (pixels) => {
  pixels.forEach(({ x, y, color }) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
  });
});

socket.on('users:count', (count) => {
  countNum.textContent = count;
});

socket.on('connect', () => {
  console.log('Connected to Paintarchy!');
});

socket.on('disconnect', () => {
  showToast('⚠️ Disconnected! Reconnecting...', 5000);
});
