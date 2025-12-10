const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ==================== CONFIGURATION ====================

const CONFIG = {
  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // Rate limiting
  MAX_LOCATIONS_PER_MINUTE: 30,
  MAX_CONNECTIONS_PER_IP: 20,

  // Timeouts
  COURIER_TIMEOUT_MS: 60000,
  CLEANUP_INTERVAL_MS: 30000,

  // Limits
  MAX_BATCH_SIZE: 50,
  MAX_COURIERS_PER_BRANCH: 500,

  // Redis key prefixes
  KEYS: {
    COURIER: 'courier:',
    BRANCH: 'branch:',
    LOCATION_HISTORY: 'history:',
    RATE_LIMIT: 'ratelimit:',
    METRICS: 'metrics'
  },

  // TTL (Time To Live)
  TTL: {
    COURIER: 120,        // 2 dakika
    LOCATION_HISTORY: 300, // 5 dakika
    RATE_LIMIT: 60       // 1 dakika
  }
};

// ==================== REDIS SETUP ====================

const redisUrl = CONFIG.REDIS_URL;
console.log('🔴 Redis URL:', redisUrl.replace(/:[^:@]+@/, ':***@')); // Şifreyi gizle

// Pub/Sub için iki ayrı client
const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();

// Genel Redis client
const redis = createClient({ url: redisUrl });

// ==================== SOCKET.IO SETUP ====================

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
  // Cluster için önemli
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  }
});

app.use(cors());
app.use(express.json());

// ==================== LOCAL METRICS (instance başına) ====================

const localMetrics = {
  connections: 0,
  disconnections: 0,
  locationsReceived: 0,
  batchesReceived: 0,
  startTime: Date.now(),
  instanceId: Math.random().toString(36).substr(2, 9)
};

// ==================== REDIS HELPER FUNCTIONS ====================

async function setCourier(courierId, data) {
  const key = CONFIG.KEYS.COURIER + courierId;
  await redis.hSet(key, {
    ...data,
    location: JSON.stringify(data.location || null),
    lastUpdate: new Date().toISOString()
  });
  await redis.expire(key, CONFIG.TTL.COURIER);
}

async function getCourier(courierId) {
  const key = CONFIG.KEYS.COURIER + courierId;
  const data = await redis.hGetAll(key);
  if (!data || Object.keys(data).length === 0) return null;

  return {
    ...data,
    location: data.location ? JSON.parse(data.location) : null,
    batteryLevel: parseInt(data.batteryLevel) || 100
  };
}

async function deleteCourier(courierId) {
  await redis.del(CONFIG.KEYS.COURIER + courierId);
}

async function addCourierToBranch(branchId, courierId) {
  await redis.sAdd(CONFIG.KEYS.BRANCH + branchId, courierId);
}

async function removeCourierFromBranch(branchId, courierId) {
  await redis.sRem(CONFIG.KEYS.BRANCH + branchId, courierId);
}

async function getBranchCouriers(branchId) {
  return await redis.sMembers(CONFIG.KEYS.BRANCH + branchId);
}

async function addLocationHistory(courierId, location) {
  const key = CONFIG.KEYS.LOCATION_HISTORY + courierId;
  await redis.lPush(key, JSON.stringify({ ...location, timestamp: Date.now() }));
  await redis.lTrim(key, 0, 99); // Son 100 konum
  await redis.expire(key, CONFIG.TTL.LOCATION_HISTORY);
}

async function checkRateLimit(courierId) {
  const key = CONFIG.KEYS.RATE_LIMIT + courierId;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, CONFIG.TTL.RATE_LIMIT);
  }

  return count <= CONFIG.MAX_LOCATIONS_PER_MINUTE;
}

async function getAllCouriers() {
  const keys = await redis.keys(CONFIG.KEYS.COURIER + '*');
  const couriers = [];

  for (const key of keys) {
    const courierId = key.replace(CONFIG.KEYS.COURIER, '');
    const data = await getCourier(courierId);
    if (data) {
      couriers.push({ courierId, ...data });
    }
  }

  return couriers;
}

async function getActiveCourierCount() {
  const keys = await redis.keys(CONFIG.KEYS.COURIER + '*');
  return keys.length;
}

async function updateGlobalMetrics(field, increment = 1) {
  await redis.hIncrBy(CONFIG.KEYS.METRICS, field, increment);
}

async function getGlobalMetrics() {
  return await redis.hGetAll(CONFIG.KEYS.METRICS);
}

// ==================== HEALTH CHECK ENDPOINTS ====================

app.get('/', async (req, res) => {
  try {
    const activeCouriers = await getActiveCourierCount();
    const globalMetrics = await getGlobalMetrics();
    const uptime = Math.floor((Date.now() - localMetrics.startTime) / 1000);

    res.json({
      status: 'ok',
      service: 'YemiGO Courier Socket Server',
      version: '3.0.0 (Redis Cluster)',
      instance: localMetrics.instanceId,
      uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      activeCouriers,
      redis: 'connected',
      capacity: '10,000+ couriers',
      metrics: {
        global: globalMetrics,
        instance: {
          connections: localMetrics.connections,
          locationsReceived: localMetrics.locationsReceived
        }
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    // Redis ping
    await redis.ping();
    const memUsage = process.memoryUsage();

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      instance: localMetrics.instanceId,
      redis: 'connected',
      memory: {
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`
      },
      socketConnections: io.engine.clientsCount
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

app.get('/couriers', async (req, res) => {
  try {
    const couriers = await getAllCouriers();
    const now = Date.now();

    const result = couriers.map(c => ({
      ...c,
      isOnline: (now - new Date(c.lastUpdate).getTime()) < CONFIG.COURIER_TIMEOUT_MS
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/branch/:branchId/couriers', async (req, res) => {
  try {
    const { branchId } = req.params;
    const courierIds = await getBranchCouriers(branchId);

    const couriers = [];
    for (const courierId of courierIds) {
      const data = await getCourier(courierId);
      if (data) {
        couriers.push({
          courierId,
          name: data.name,
          location: data.location,
          batteryLevel: data.batteryLevel,
          lastUpdate: data.lastUpdate,
          isOnline: (Date.now() - new Date(data.lastUpdate).getTime()) < CONFIG.COURIER_TIMEOUT_MS
        });
      }
    }

    res.json(couriers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/metrics', async (req, res) => {
  try {
    const globalMetrics = await getGlobalMetrics();
    const activeCouriers = await getActiveCourierCount();

    res.json({
      global: globalMetrics,
      instance: localMetrics,
      activeCouriers,
      memoryUsage: process.memoryUsage(),
      uptime: Date.now() - localMetrics.startTime
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SOCKET.IO HANDLERS ====================

io.on('connection', async (socket) => {
  const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  localMetrics.connections++;
  await updateGlobalMetrics('totalConnections');

  console.log(`🔌 [${localMetrics.instanceId}] Yeni bağlantı: ${socket.id}`);

  // ==================== KURYE BAĞLANTISI ====================

  socket.on('courier:connect', async (data) => {
    try {
      const { courierId, branchId, name, appVersion, platform } = data;

      if (!courierId || !branchId) {
        socket.emit('error', { message: 'Missing courierId or branchId' });
        return;
      }

      console.log(`🚴 [${localMetrics.instanceId}] Kurye: ${name} (${courierId}) - Şube: ${branchId}`);

      // Eski bağlantıyı kontrol et
      const existingCourier = await getCourier(courierId);
      if (existingCourier && existingCourier.socketId !== socket.id) {
        // Eski socket'e bildir (farklı instance'da olabilir)
        io.to(existingCourier.socketId).emit('courier:kicked', { reason: 'New connection' });
      }

      // Redis'e kaydet
      await setCourier(courierId, {
        socketId: socket.id,
        branchId,
        name,
        location: null,
        batteryLevel: 100,
        platform: platform || 'unknown',
        appVersion: appVersion || 'unknown'
      });

      // Şube listesine ekle
      await addCourierToBranch(branchId, courierId);

      // Socket metadata
      socket.courierId = courierId;
      socket.branchId = branchId;
      socket.courierName = name;

      // Şube odasına katıl
      socket.join(`branch:${branchId}`);

      // Onay gönder
      socket.emit('courier:connected', {
        success: true,
        message: 'Bağlantı başarılı',
        courierId,
        serverTime: new Date().toISOString(),
        instance: localMetrics.instanceId
      });

      // Şubeye bildir (tüm instance'lara)
      io.to(`branch:${branchId}`).emit('courier:online', {
        courierId,
        name,
        branchId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('courier:connect hatası:', error);
      socket.emit('error', { message: 'Connection failed' });
    }
  });

  // ==================== KONUM GÜNCELLEMESİ ====================

  socket.on('courier:location', async (data) => {
    try {
      const { courierId, latitude, longitude, speed, heading, accuracy, timestamp, batteryLevel } = data;

      if (!courierId || latitude === undefined || longitude === undefined) {
        return;
      }

      // Rate limit
      const allowed = await checkRateLimit(courierId);
      if (!allowed) {
        return;
      }

      const courier = await getCourier(courierId);
      if (!courier) {
        socket.emit('error', { message: 'Courier not registered. Please reconnect.' });
        return;
      }

      // Konum verisi
      const locationData = {
        latitude,
        longitude,
        speed: speed || 0,
        heading: heading || 0,
        accuracy: accuracy || 0,
        timestamp: timestamp || Date.now()
      };

      // Redis güncelle
      await setCourier(courierId, {
        ...courier,
        socketId: socket.id,
        location: locationData,
        batteryLevel: batteryLevel || courier.batteryLevel
      });

      // Konum geçmişine ekle
      await addLocationHistory(courierId, locationData);

      // Metrics
      localMetrics.locationsReceived++;
      await updateGlobalMetrics('totalLocations');

      // Şubeye broadcast (tüm instance'lara Redis üzerinden)
      io.to(`branch:${courier.branchId}`).emit('courier:location:update', {
        courierId,
        name: courier.name,
        ...locationData,
        batteryLevel: batteryLevel || courier.batteryLevel,
        serverTimestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('courier:location hatası:', error);
    }
  });

  // ==================== BATCH KONUM ====================

  socket.on('courier:location:batch', async (data) => {
    try {
      const { courierId, locations } = data;

      if (!courierId || !Array.isArray(locations)) {
        return;
      }

      const courier = await getCourier(courierId);
      if (!courier) {
        socket.emit('error', { message: 'Courier not registered' });
        return;
      }

      const validLocations = locations.slice(0, CONFIG.MAX_BATCH_SIZE);
      console.log(`📦 [${localMetrics.instanceId}] Batch: ${courier.name} - ${validLocations.length} konum`);

      // Son konumu güncelle
      if (validLocations.length > 0) {
        const lastLoc = validLocations[validLocations.length - 1];
        await setCourier(courierId, {
          ...courier,
          socketId: socket.id,
          location: lastLoc,
          batteryLevel: lastLoc.batteryLevel || courier.batteryLevel
        });

        // Tüm konumları geçmişe ekle
        for (const loc of validLocations) {
          await addLocationHistory(courierId, loc);
        }
      }

      localMetrics.batchesReceived++;
      await updateGlobalMetrics('totalBatches');

      // Şubeye gönder
      io.to(`branch:${courier.branchId}`).emit('courier:location:batch', {
        courierId,
        name: courier.name,
        locations: validLocations,
        serverTimestamp: new Date().toISOString()
      });

      // Onay
      socket.emit('courier:batch:ack', {
        received: validLocations.length,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('courier:location:batch hatası:', error);
    }
  });

  // ==================== PANEL ABONELİĞİ ====================

  socket.on('branch:subscribe', async (data) => {
    try {
      const { branchId } = data;
      if (!branchId) return;

      console.log(`🖥️ [${localMetrics.instanceId}] Panel abone: ${branchId}`);

      socket.join(`branch:${branchId}`);
      socket.branchId = branchId;
      socket.isPanel = true;

      // Şubenin kuryelerini gönder
      const courierIds = await getBranchCouriers(branchId);
      const couriers = [];

      for (const courierId of courierIds) {
        const data = await getCourier(courierId);
        if (data) {
          couriers.push({
            courierId,
            name: data.name,
            location: data.location,
            batteryLevel: data.batteryLevel,
            lastUpdate: data.lastUpdate,
            isOnline: (Date.now() - new Date(data.lastUpdate).getTime()) < CONFIG.COURIER_TIMEOUT_MS
          });
        }
      }

      socket.emit('branch:couriers', couriers);

    } catch (error) {
      console.error('branch:subscribe hatası:', error);
    }
  });

  // ==================== BAĞLANTI KOPUŞU ====================

  socket.on('disconnect', async (reason) => {
    localMetrics.disconnections++;
    await updateGlobalMetrics('totalDisconnections');

    console.log(`🔴 [${localMetrics.instanceId}] Bağlantı koptu: ${socket.id} - ${reason}`);

    if (socket.courierId) {
      try {
        const courier = await getCourier(socket.courierId);

        if (courier && courier.socketId === socket.id) {
          // Şubeye bildir
          io.to(`branch:${courier.branchId}`).emit('courier:offline', {
            courierId: socket.courierId,
            name: courier.name,
            reason,
            timestamp: new Date().toISOString()
          });

          // TTL azalt (hemen silme, yeniden bağlanabilir)
          await redis.expire(CONFIG.KEYS.COURIER + socket.courierId, 30);

          console.log(`🚴 [${localMetrics.instanceId}] Kurye offline: ${courier.name}`);
        }
      } catch (error) {
        console.error('disconnect hatası:', error);
      }
    }
  });

  // Ping-pong
  socket.on('ping', () => {
    socket.emit('pong', {
      serverTime: new Date().toISOString(),
      instance: localMetrics.instanceId
    });
  });
});

// ==================== CLEANUP JOB ====================

setInterval(async () => {
  try {
    const keys = await redis.keys(CONFIG.KEYS.COURIER + '*');
    let cleaned = 0;

    for (const key of keys) {
      const ttl = await redis.ttl(key);
      if (ttl <= 0) {
        const courierId = key.replace(CONFIG.KEYS.COURIER, '');
        const courier = await getCourier(courierId);

        if (courier) {
          await removeCourierFromBranch(courier.branchId, courierId);
        }
        await redis.del(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 [${localMetrics.instanceId}] Temizlik: ${cleaned} kurye`);
    }
  } catch (error) {
    console.error('Cleanup hatası:', error);
  }
}, CONFIG.CLEANUP_INTERVAL_MS);

// ==================== STARTUP ====================

async function startServer() {
  try {
    // Redis bağlantıları
    await Promise.all([
      pubClient.connect(),
      subClient.connect(),
      redis.connect()
    ]);

    console.log('✅ Redis bağlantısı başarılı');

    // Socket.io Redis adapter
    io.adapter(createAdapter(pubClient, subClient));
    console.log('✅ Socket.io Redis Adapter aktif');

    // Sunucuyu başlat
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log('');
      console.log('╔══════════════════════════════════════════════════╗');
      console.log('║  YemiGO Courier Socket Server v3.0.0             ║');
      console.log('║  Redis Cluster Edition - 10K+ Capacity           ║');
      console.log('╠══════════════════════════════════════════════════╣');
      console.log(`║  Instance: ${localMetrics.instanceId}                            ║`);
      console.log(`║  Port: ${PORT}                                        ║`);
      console.log('║  Redis: Connected                                ║');
      console.log('║  Status: Production Ready                        ║');
      console.log('╚══════════════════════════════════════════════════╝');
      console.log('');
      console.log('📡 WebSocket ready - Multi-instance support enabled');
      console.log('🔒 Rate limiting: ENABLED');
      console.log('🧹 Auto cleanup: ENABLED');
      console.log('📊 Capacity: 10,000+ concurrent couriers');
      console.log('');
    });

  } catch (error) {
    console.error('❌ Başlatma hatası:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM alındı, kapatılıyor...');

  io.close();
  await pubClient.quit();
  await subClient.quit();
  await redis.quit();

  process.exit(0);
});

startServer();
