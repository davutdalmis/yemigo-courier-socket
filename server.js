const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Socket.io with CORS
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());

// Aktif kuryeler: { courierId: { socketId, branchId, name, location, lastUpdate } }
const activeCouriers = new Map();

// Aktif web paneli bağlantıları: { branchId: [socketIds] }
const branchSubscribers = new Map();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'YemiGO Courier Location Socket',
    activeCouriers: activeCouriers.size,
    uptime: process.uptime()
  });
});

// Aktif kuryeleri listele (debug için)
app.get('/couriers', (req, res) => {
  const couriers = [];
  activeCouriers.forEach((data, courierId) => {
    couriers.push({
      courierId,
      branchId: data.branchId,
      name: data.name,
      location: data.location,
      lastUpdate: data.lastUpdate
    });
  });
  res.json(couriers);
});

// Socket.io bağlantı yönetimi
io.on('connection', (socket) => {
  console.log(`🔌 Yeni bağlantı: ${socket.id}`);

  // Kurye bağlantısı
  socket.on('courier:connect', (data) => {
    const { courierId, branchId, name } = data;

    if (!courierId || !branchId) {
      console.log(`❌ Eksik veri: courierId=${courierId}, branchId=${branchId}`);
      return;
    }

    console.log(`🚴 Kurye bağlandı: ${name} (${courierId}) - Şube: ${branchId}`);

    // Kurye bilgilerini kaydet
    activeCouriers.set(courierId, {
      socketId: socket.id,
      branchId,
      name,
      location: null,
      lastUpdate: new Date().toISOString()
    });

    // Socket'e kurye ID'si ekle
    socket.courierId = courierId;
    socket.branchId = branchId;

    // Şube odasına katıl
    socket.join(`branch:${branchId}`);

    // Kurye'ye onay gönder
    socket.emit('courier:connected', {
      success: true,
      message: 'Bağlantı başarılı',
      courierId
    });

    // Şubeye kurye bağlandı bildirimi
    io.to(`branch:${branchId}`).emit('courier:online', {
      courierId,
      name,
      branchId
    });
  });

  // Kurye konum güncellemesi
  socket.on('courier:location', (data) => {
    const { courierId, latitude, longitude, speed, heading, accuracy } = data;

    if (!courierId || !latitude || !longitude) {
      return;
    }

    const courier = activeCouriers.get(courierId);
    if (!courier) {
      console.log(`⚠️ Bilinmeyen kurye konum gönderdi: ${courierId}`);
      return;
    }

    // Konum güncelle
    courier.location = { latitude, longitude, speed, heading, accuracy };
    courier.lastUpdate = new Date().toISOString();
    activeCouriers.set(courierId, courier);

    console.log(`📍 Konum: ${courier.name} -> ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);

    // Şubeye konum bildirimi gönder
    io.to(`branch:${courier.branchId}`).emit('courier:location:update', {
      courierId,
      name: courier.name,
      latitude,
      longitude,
      speed,
      heading,
      accuracy,
      timestamp: courier.lastUpdate
    });
  });

  // Web paneli şube aboneliği
  socket.on('branch:subscribe', (data) => {
    const { branchId } = data;

    if (!branchId) return;

    console.log(`🖥️ Panel şubeye abone oldu: ${branchId}`);

    socket.join(`branch:${branchId}`);
    socket.branchId = branchId;
    socket.isPanel = true;

    // Mevcut aktif kuryeleri gönder
    const branchCouriers = [];
    activeCouriers.forEach((courierData, cId) => {
      if (courierData.branchId === branchId) {
        branchCouriers.push({
          courierId: cId,
          name: courierData.name,
          location: courierData.location,
          lastUpdate: courierData.lastUpdate
        });
      }
    });

    socket.emit('branch:couriers', branchCouriers);
  });

  // Bağlantı kopması
  socket.on('disconnect', (reason) => {
    console.log(`🔴 Bağlantı koptu: ${socket.id} - Sebep: ${reason}`);

    if (socket.courierId) {
      const courier = activeCouriers.get(socket.courierId);

      if (courier) {
        // Şubeye kurye çevrimdışı bildirimi
        io.to(`branch:${courier.branchId}`).emit('courier:offline', {
          courierId: socket.courierId,
          name: courier.name
        });

        // Kuryeyi listeden kaldır
        activeCouriers.delete(socket.courierId);
        console.log(`🚴 Kurye çevrimdışı: ${courier.name} (${socket.courierId})`);
      }
    }
  });

  // Ping-pong (bağlantı kontrolü)
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 YemiGO Courier Socket Server running on port ${PORT}`);
  console.log(`📡 WebSocket ready for connections`);
});
