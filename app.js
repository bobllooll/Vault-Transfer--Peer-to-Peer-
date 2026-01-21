// --- CONFIGURATION ---
const CHUNK_SIZE = 16 * 1024; // 16KB chunks
const ACCENT_COLOR = 0x00e5ff;

// --- STATE ---
let roomId;
let sharedKey; // Der kryptografische Schlüssel
let peer;
let conn; // Die aktive Verbindung
let fileChunks = [];
let fileInfo = null;
let receivedSize = 0;
let pendingFile = null; // Datei, die auf Verbindung wartet
let receivedFilesCache = []; // Speicher für alle empfangenen Dateien

// --- UI ELEMENTS ---
const statusEl = document.getElementById('connection-status');
const linkInput = document.getElementById('room-link');
const dropLabel = document.getElementById('drop-label');
const galleryBtn = document.getElementById('gallery-btn');
const transferPanel = document.getElementById('transfer-panel');
const progressBar = document.getElementById('progress-bar');
const speedEl = document.getElementById('transfer-speed');
const shareBtn = document.getElementById('share-btn');
const qrBtn = document.getElementById('qr-btn');
const qrPopup = document.getElementById('qr-popup');
const newRoomBtn = document.getElementById('new-room-btn');
const disconnectModal = document.getElementById('disconnect-modal');
const reconnectBtn = document.getElementById('reconnect-btn');
const gdprBanner = document.getElementById('gdpr-banner');
const downloadAllBtn = document.getElementById('download-all-btn');
const closePanelBtn = document.getElementById('close-panel-btn');
const startScreen = document.getElementById('start-screen');
const startCreateBtn = document.getElementById('start-create-btn');
const startScanBtn = document.getElementById('start-scan-btn');
const qrScannerContainer = document.getElementById('qr-scanner-container');

// --- INITIALIZATION ---
async function init() {
    // 1. Room Logic
    const urlParams = new URLSearchParams(window.location.search);
    roomId = urlParams.get('room');

    // Check for Shared File (from Mobile Share Menu)
    if (urlParams.get('shared') === 'true') {
        handleSharedFile();
        // URL bereinigen
        window.history.replaceState(null, null, '/');
    }

    // GDPR Check
    if (!localStorage.getItem('vault-gdpr-consent')) {
        gdprBanner.style.display = 'flex';
    }

    // Check if Mobile (simple width check or user agent)
    const isMobile = window.innerWidth <= 768;

    if (!roomId) {
        if (isMobile) {
            // Show Start Screen on Mobile
            startScreen.style.display = 'flex';
        } else {
            // Auto-create on Desktop
            initializeHost();
        }
    } else {
        initializeGuest(roomId);
    }

    // 3. Visuals
    initThreeJS();
    setupDragAndDrop();
    setupGallery();
    setupQRCode();
    setupShareButton();

    // Event Listeners
    newRoomBtn.addEventListener('click', createNewRoom);
    reconnectBtn.addEventListener('click', () => {
        disconnectModal.style.display = 'none';
        createNewRoom();
    });
    document.getElementById('gdpr-accept').addEventListener('click', () => {
        localStorage.setItem('vault-gdpr-consent', 'true');
        gdprBanner.style.display = 'none';
    });

    downloadAllBtn.addEventListener('click', () => {
        receivedFilesCache.forEach(item => {
            downloadFile(item.blob, item.fileName);
        });
    });

    closePanelBtn.addEventListener('click', () => {
        transferPanel.style.display = 'none';
    });

    // Start Screen Listeners
    startCreateBtn.addEventListener('click', () => {
        startScreen.style.display = 'none';
        initializeHost();
    });

    startScanBtn.addEventListener('click', () => {
        startQRScanner();
    });

    document.getElementById('close-scanner-btn').addEventListener('click', () => {
        qrScannerContainer.style.display = 'none';
        if (html5QrCode) {
            html5QrCode.stop().catch(err => console.error(err));
        }
    });
}

async function initializeHost() {
    // --- HOST MODE (Erstellt den Raum) ---
    roomId = uuid.v4().split('-')[0]; // Short ID
    
    // Generiere Verschlüsselungs-Key
    sharedKey = await generateKey();
    const keyString = await exportKey(sharedKey);
    
    // URL generieren aber NICHT in die Adressleiste schreiben
    const fullLink = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${roomId}#${keyString}`;
    linkInput.value = fullLink;

    // Peer mit der Room-ID als Kennung erstellen
    peer = new Peer(roomId);

    peer.on('open', (id) => {
        statusEl.innerText = 'WAITING FOR PEER';
        statusEl.style.color = '#ffaa00';
    });

    // Warten auf Verbindung vom Gast
    peer.on('connection', (c) => {
        handleConnection(c);
    });
}

async function initializeGuest(id) {
    // --- GUEST MODE (Tritt bei) ---
    // Lese Key aus dem URL Hash
    const hash = window.location.hash.substring(1);
    if (hash) {
        sharedKey = await importKey(hash);
    } else {
        alert('Fehler: Kein Sicherheitsschlüssel in der URL gefunden!');
        return;
    }
    linkInput.value = window.location.href;

    peer = new Peer(); // Zufällige ID für den Gast

    peer.on('open', (myId) => {
        statusEl.innerText = 'CONNECTING...';
        // Verbinde zum Host (roomId)
        const c = peer.connect(id);
        handleConnection(c);
    });

    peer.on('error', (err) => {
        console.error(err);
        alert('Connection Error: Raum nicht gefunden oder offline.');
    });
}

function setupQRCode() {
    new QRCode(qrPopup, {
        text: linkInput.value,
        width: 128,
        height: 128
    });
    qrBtn.addEventListener('click', () => {
        qrPopup.style.display = qrPopup.style.display === 'block' ? 'none' : 'block';
    });
}

let html5QrCode;
function startQRScanner() {
    startScreen.style.display = 'none';
    qrScannerContainer.style.display = 'flex';
    
    html5QrCode = new Html5Qrcode("qr-reader");
    html5QrCode.start(
        { facingMode: "environment" }, 
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText, decodedResult) => {
            // Handle Success
            console.log(`Scan result: ${decodedText}`);
            html5QrCode.stop();
            qrScannerContainer.style.display = 'none';
            window.location.href = decodedText; // Redirect to room
        },
        (errorMessage) => {
            // parse error, ignore
        }
    ).catch(err => console.error(err));
}

function setupShareButton() {
    // Prüfen ob der Browser natives Teilen unterstützt (meistens Mobile)
    if (navigator.share) {
        shareBtn.addEventListener('click', async () => {
            try {
                await navigator.share({
                    title: 'Vault Transfer',
                    text: 'Join my secure Event Horizon to transfer files.',
                    url: linkInput.value
                });
            } catch (err) {
                console.log('Share canceled or failed', err);
            }
        });
    } else {
        // Button ausblenden auf Desktop-Browsern, die das nicht können
        shareBtn.style.display = 'none';
    }
}

async function createNewRoom() {
    // Cleanup Old Connection
    if (conn) { conn.close(); conn = null; }
    if (peer) { peer.destroy(); peer = null; }
    
    resetUI();
    initializeHost().then(() => {
        // Update QR Code after host init
        qrPopup.innerHTML = '';
        new QRCode(qrPopup, { text: linkInput.value, width: 128, height: 128 });
    });
}

// --- WEBRTC LOGIC ---
function handleConnection(c) {
    conn = c;

    conn.on('open', () => {
        statusEl.innerText = 'SECURE LINK ESTABLISHED';
        statusEl.style.color = '#00e5ff';
        dropLabel.innerText = 'DROP FILE TO INITIATE TRANSFER';
        sceneState.connected = true;

        // Wenn eine Datei wartet (z.B. via Share Menu), jetzt senden
        if (pendingFile) {
            sendFile(pendingFile);
            pendingFile = null;
        }
    });

    conn.on('data', handleData);

    conn.on('close', () => {
        statusEl.innerText = 'PEER DISCONNECTED';
        statusEl.style.color = 'red';
        sceneState.connected = false;
        conn = null;
        disconnectModal.style.display = 'flex';
    });
}

async function handleData(encryptedData) {
    // 1. Entschlüsseln
    let decryptedBuffer;
    try {
        decryptedBuffer = await decryptData(encryptedData);
    } catch (err) {
        console.error("Decryption failed:", err);
        return;
    }

    // 2. Prüfen ob Metadaten (JSON) oder Datei-Chunk
    const textDecoder = new TextDecoder();
    const text = textDecoder.decode(decryptedBuffer); // Versuche als Text zu lesen

    if (text.includes('{"fileName":')) {
        const info = JSON.parse(text);
        fileInfo = info;
        fileChunks = [];
        receivedSize = 0;
        showTransferUI(info.fileName);
        updateParticleColor(getFileColor(info.fileName));
        sceneState.transferring = true;
    } else {
        // It's a chunk
        fileChunks.push(decryptedBuffer);
        receivedSize += decryptedBuffer.byteLength;
        updateProgress(receivedSize, fileInfo.fileSize);

        // Check completion
        if (receivedSize >= fileInfo.fileSize) {
            const blob = new Blob(fileChunks);
            addToHistory(fileInfo.fileName, blob);
            receivedFilesCache.push({ fileName: fileInfo.fileName, blob: blob });
            
            // Preview Image if applicable
            if (fileInfo.fileName.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                showPreview(blob);
            }
            
            sceneState.transferring = false;
            resetUI();
        }
    }
}

function sendFile(file) {
    return new Promise(async (resolve, reject) => {
        if (!conn) {
            alert('No peer connected!');
            return resolve();
        }

        sceneState.transferring = true;
        showTransferUI(file.name);
        updateParticleColor(getFileColor(file.name));

        // Send Metadata
        const meta = JSON.stringify({ fileName: file.name, fileSize: file.size });
        const metaEncrypted = await encryptData(new TextEncoder().encode(meta));
        conn.send(metaEncrypted);

        // Send Chunks
        const reader = new FileReader();
        let offset = 0;

        reader.onload = async (e) => {
            const chunkEncrypted = await encryptData(e.target.result);
            conn.send(chunkEncrypted);
            offset += e.target.result.byteLength;
            updateProgress(offset, file.size);

            if (offset < file.size) {
                readNextChunk();
            } else {
                sceneState.transferring = false;
                resetUI();
                resolve(); // Datei fertig gesendet
            }
        };

        const readNextChunk = () => {
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.readAsArrayBuffer(slice);
        };

        readNextChunk();
    });
}

// --- UI HELPERS ---
function showTransferUI(name) {
    transferPanel.style.display = 'block';
    document.getElementById('file-name').innerText = name;
    dropLabel.style.opacity = 0;
}

function showPreview(blob) {
    const url = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.src = url;
    document.getElementById('preview-container').innerHTML = '';
    document.getElementById('preview-container').appendChild(img);
}

function addToHistory(fileName, blob) {
    const historyContainer = document.getElementById('file-history');
    const item = document.createElement('div');
    item.className = 'history-item';
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'history-name';
    nameSpan.innerText = fileName;
    
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'history-btn';
    downloadBtn.innerText = 'DOWNLOAD';
    downloadBtn.onclick = () => downloadFile(blob, fileName);
    
    actions.appendChild(downloadBtn);
    
    item.appendChild(nameSpan);
    
    if (fileName.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
        const url = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.src = url;
        img.style.maxWidth = '100%';
        img.style.borderRadius = '4px';
        img.style.border = '1px solid rgba(255,255,255,0.1)';
        item.appendChild(img);
    }
    
    item.appendChild(actions);
    
    // Füge neues Element oben ein
    historyContainer.insertBefore(item, historyContainer.firstChild);
    transferPanel.style.display = 'block'; // Panel offen lassen
    
    // Zeige "Download All" Button wenn mehr als 0 Dateien
    downloadAllBtn.style.display = 'block';
}

function updateProgress(current, total) {
    const percent = Math.floor((current / total) * 100);
    progressBar.style.width = `${percent}%`;
    
    // Simple speed simulation (visual only for this demo)
    const speed = (Math.random() * 5 + 2).toFixed(1);
    speedEl.innerText = `${speed} MB/s`;
}

function resetUI() {
    setTimeout(() => {
        const historyContainer = document.getElementById('file-history');
        if (historyContainer.children.length === 0) {
            transferPanel.style.display = 'none';
            downloadAllBtn.style.display = 'none';
            receivedFilesCache = []; // Cache leeren wenn Panel zugeht
        }
        dropLabel.style.opacity = 1;
        progressBar.style.width = '0%';
        updateParticleColor(ACCENT_COLOR);
        document.getElementById('preview-container').innerHTML = '';
        document.getElementById('file-name').innerText = 'Waiting...';
        // History nicht löschen
    }, 1000);
}

function downloadFile(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
}

function setupDragAndDrop() {
    const fileInput = document.getElementById('file-input');
    const mediaInput = document.getElementById('media-input');
    
    // 1. Click to Upload (Mobile/Desktop)
    dropLabel.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
        if (fileInput.files.length > 0) {
            for (const file of fileInput.files) {
                await sendFile(file);
            }
            fileInput.value = ''; // Reset für nächste Auswahl
        }
    });

    // Media Input (Gallery)
    if (mediaInput) {
        mediaInput.addEventListener('change', async () => {
            if (mediaInput.files.length > 0) {
                for (const file of mediaInput.files) await sendFile(file);
                mediaInput.value = '';
            }
        });
    }

    // 2. Drag & Drop Logic
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        sceneState.hovering = true;
    });

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        sceneState.hovering = false;
    });

    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        sceneState.hovering = false;
        if (e.dataTransfer.files.length > 0) {
            for (const file of e.dataTransfer.files) {
                await sendFile(file);
            }
        }
    });

    document.getElementById('copy-btn').addEventListener('click', () => {
        linkInput.select();
        document.execCommand('copy');
    });
}

function setupGallery() {
    const mediaInput = document.getElementById('media-input');
    galleryBtn.addEventListener('click', () => mediaInput.click());
}

function getFileColor(fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    if (['pdf', 'doc', 'docx', 'txt'].includes(ext)) return 0xff3333; // Rot (Dokumente)
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 0x33ff33; // Grün (Bilder)
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 0xffaa00; // Orange (Archive)
    if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return 0xaa00ff; // Lila (Audio)
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 0x3333ff; // Blau (Video)
    return ACCENT_COLOR; // Standard Cyan
}

function updateParticleColor(hex) {
    if (particles && particles.material.uniforms) {
        particles.material.uniforms.color.value.setHex(hex);
    }
}

async function handleSharedFile() {
    try {
        const cache = await caches.open('vault-shared-files');
        const response = await cache.match('shared-file');
        
        if (response) {
            const blob = await response.blob();
            const name = response.headers.get('X-File-Name') || 'shared_file';
            const file = new File([blob], name, { type: blob.type });
            
            // Datei vormerken
            pendingFile = file;
            
            // UI Update (Warten auf Peer)
            showTransferUI(file.name);
            updateParticleColor(getFileColor(file.name));
            dropLabel.innerText = "WAITING FOR PEER...";
            
            // Cache bereinigen
            await cache.delete('shared-file');
        }
    } catch (err) {
        console.error('Error handling shared file:', err);
    }
}

// --- CRYPTO FUNCTIONS (AES-GCM) ---
async function generateKey() {
    return window.crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

async function exportKey(key) {
    const exported = await window.crypto.subtle.exportKey("raw", key);
    // Convert ArrayBuffer to Base64 string for URL
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
}

async function importKey(str) {
    const raw = Uint8Array.from(atob(str), c => c.charCodeAt(0));
    return window.crypto.subtle.importKey(
        "raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]
    );
}

async function encryptData(data) {
    // IV (Initialization Vector) muss für jede Verschlüsselung einzigartig sein
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv }, sharedKey, data
    );
    // Wir packen IV + Encrypted Data zusammen
    const buffer = new Uint8Array(iv.byteLength + encrypted.byteLength);
    buffer.set(iv, 0);
    buffer.set(new Uint8Array(encrypted), 12);
    return buffer.buffer;
}

async function decryptData(packedData) {
    const iv = packedData.slice(0, 12);
    const data = packedData.slice(12);
    return window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) }, sharedKey, data
    );
}

// --- THREE.JS VISUALS (THE BLACK HOLE) ---
let scene, camera, renderer, particles;
let sceneState = {
    hovering: false,
    transferring: false,
    connected: false
};

function initThreeJS() {
    const container = document.getElementById('canvas-container');
    
    // Scene Setup
    scene = new THREE.Scene();
    // Fog to blend edges
    scene.fog = new THREE.FogExp2(0x050505, 0.002);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 30;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // 2. The Accretion Disk (Particles)
    const particleCount = 2000;
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(particleCount * 3);
    const pSizes = new Float32Array(particleCount);

    for(let i=0; i<particleCount; i++) {
        // Create a flat ring distribution
        const angle = Math.random() * Math.PI * 2;
        const radius = 8 + Math.random() * 15; // Ring from radius 8 to 23
        
        pPos[i*3] = Math.cos(angle) * radius;     // x
        pPos[i*3+1] = (Math.random() - 0.5) * 1;  // y (flatness)
        pPos[i*3+2] = Math.sin(angle) * radius;   // z

        pSizes[i] = Math.random() * 0.2;
    }

    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute('size', new THREE.BufferAttribute(pSizes, 1));

    // Custom Shader for Accretion Disk (Vortex Distortion)
    const pMat = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 },
            color: { value: new THREE.Color(ACCENT_COLOR) }
        },
        vertexShader: `
            uniform float time;
            attribute float size;
            varying float vAlpha;
            
            void main() {
                vec3 pos = position;
                
                // Newtonian Vortex: Inner particles orbit faster
                float radius = length(pos.xz);
                float speed = 20.0 / (radius + 0.1); 
                float angle = time * speed * 0.1; // Rotation speed
                
                float c = cos(angle);
                float s = sin(angle);
                
                // Rotate position around Y axis
                float x = pos.x * c - pos.z * s;
                float z = pos.x * s + pos.z * c;
                pos.x = x;
                pos.z = z;

                vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
                gl_PointSize = size * (300.0 / -mvPosition.z);
                gl_Position = projectionMatrix * mvPosition;
                
                vAlpha = 0.8; 
            }
        `,
        fragmentShader: `
            uniform vec3 color;
            varying float vAlpha;
            void main() {
                // Circular particle
                vec2 coord = gl_PointCoord - vec2(0.5);
                if (length(coord) > 0.5) discard;
                
                // Soft glow
                float strength = 1.0 - (length(coord) * 2.0);
                gl_FragColor = vec4(color, vAlpha * strength);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    particles = new THREE.Points(pGeo, pMat);
    scene.add(particles);

    // 3. Glow/Halo (Back plane)
    const glowGeo = new THREE.PlaneGeometry(40, 40);
    const glowMat = new THREE.MeshBasicMaterial({
        color: ACCENT_COLOR,
        transparent: true,
        opacity: 0.05,
        side: THREE.DoubleSide
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.rotation.x = Math.PI / 2; // Lay flat
    scene.add(glow);

    // Animation Loop
    animate();

    // Resize Handler
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

function animate() {
    requestAnimationFrame(animate);

    // Base rotation
    let rotationSpeed = 0.002;
    let scaleTarget = 1;

    // State-based modifications
    if (sceneState.transferring) {
        rotationSpeed = 0.05; // Fast spin
        scaleTarget = 0.9; // Contract slightly
    } else if (sceneState.hovering) {
        rotationSpeed = 0.01;
        scaleTarget = 1.2; // Expand event horizon
    }

    // Update Shader Uniforms
    const time = performance.now() * 0.001;
    if (particles.material.uniforms) particles.material.uniforms.time.value = time;

    // Camera "breathing" or distortion effect
    if (sceneState.hovering || sceneState.transferring) {
        camera.position.z = THREE.MathUtils.lerp(camera.position.z, 20, 0.05); // Zoom in
    } else {
        camera.position.z = THREE.MathUtils.lerp(camera.position.z, 30, 0.05); // Return to normal
    }

    renderer.render(scene, camera);
}

init();