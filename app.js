// --- STATE ---
let roomId;
let p2p; // Instance of VaultP2P
let visuals; // Instance of VaultVisuals

let pendingFiles = []; // Warteschlange für Dateien
let receivedFilesCache = []; // Speicher für alle empfangenen Dateien
let currentConnectionType = ''; // Speichert den aktuellen Verbindungstyp
let connectionRetries = 0; // Zähler für Verbindungsversuche

// --- UI ELEMENTS ---
let statusEl, linkInput, dropLabel, galleryBtn, transferPanel, progressBar, speedEl, shareBtn, qrBtn, qrPopup, newRoomBtn, disconnectModal, reconnectBtn, gdprBanner, downloadAllBtn, closePanelBtn, startScreen, startCreateBtn, startScanBtn, qrScannerContainer, limitModal, limitInput, confirmLimitBtn;

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
    limitModal = document.getElementById('limit-modal');
    limitInput = document.getElementById('limit-input');
    confirmLimitBtn = document.getElementById('confirm-limit-btn');
}

// --- INITIALIZATION ---
async function init() {
    console.log(`--- ${CACHE_NAME} INIT ---`); // Prüfe in der Konsole, ob dies erscheint
    
    // Version im Header anzeigen (z.B. "v6.19")
    const version = CACHE_NAME.replace('vault-transfer-', '');
    const logoEl = document.querySelector('.logo');
    if (logoEl) {
        logoEl.innerHTML += ` <span style="font-size: 0.4em; opacity: 0.5; vertical-align: middle;">${version}</span>`;
    }

    setupUI();

    // Initialize Engines
    p2p = new VaultP2P();
    visuals = new VaultVisuals('canvas-container');

    // 1. Room Logic
    const urlParams = new URLSearchParams(window.location.search);
    roomId = urlParams.get('room');

    // Check for Shared File (from Mobile Share Menu)
    if (urlParams.get('shared') === 'true') {
        await handleSharedFile(); // Warten, damit pendingFiles gefüllt ist
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

    // WICHTIG: Beim Schließen des Tabs sofort Verbindung kappen
    window.addEventListener('beforeunload', () => {
        if (p2p) p2p.destroy();
    });

    setupP2PEvents();
}

function setupP2PEvents() {
    // --- P2P EVENTS (Re-usable for new rooms) ---
    p2p.on('onConnect', async () => {
        // Status wird durch onConnectionType oder onPeerCountUpdate final gesetzt
        statusEl.innerText = `CONNECTED...`;
        statusEl.style.color = '#00e5ff';
        dropLabel.innerText = 'DROP FILE TO INITIATE TRANSFER';
        visuals.state.connected = true;
        showConnectionSuccess(); // Animation auslösen
        // Falls wir Host sind, haben wir schon eine Peer-Liste
        if (p2p.peers && p2p.peers.length > 0) visuals.updateTopology(p2p.peers);
        
        // Warteschlange abarbeiten
        if (pendingFiles.length > 0) {
            showToast(`SENDING ${pendingFiles.length} QUEUED FILES...`);
            const queue = [...pendingFiles];
            pendingFiles = []; // Queue leeren
            for (const file of queue) await sendFile(file);
        }
        disconnectModal.style.display = 'none'; // Hide modal on reconnect
    });

    p2p.on('onConnectionType', (type) => {
        currentConnectionType = type;
        // Update Status Text sofort
        updateStatusText(p2p.peers.length || 1);
    });

    p2p.on('onDisconnect', (peerCount) => {
        const total = (peerCount || 0) + 1;
        
        if (p2p.isHost) {
            // Host Logic: Update counter, don't show modal if just one peer left but others remain
            statusEl.innerText = peerCount > 0 ? `CONNECTED (${total} USERS)` : 'WAITING FOR PEER (1 USER)';
            statusEl.style.color = peerCount > 0 ? '#00e5ff' : '#ffaa00';
            visuals.state.connected = peerCount > 0;
            visuals.updateTopology(total); // Form aktualisieren
            disconnectModal.style.display = 'none';
        } else {
            // Guest Logic: Connection lost to host
            statusEl.innerText = 'DISCONNECTED (1 USER)';
            statusEl.style.color = 'red';
            visuals.state.connected = false;
            visuals.updateTopology(1); // Zurück zum Ring
            disconnectModal.style.display = 'flex';
            
            const modalTitle = document.querySelector('#disconnect-modal h2');
            const modalText = document.querySelector('#disconnect-modal p');
            modalTitle.innerText = 'CONNECTION LOST';
            modalText.innerText = 'Attempting to re-establish link...';
        }
    });

    p2p.on('onError', (err) => {
        // Fix: Ignoriere Netzwerk-Fehler beim Tab-Wechsel (Mobile) und verbinde neu
        if (err.type === 'network' || err.type === 'disconnected') {
            if (p2p.peer && !p2p.peer.destroyed) {
                p2p.peer.reconnect();
            }
            showToast('RECONNECTING TO SERVER...');
            return; // Kein Fehler-Modal anzeigen
        }

        statusEl.innerText = 'CONNECTION ERROR';
        statusEl.style.color = 'red';
        
        const modalTitle = document.querySelector('#disconnect-modal h2');
        const modalText = document.querySelector('#disconnect-modal p');
        
        if (err.type === 'peer-unavailable') {
            // Auto-Retry Logik (3 Versuche)
            if (connectionRetries < 3) {
                connectionRetries++;
                console.log(`Retrying connection (${connectionRetries}/3)...`);
                showToast(`ROOM NOT FOUND. RETRYING (${connectionRetries}/3)...`);
                setTimeout(() => initializeGuest(roomId), 2000);
                return; // Modal noch nicht anzeigen
            }
            modalTitle.innerText = 'HOST NOT FOUND';
            modalText.innerText = 'Could not find the Host device.\n\nPOSSIBLE CAUSES:\n1. Host device went to sleep/standby.\n2. Host tab was closed.\n3. Host has no internet.';
        } else if (err.type === 'room-full') {
            modalTitle.innerText = 'ACCESS DENIED';
            modalText.innerText = 'The room has reached maximum capacity. Connection rejected.';
        } else if (err.type === 'connection-timed-out') {
            modalTitle.innerText = 'CONNECTION TIMED OUT';
            modalText.innerText = 'The firewall negotiation took too long.\n\nSUGGESTION:\n1. Click "CREATE NEW ROOM" to retry.\n2. If it fails again, try switching networks (WiFi <-> Mobile).';
        } else if (err.type === 'switching-protocols') {
            // Kein Fehler-Modal, nur Status-Update
            statusEl.innerHTML = 'OPTIMIZING CONNECTION... <span class="spinner"></span>';
            statusEl.style.color = '#ffaa00';
            showToast('Switching to Secure Tunnel...');
            return; 
        } else {
            modalTitle.innerText = 'CONNECTION ERROR';
            modalText.innerText = `An anomaly occurred: ${err.type}`;
        }
        
        disconnectModal.style.display = 'flex';
    });

    p2p.on('onIncomingInfo', (info) => handleIncomingInfo(info));
    p2p.on('onDataProgress', (current, total) => updateProgress(current, total));
    p2p.on('onFileReceived', (blob, name) => handleFileReceived(blob, name));
    
    p2p.on('onPeerCountUpdate', (data) => {
        console.log("DEBUG: Peer Update Data received:", data); // Log für dich
        
        let displayCount = 1;
        if (Array.isArray(data)) {
            displayCount = data.length;
        } else if (typeof data === 'number') {
            displayCount = data;
        }
        
        console.log("DEBUG: Display Count calculated:", displayCount);
        
        updateStatusText(displayCount);
        visuals.state.connected = true;
        visuals.updateTopology(data);
    });
}

function updateStatusText(count) {
    const typeInfo = currentConnectionType ? ` | ${currentConnectionType}` : '';
    statusEl.innerText = `CONNECTED (${count} USERS${typeInfo})`;
}

async function initializeHost() {
    // Ask for limit (Überspringen, wenn wir direkt aus der Galerie teilen)
    let limit = 5; // Standardwert für schnellen Start
    if (pendingFiles.length === 0) {
        limit = await getUserLimit();
    }

    let maxPeers = limit - 1;
    if (maxPeers < 1) maxPeers = 1;
    
    statusEl.innerText = 'INITIALIZING...';
    const deviceType = window.innerWidth <= 768 ? 'mobile' : 'desktop';
    
    // STICKY ID: Versuche alte ID wiederherzustellen (gegen Reload-Tod)
    const savedId = sessionStorage.getItem('vault-host-id');
    
    const { roomId: id, keyString } = await p2p.initHost(maxPeers, deviceType, savedId);
    roomId = id;
    
    // ID für Reloads speichern
    sessionStorage.setItem('vault-host-id', roomId);
    
    const fullLink = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${roomId}#${keyString}`;
    linkInput.value = fullLink;
    
    statusEl.innerText = 'WAITING FOR PEER (1 USER)';
    statusEl.style.color = '#ffaa00';
    updateQRCode(fullLink);
}

function getUserLimit() {
    return new Promise((resolve) => {
        limitModal.style.display = 'flex';
        limitInput.value = "5";
        limitInput.focus();

        function cleanup() {
            confirmLimitBtn.removeEventListener('click', onConfirm);
            limitInput.removeEventListener('keydown', onKey);
            limitModal.style.display = 'none';
        }

        function onConfirm() {
            cleanup();
            let val = parseInt(limitInput.value);
            if (isNaN(val) || val < 2) val = 2;
            resolve(val);
        }

        function onKey(e) { if (e.key === 'Enter') onConfirm(); }

        confirmLimitBtn.addEventListener('click', onConfirm);
        limitInput.addEventListener('keydown', onKey);
    });
}

async function initializeGuest(id) {
    const hash = window.location.hash.substring(1);
    roomId = id; // Global speichern für Retries
    
    // WICHTIG: Alte Verbindung komplett killen bevor wir es neu versuchen
    if (p2p) p2p.destroy();
    p2p = new VaultP2P();
    setupP2PEvents(); // Events neu binden

    if (hash) {
        const deviceType = window.innerWidth <= 768 ? 'mobile' : 'desktop';
        await p2p.initGuest(id, hash, deviceType);
    } else {
        showToast('ERROR: MISSING SECURITY KEY IN URL');
        return;
    }
    linkInput.value = window.location.href;
    statusEl.innerText = 'CONNECTING...';
    updateQRCode(window.location.href);

    // Timeout, falls die Verbindung ewig braucht
    // Stufe 1: Info an Nutzer, dass es noch arbeitet
    setTimeout(() => {
        if (statusEl.innerText === 'CONNECTING...') {
            statusEl.innerHTML = 'ESTABLISHING LINK... <span class="spinner"></span>';
        }
    }, 2000); // Schon nach 2s Feedback geben

    // Stufe 2: Abbruch nach 30s (8s UDP + 22s TCP Versuch)
    setTimeout(() => {
        const s = statusEl.innerText;
        if (s.includes('CONNECTING') || s.includes('ESTABLISHING') || s.includes('OPTIMIZING')) {
            p2p.callbacks.onError({ type: 'connection-timed-out' });
        }
    }, 30000);
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
                    text: 'Tap to join Vault Room (AirDrop / Nearby Share):',
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
    if (p2p) p2p.destroy();
    
    // FIX: Sticky ID löschen, sonst bekommen wir nach dem Reload wieder denselben Raum!
    sessionStorage.removeItem('vault-host-id');
    
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
    
    visuals.state.transferring = false;
    resetUI();
}

async function sendFile(file) {
    // Schutz gegen Ordner (werden oft als 0 Byte erkannt) oder leere Dateien
    if (file.size === 0) {
        showToast('EMPTY FILE OR FOLDER DETECTED. PLEASE ZIP FOLDERS.');
        return;
    }

    // NEU: Warten, bis jemand da ist (Queue)
    if (p2p.connections.length === 0) {
        pendingFiles.push(file);
        
        visuals.state.transferring = true;
        showTransferUI(file.name);
        updateParticleColor(getFileColor(file.name));
        
        // UI Feedback: Wir warten
        const statusText = pendingFiles.length > 1 ? `${pendingFiles.length} FILES QUEUED` : file.name;
        document.getElementById('file-name').innerText = `${statusText} (Waiting for Peer...)`;
        dropLabel.innerText = "WAITING FOR PEER...";
        dropLabel.style.opacity = 1; // Label sichtbar machen (wurde von showTransferUI versteckt)
        return;
    }

    visuals.state.transferring = true;
    showTransferUI(file.name);
    updateParticleColor(getFileColor(file.name));
    
    await p2p.sendFile(file);
    
    visuals.state.transferring = false;
    resetUI();
}

function showToast(message, duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = message;
    
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function showConnectionSuccess() {
    const overlay = document.getElementById('success-overlay');
    if (!overlay) return;
    
    overlay.style.display = 'flex';
    
    // Nach 2.5 Sekunden ausblenden
    setTimeout(() => {
        overlay.style.transition = 'opacity 0.5s ease';
        overlay.style.opacity = '0';
        setTimeout(() => {
            overlay.style.display = 'none';
            overlay.style.opacity = '1';
            overlay.style.transition = '';
        }, 500);
    }, 2500);
}

// --- UI HELPERS ---
function showTransferUI(name) {
    transferPanel.style.display = 'block';
    document.getElementById('file-name').innerText = name;
    document.getElementById('current-transfer-info').style.display = 'flex';
    document.querySelector('.energy-bar-container').style.display = 'block';
    dropLabel.style.opacity = 0;
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
        } else {
            document.getElementById('current-transfer-info').style.display = 'none';
            document.querySelector('.energy-bar-container').style.display = 'none';
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
        showToast('SECURE LINK COPIED TO CLIPBOARD');
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
            pendingFiles.push(file);
            
            // UI Update (Warten auf Peer)
            showTransferUI(file.name);
            updateParticleColor(getFileColor(file.name));
            dropLabel.innerText = "WAITING FOR PEER...";
            dropLabel.style.opacity = 1;
            document.getElementById('file-name').innerText = `${file.name} (Waiting for Peer...)`;
            
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