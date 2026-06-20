const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Tune for lower latency
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));

const CANVAS_WIDTH = 3000;
const CANVAS_HEIGHT = 3000;

// Flat pixel map "x,y" -> color
const canvasState = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Send full canvas state on join
  socket.emit('canvas:init', {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    pixels: Array.from(canvasState.entries()).map(([key, color]) => {
      const [x, y] = key.split(',').map(Number);
      return { x, y, color };
    })
  });

  io.emit('users:count', io.engine.clientsCount);

  // A stroke segment: { strokeId, points: [{x,y}], color, size, isFirst }
  // isFirst = true means start a new stroke (no connection to previous)
  socket.on('stroke:segment', (data) => {
    const { strokeId, points, color, size, isFirst } = data;

    if (
      !Array.isArray(points) ||
      points.length === 0 ||
      points.length > 200 ||
      typeof color !== 'string' ||
      !/^#[0-9A-Fa-f]{6}$/.test(color) ||
      typeof size !== 'number' ||
      size < 1 || size > 50
    ) return;

    // Validate all points
    const validPoints = points.filter(p =>
      typeof p.x === 'number' && typeof p.y === 'number' &&
      p.x >= 0 && p.x < CANVAS_WIDTH &&
      p.y >= 0 && p.y < CANVAS_HEIGHT
    ).map(p => ({ x: Math.floor(p.x), y: Math.floor(p.y) }));

    if (validPoints.length === 0) return;

    // Store pixels in canvas state
    const half = Math.floor(size / 2);
    function storeLine(x0, y0, x1, y1) {
      const dist = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(Math.ceil(dist), 1);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = Math.round(x0 + (x1 - x0) * t);
        const y = Math.round(y0 + (y1 - y0) * t);
        for (let dx = -half; dx <= half; dx++) {
          for (let dy = -half; dy <= half; dy++) {
            const px = x + dx, py = y + dy;
            if (px >= 0 && px < CANVAS_WIDTH && py >= 0 && py < CANVAS_HEIGHT) {
              canvasState.set(`${px},${py}`, color);
            }
          }
        }
      }
    }

    for (let i = 1; i < validPoints.length; i++) {
      storeLine(
        validPoints[i-1].x, validPoints[i-1].y,
        validPoints[i].x, validPoints[i].y
      );
    }
    if (validPoints.length === 1) {
      const { x, y } = validPoints[0];
      for (let dx = -half; dx <= half; dx++) {
        for (let dy = -half; dy <= half; dy++) {
          const px = x + dx, py = y + dy;
          if (px >= 0 && px < CANVAS_WIDTH && py >= 0 && py < CANVAS_HEIGHT) {
            canvasState.set(`${px},${py}`, color);
          }
        }
      }
    }

    // Broadcast to all OTHER clients with full segment info for smooth replay
    socket.broadcast.emit('stroke:segment', {
      strokeId,
      points: validPoints,
      color,
      size,
      isFirst
    });
  });

  // Flood fill broadcast
  socket.on('fill:place', (data) => {
    const { pixels, color } = data;
    if (!Array.isArray(pixels) || typeof color !== 'string') return;
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return;

    pixels.forEach(({ x, y }) => {
      if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT) {
        canvasState.set(`${Math.floor(x)},${Math.floor(y)}`, color);
      }
    });

    socket.broadcast.emit('fill:place', { pixels, color });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    io.emit('users:count', io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Paintarchy running on port ${PORT}`);
});
