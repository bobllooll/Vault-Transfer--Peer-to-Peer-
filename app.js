// --- STATE ---
let roomId;
let p2p; // Instance of VaultP2P
let visuals; // Instance of VaultVisuals

let pendingFile = null; // Datei, die auf Verbindung wartet
let receivedFilesCache = []; // Speicher für alle empfangenen Dateien

// --- UI ELEMENTS ---
let statusEl, linkInput, dropLabel, galleryBtn, transferPanel, progressBar, speedEl, shareBtn, qrBtn, qrPopup, newRoomBtn, disconnectModal, reconnectBtn, gdprBanner, downloadAllBtn, closePanelBtn, startScreen, startCreateBtn, startScanBtn, qrScannerContainer;

function setupUI() {
    statusEl = document.getElementById('connection-status');
    linkInput = document.getElementById('room-link');
    dropLabel = document.getElementById('drop-label');
    galleryBtn = document.getElementById('gallery-btn');
    transferPanel = document.getElementById('transfer-panel');
    progressBar = document.getElementById('progress-bar');
    speedEl = document.getElementById('transfer-speed');
    shareBtn = document.getElementById('share-btn');
    qrBtn = document.getElementById('qr-btn');
    qrPopup = document.getElementById('qr-popup');
    newRoomBtn = document.getElementById('new-room-btn');
    disconnectModal = document.getElementById('disconnect-modal');
    reconnectBtn = document.getElementById('reconnect-btn');
    gdprBanner = document.getElementById('gdpr-banner');
    downloadAllBtn = document.getElementById('download-all-btn');
    closePanelBtn = document.getElementById('close-panel-btn');
    startScreen = document.getElementById('start-screen');
    startCreateBtn = document.getElementById('start-create-btn');
    startScanBtn = document.getElementById('start-scan-btn');
    qrScannerContainer = document.getElementById('qr-scanner-container');
}

// --- INITIALIZATION ---
async function init() {
    setupUI();

    // Initialize Engines
    p2p = new VaultP2P();
    visuals = new VaultVisuals('canvas-container');

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
    if (!localStorage.getItem('vault-gdpr-consent') && gdprBanner) {
        gdprBanner.style.display = 'flex';
    }

    // Check if Mobile (simple width check or user agent)
    const isMobile = window.innerWidth <= 768;

    if (!roomId) {
        if (isMobile && startScreen) {
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
    visuals.init();
    setupDragAndDrop();
    setupGallery();
    setupQRCode();
    setupShareButton();
    setupFaviconAnimation();

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

    // --- P2P EVENTS ---
    p2p.on('onConnect', () => {
        statusEl.innerText = 'SECURE LINK ESTABLISHED';
        statusEl.style.color = '#00e5ff';
        dropLabel.innerText = 'DROP FILE TO INITIATE TRANSFER';
        visuals.state.connected = true;
        if (pendingFile) {
            sendFile(pendingFile);
            pendingFile = null;
        }
    });

    p2p.on('onDisconnect', () => {
        statusEl.innerText = 'PEER DISCONNECTED';
        statusEl.style.color = 'red';
        visuals.state.connected = false;
        disconnectModal.style.display = 'flex';
    });

    p2p.on('onIncomingInfo', (info) => handleIncomingInfo(info));
    p2p.on('onDataProgress', (current, total) => updateProgress(current, total));
    p2p.on('onFileReceived', (blob, name) => handleFileReceived(blob, name));
}

async function initializeHost() {
    const { roomId: id, keyString } = await p2p.initHost();
    roomId = id;
    
    const fullLink = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${roomId}#${keyString}`;
    linkInput.value = fullLink;
    
    statusEl.innerText = 'WAITING FOR PEER';
    statusEl.style.color = '#ffaa00';
    updateQRCode(fullLink);
}

async function initializeGuest(id) {
    const hash = window.location.hash.substring(1);
    if (hash) {
        await p2p.initGuest(id, hash);
    } else {
        alert('Fehler: Kein Sicherheitsschlüssel in der URL gefunden!');
        return;
    }
    linkInput.value = window.location.href;
    statusEl.innerText = 'CONNECTING...';
    updateQRCode(window.location.href);
}

function setupQRCode() {
    qrBtn.addEventListener('click', () => {
        qrPopup.style.display = qrPopup.style.display === 'block' ? 'none' : 'block';
    });
}

function updateQRCode(text) {
    qrPopup.innerHTML = '';
    new QRCode(qrPopup, {
        text: text,
        width: 128,
        height: 128
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
    if (navigator.share && shareBtn) {
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
    } else if (shareBtn) {
        // Button ausblenden auf Desktop-Browsern, die das nicht können
        shareBtn.style.display = 'none';
    }
}

async function createNewRoom() {
    // Cleanup Old Connection
    p2p.destroy();
    p2p = new VaultP2P(); // Reset instance
    // Re-bind events for new instance
    p2p.on('onConnect', () => {
        statusEl.innerText = 'SECURE LINK ESTABLISHED';
        statusEl.style.color = '#00e5ff';
        dropLabel.innerText = 'DROP FILE TO INITIATE TRANSFER';
        visuals.state.connected = true;
    });
    // ... (other events would need re-binding or better structure, but for now this works for simple reset)
    
    resetUI();
    // Reload page to ensure clean state (simplest way for now)
    window.location.href = window.location.pathname;
}

function handleIncomingInfo(info) {
    showTransferUI(info.fileName);
    updateParticleColor(getFileColor(info.fileName));
    visuals.state.transferring = true;
}

function handleFileReceived(blob, name) {
    addToHistory(name, blob);
    receivedFilesCache.push({ fileName: name, blob: blob });
    
    if (name.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
        showPreview(blob);
    }
    
    visuals.state.transferring = false;
    resetUI();
}

async function sendFile(file) {
    visuals.state.transferring = true;
    showTransferUI(file.name);
    updateParticleColor(getFileColor(file.name));
    
    await p2p.sendFile(file);
    
    visuals.state.transferring = false;
    resetUI();
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
        updateParticleColor(visuals.ACCENT_COLOR);
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
        visuals.state.hovering = true;
    });

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        visuals.state.hovering = false;
    });

    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        visuals.state.hovering = false;
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
    if (galleryBtn && mediaInput) {
        galleryBtn.addEventListener('click', () => mediaInput.click());
    }
}

function setupFaviconAnimation() {
    // Firefox unterstützt animierte SVGs nativ als Favicon, da brauchen wir nichts tun
    if (navigator.userAgent.toLowerCase().includes('firefox')) return;

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    
    const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
    link.type = 'image/x-icon';
    link.rel = 'icon';
    document.head.appendChild(link);

    let angle1 = 0;
    let angle2 = 0;
    const accentColor = '#00e5ff';

    function animate() {
        ctx.clearRect(0, 0, 64, 64);
        const cx = 32;
        const cy = 32;

        // Glow & Style
        ctx.shadowBlur = 4;
        ctx.shadowColor = accentColor;
        ctx.strokeStyle = accentColor;
        ctx.lineCap = 'round';

        // Outer Ring (Clockwise)
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle1);
        ctx.beginPath();
        ctx.arc(0, 0, 22, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.setLineDash([12, 24]); 
        ctx.stroke();
        ctx.restore();

        // Inner Ring (Counter-Clockwise)
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle2);
        ctx.beginPath();
        ctx.arc(0, 0, 18, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 18]);
        ctx.globalAlpha = 0.7;
        ctx.stroke();
        ctx.restore();

        // Center (Event Horizon)
        ctx.globalAlpha = 1.0;
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(cx, cy, 11, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.stroke();

        // Update angles
        angle1 += 0.05;
        angle2 -= 0.03;

        // Favicon aktualisieren
        link.href = canvas.toDataURL();
        
        // ~15 FPS für Performance (reicht für ein kleines Icon)
        setTimeout(() => requestAnimationFrame(animate), 66);
    }
    
    animate();
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

function getFileColor(fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    if (['pdf', 'doc', 'docx', 'txt'].includes(ext)) return 0xff3333; // Rot (Dokumente)
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 0x33ff33; // Grün (Bilder)
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 0xffaa00; // Orange (Archive)
    if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return 0xaa00ff; // Lila (Audio)
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 0x3333ff; // Blau (Video)
    return visuals.ACCENT_COLOR; // Standard Cyan
}

function updateParticleColor(hex) {
    if (visuals && visuals.particles && visuals.particles.material.uniforms) {
        visuals.particles.material.uniforms.color.value.setHex(hex);
    }
}

document.addEventListener('DOMContentLoaded', init);