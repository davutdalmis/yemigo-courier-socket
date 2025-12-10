const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ==================== CONFIGURATION ====================

const CONFIG = {
  // Rate limiting
  MAX_LOCATIONS_PER_MINUTE: 30,
  MAX_CONNECTIONS_PER_IP: 10,

  // Timeouts
  COURIER_TIMEOUT_MS: 60000, // 1 dakika sessizlik = offline
  CLEANUP_INTERVAL_MS: 30000, // 30 saniyede bir temizlik

  // Limits
  MAX_BATCH_SIZE: 50,
  MAX_COURIERS_PER_BRANCH: 100
};

// ==================== SOCKET.IO SETUP ====================

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6 // 1MB
});

app.use(cors());
app.use(express.json());

// ==================== DATA STORES ====================

// Aktif kuryeler: { courierId: { socketId, branchId, name, location, lastUpdate, batteryLevel, rateLimit } }
const activeCouriers = new Map();

// IP bazlı bağlantı sayısı: { ip: count }
const connectionsByIP = new Map();

// Şube bazlı kurye listesi: { branchId: Set<courierId> }
const couriersByBranch = new Map();

// Konum geçmişi (son 5 dakika): { courierId: [locations] }
const locationHistory = new Map();

// ==================== METRICS ====================

const metrics = {
  totalConnections: 0,
  totalDisconnections: 0,
  totalLocationsReceived: 0,
  totalBatchesReceived: 0,
  startTime: Date.now(),
  errors: []
};

// ==================== MIDDLEWARE ====================

// Rate limit kontrolü
function checkRateLimit(courierId) {
  const courier = activeCouriers.get(courierId);
  if (!courier) return true;

  const now = Date.now();
  const windowStart = now - 60000; // Son 1 dakika

  // Eski kayıtları temizle
  courier.rateLimit = (courier.rateLimit || []).filter(t => t > windowStart);

  if (courier.rateLimit.length >= CONFIG.MAX_LOCATIONS_PER_MINUTE) {
    return false;
  }

  courier.rateLimit.push(now);
  return true;
}

// IP bazlı bağlantı limiti
function checkConnectionLimit(ip) {
  const count = connectionsByIP.get(ip) || 0;
  return count < CONFIG.MAX_CONNECTIONS_PER_IP;
}

// ==================== HEALTH CHECK ENDPOINTS ====================

// Ana health check
app.get('/', (req, res) => {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);

  res.json({
    status: 'ok',
    service: 'YemiGO Courier Location Socket',
    version: '2.0.0',
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    activeCouriers: activeCouriers.size,
    totalBranches: couriersByBranch.size,
    metrics: {
      totalConnections: metrics.totalConnections,
      totalLocationsReceived: metrics.totalLocationsReceived,
      totalBatchesReceived: metrics.totalBatchesReceived
    }
  });
});

// Detaylı health check (internal)
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    memory: {
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`
    },
    activeCouriers: activeCouriers.size,
    socketConnections: io.engine.clientsCount
  });
});

// Aktif kuryeleri listele
app.get('/couriers', (req, res) => {
  const couriers = [];
  activeCouriers.forEach((data, courierId) => {
    couriers.push({
      courierId,
      branchId: data.branchId,
      name: data.name,
      location: data.location,
      batteryLevel: data.batteryLevel,
      lastUpdate: data.lastUpdate,
      isOnline: (Date.now() - new Date(data.lastUpdate).getTime()) < CONFIG.COURIER_TIMEOUT_MS
    });
  });
  res.json(couriers);
});

// Şube bazlı kuryeler
app.get('/branch/:branchId/couriers', (req, res) => {
  const { branchId } = req.params;
  const courierIds = couriersByBranch.get(branchId) || new Set();

  const couriers = [];
  courierIds.forEach(courierId => {
    const data = activeCouriers.get(courierId);
    if (data) {
      couriers.push({
        courierId,
        name: data.name,
        location: data.location,
        batteryLevel: data.batteryLevel,
        lastUpdate: data.lastUpdate
      });
    }
  });

  res.json(couriers);
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  res.json({
    ...metrics,
    uptime: Date.now() - metrics.startTime,
    activeCouriers: activeCouriers.size,
    memoryUsage: process.memoryUsage()
  });
});

// ==================== SOCKET.IO HANDLERS ====================

io.on('connection', (socket) => {
  const clientIP = socket.handshake.address;

  // IP bazlı limit kontrolü
  if (!checkConnectionLimit(clientIP)) {
    console.log(`❌ IP limit aşıldı: ${clientIP}`);
    socket.emit('error', { message: 'Too many connections from your IP' });
    socket.disconnect(true);
    return;
  }

  // Bağlantı sayısını artır
  connectionsByIP.set(clientIP, (connectionsByIP.get(clientIP) || 0) + 1);
  metrics.totalConnections++;

  console.log(`🔌 Yeni bağlantı: ${socket.id} (IP: ${clientIP})`);

  // ==================== KURYE BAĞLANTISI ====================

  socket.on('courier:connect', (data) => {
    try {
      const { courierId, branchId, name, appVersion, platform } = data;

      if (!courierId || !branchId) {
        socket.emit('error', { message: 'Missing courierId or branchId' });
        return;
      }

      console.log(`🚴 Kurye bağlandı: ${name} (${courierId}) - Şube: ${branchId} [${platform} v${appVersion}]`);

      // Eski bağlantı varsa kapat
      const existingCourier = activeCouriers.get(courierId);
      if (existingCourier && existingCourier.socketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(existingCourier.socketId);
        if (oldSocket) {
          oldSocket.emit('courier:kicked', { reason: 'New connection established' });
          oldSocket.disconnect(true);
        }
      }

      // Kurye bilgilerini kaydet
      activeCouriers.set(courierId, {
        socketId: socket.id,
        branchId,
        name,
        location: null,
        lastUpdate: new Date().toISOString(),
        batteryLevel: 100,
        rateLimit: [],
        platform,
        appVersion
      });

      // Socket'e metadata ekle
      socket.courierId = courierId;
      socket.branchId = branchId;

      // Şube listesine ekle
      if (!couriersByBranch.has(branchId)) {
        couriersByBranch.set(branchId, new Set());
      }
      couriersByBranch.get(branchId).add(courierId);

      // Şube odasına katıl
      socket.join(`branch:${branchId}`);

      // Onay gönder
      socket.emit('courier:connected', {
        success: true,
        message: 'Bağlantı başarılı',
        courierId,
        serverTime: new Date().toISOString()
      });

      // Şubeye bildir
      io.to(`branch:${branchId}`).emit('courier:online', {
        courierId,
        name,
        branchId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('courier:connect hatası:', error);
      metrics.errors.push({ type: 'courier:connect', error: error.message, time: new Date() });
    }
  });

  // ==================== KONUM GÜNCELLEMESİ ====================

  socket.on('courier:location', (data) => {
    try {
      const { courierId, latitude, longitude, speed, heading, accuracy, timestamp, batteryLevel } = data;

      if (!courierId || latitude === undefined || longitude === undefined) {
        return;
      }

      // Rate limit kontrolü
      if (!checkRateLimit(courierId)) {
        console.log(`⚠️ Rate limit: ${courierId}`);
        return;
      }

      const courier = activeCouriers.get(courierId);
      if (!courier) {
        socket.emit('error', { message: 'Courier not registered. Please reconnect.' });
        return;
      }

      // Konum güncelle
      const locationData = {
        latitude,
        longitude,
        speed: speed || 0,
        heading: heading || 0,
        accuracy: accuracy || 0,
        timestamp: timestamp || Date.now()
      };

      courier.location = locationData;
      courier.lastUpdate = new Date().toISOString();
      courier.batteryLevel = batteryLevel || courier.batteryLevel;

      metrics.totalLocationsReceived++;

      // Konum geçmişine ekle
      if (!locationHistory.has(courierId)) {
        locationHistory.set(courierId, []);
      }
      const history = locationHistory.get(courierId);
      history.push({ ...locationData, receivedAt: Date.now() });

      // Son 5 dakikayı tut
      const fiveMinutesAgo = Date.now() - 300000;
      while (history.length > 0 && history[0].receivedAt < fiveMinutesAgo) {
        history.shift();
      }

      // Şubeye broadcast
      io.to(`branch:${courier.branchId}`).emit('courier:location:update', {
        courierId,
        name: courier.name,
        ...locationData,
        batteryLevel: courier.batteryLevel,
        serverTimestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('courier:location hatası:', error);
      metrics.errors.push({ type: 'courier:location', error: error.message, time: new Date() });
    }
  });

  // ==================== TOPLU KONUM (OFFLINE SYNC) ====================

  socket.on('courier:location:batch', (data) => {
    try {
      const { courierId, locations } = data;

      if (!courierId || !Array.isArray(locations)) {
        return;
      }

      const courier = activeCouriers.get(courierId);
      if (!courier) {
        socket.emit('error', { message: 'Courier not registered' });
        return;
      }

      // Batch boyutu kontrolü
      const validLocations = locations.slice(0, CONFIG.MAX_BATCH_SIZE);

      console.log(`📦 Batch alındı: ${courier.name} - ${validLocations.length} konum`);
      metrics.totalBatchesReceived++;

      // Son konumu güncelle
      if (validLocations.length > 0) {
        const lastLoc = validLocations[validLocations.length - 1];
        courier.location = lastLoc;
        courier.lastUpdate = new Date().toISOString();
        courier.batteryLevel = lastLoc.batteryLevel || courier.batteryLevel;
      }

      // Şubeye batch olarak gönder
      io.to(`branch:${courier.branchId}`).emit('courier:location:batch', {
        courierId,
        name: courier.name,
        locations: validLocations,
        serverTimestamp: new Date().toISOString()
      });

      // Onay gönder
      socket.emit('courier:batch:ack', {
        received: validLocations.length,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('courier:location:batch hatası:', error);
      metrics.errors.push({ type: 'batch', error: error.message, time: new Date() });
    }
  });

  // ==================== PANEL ABONELİĞİ ====================

  socket.on('branch:subscribe', (data) => {
    try {
      const { branchId } = data;

      if (!branchId) return;

      console.log(`🖥️ Panel abone oldu: ${branchId}`);

      socket.join(`branch:${branchId}`);
      socket.branchId = branchId;
      socket.isPanel = true;

      // Mevcut aktif kuryeleri gönder
      const courierIds = couriersByBranch.get(branchId) || new Set();
      const branchCouriers = [];

      courierIds.forEach(cId => {
        const courierData = activeCouriers.get(cId);
        if (courierData) {
          const isOnline = (Date.now() - new Date(courierData.lastUpdate).getTime()) < CONFIG.COURIER_TIMEOUT_MS;
          branchCouriers.push({
            courierId: cId,
            name: courierData.name,
            location: courierData.location,
            batteryLevel: courierData.batteryLevel,
            lastUpdate: courierData.lastUpdate,
            isOnline
          });
        }
      });

      socket.emit('branch:couriers', branchCouriers);

    } catch (error) {
      console.error('branch:subscribe hatası:', error);
    }
  });

  // ==================== BAĞLANTI KOPUŞU ====================

  socket.on('disconnect', (reason) => {
    metrics.totalDisconnections++;

    // IP sayacını azalt
    const count = connectionsByIP.get(clientIP) || 1;
    if (count <= 1) {
      connectionsByIP.delete(clientIP);
    } else {
      connectionsByIP.set(clientIP, count - 1);
    }

    console.log(`🔴 Bağlantı koptu: ${socket.id} - Sebep: ${reason}`);

    if (socket.courierId) {
      const courier = activeCouriers.get(socket.courierId);

      if (courier && courier.socketId === socket.id) {
        // Şubeye bildir
        io.to(`branch:${courier.branchId}`).emit('courier:offline', {
          courierId: socket.courierId,
          name: courier.name,
          reason,
          timestamp: new Date().toISOString()
        });

        // Hemen silme - timeout ile offline yap
        courier.lastUpdate = new Date(0).toISOString(); // Eski tarih = offline

        console.log(`🚴 Kurye çevrimdışı: ${courier.name} (${socket.courierId})`);
      }
    }
  });

  // Ping-pong
  socket.on('ping', () => {
    socket.emit('pong', { serverTime: new Date().toISOString() });
  });
});

// ==================== CLEANUP JOB ====================

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  activeCouriers.forEach((data, courierId) => {
    const lastUpdateTime = new Date(data.lastUpdate).getTime();

    // Timeout olan kuryeleri temizle
    if (now - lastUpdateTime > CONFIG.COURIER_TIMEOUT_MS * 2) {
      activeCouriers.delete(courierId);
      locationHistory.delete(courierId);

      // Şube listesinden kaldır
      const branchCouriers = couriersByBranch.get(data.branchId);
      if (branchCouriers) {
        branchCouriers.delete(courierId);
        if (branchCouriers.size === 0) {
          couriersByBranch.delete(data.branchId);
        }
      }

      cleaned++;
    }
  });

  // Eski hataları temizle (son 100)
  while (metrics.errors.length > 100) {
    metrics.errors.shift();
  }

  if (cleaned > 0) {
    console.log(`🧹 Temizlik: ${cleaned} offline kurye kaldırıldı`);
  }
}, CONFIG.CLEANUP_INTERVAL_MS);

// ==================== SERVER START ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  YemiGO Courier Socket Server v2.0.0       ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  Port: ${PORT}                                 ║`);
  console.log('║  Status: Production Ready                  ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
  console.log('📡 WebSocket ready for connections');
  console.log('🔒 Rate limiting: ENABLED');
  console.log('🧹 Auto cleanup: ENABLED');
  console.log('');
});
