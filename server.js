const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Canvas state: store every pixel placed
// Format: { x, y, color }
const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 1000;

// Store canvas as a flat map: "x,y" -> color
const canvasState = new Map();

io.on('connection', (socket) => {
  console.log(`🎨 User connected: ${socket.id}`);

  // Send current canvas state to newly connected user
  socket.emit('canvas:init', {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    pixels: Array.from(canvasState.entries()).map(([key, color]) => {
      const [x, y] = key.split(',').map(Number);
      return { x, y, color };
    })
  });

  // Broadcast active user count
  io.emit('users:count', io.engine.clientsCount);

  // Handle pixel placement
  socket.on('pixel:place', (data) => {
    const { x, y, color } = data;

    // Validate data
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof color !== 'string' ||
      x < 0 || x >= CANVAS_WIDTH ||
      y < 0 || y >= CANVAS_HEIGHT ||
      !/^#[0-9A-Fa-f]{6}$/.test(color)
    ) {
      return;
    }

    const key = `${Math.floor(x)},${Math.floor(y)}`;
    canvasState.set(key, color);

    // Broadcast to ALL clients (including sender)
    io.emit('pixel:update', { x: Math.floor(x), y: Math.floor(y), color });
  });

  // Handle brush strokes (multiple pixels at once)
  socket.on('stroke:place', (pixels) => {
    if (!Array.isArray(pixels) || pixels.length > 500) return;

    const validPixels = [];

    for (const { x, y, color } of pixels) {
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof color !== 'string' ||
        x < 0 || x >= CANVAS_WIDTH ||
        y < 0 || y >= CANVAS_HEIGHT ||
        !/^#[0-9A-Fa-f]{6}$/.test(color)
      ) continue;

      const key = `${Math.floor(x)},${Math.floor(y)}`;
      canvasState.set(key, color);
      validPixels.push({ x: Math.floor(x), y: Math.floor(y), color });
    }

    if (validPixels.length > 0) {
      io.emit('stroke:update', validPixels);
    }
  });

  socket.on('disconnect', () => {
    console.log(`💨 User disconnected: ${socket.id}`);
    io.emit('users:count', io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎨 Paintarchy running on port ${PORT}`);
});
