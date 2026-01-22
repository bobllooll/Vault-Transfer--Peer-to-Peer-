const CACHE_NAME = 'vault-transfer-v6.8'; // VERSION BUMP: Zwingt Browser zum Update
const ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/vault-transfer-icon.svg',
    'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/uuid/8.3.2/uuid.min.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

// Lösche alte Caches beim Aktivieren des neuen Service Workers
self.addEventListener('activate', (e) => {
    console.log(`%c SERVICE WORKER: Active Version ${CACHE_NAME} `, 'background: #00e5ff; color: #000; font-weight: bold;');
    e.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                if (key !== CACHE_NAME) return caches.delete(key);
            }));
        })
    );
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // 1. Handle Share Target POST (Datei vom "Teilen"-Menü)
    if (e.request.method === 'POST' && url.pathname === '/share-target') {
        e.respondWith(
            (async () => {
                const formData = await e.request.formData();
                const file = formData.get('file');
                
                if (file) {
                    // Datei im Cache zwischenspeichern
                    const cache = await caches.open('vault-shared-files');
                    await cache.put('shared-file', new Response(file, {
                        headers: { 'Content-Type': file.type, 'X-File-Name': file.name }
                    }));
                }
                // Redirect zur App mit Flag
                return Response.redirect('/?shared=true', 303);
            })()
        );
    } else {
        // 2. Standard Caching
        e.respondWith(
            caches.match(e.request).then((response) => response || fetch(e.request))
        );
    }
});