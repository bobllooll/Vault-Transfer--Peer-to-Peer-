// Konfiguration für bessere Verbindungen (STUN hilft durch Firewalls)
const PEER_CONFIG = {
    debug: 2, // Optimiertes Logging
    pingInterval: 5000, // Hält die Signaling-Verbindung auf Handys aktiv (Heartbeat)
    config: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            
            // TURN Server (Relay): Der "Dietrich" für Firewalls
            // Leitet Traffic über Port 80/443 um, wenn direktes P2P blockiert ist
            {
                urls: "turn:openrelay.metered.ca:80",
                username: "openrelayproject",
                credential: "openrelayproject"
            },
            {
                urls: "turn:openrelay.metered.ca:443",
                username: "openrelayproject",
                credential: "openrelayproject"
            },
            {
                urls: "turn:openrelay.metered.ca:443?transport=tcp",
                username: "openrelayproject",
                credential: "openrelayproject"
            }
        ]
    }
};

class VaultP2P {
    constructor() {
        this.peer = null;
        this.connections = [];
        this.sharedKey = null;
        this.CHUNK_SIZE = 16 * 1024;
        this.callbacks = {
            onConnect: () => {},
            onDisconnect: () => {},
            onDataProgress: () => {},
            onFileReceived: () => {},
            onIncomingInfo: () => {},
            onPeerCountUpdate: () => {},
            onError: () => {},
            onConnectionType: () => {}
        };
        
        // State
        this.fileChunks = [];
        this.fileInfo = null;
        this.receivedSize = 0;
        
        // Reconnect State
        this.isHost = false;
        this.targetRoomId = null;
        this.maxPeers = Infinity;
        this.pingInterval = null;
        this.signalingKeepAlive = null; // Überwacht die Verbindung zum Server
        this.myDeviceType = 'desktop';
        this.peers = []; // Liste aller Peers {id, device}
    }

    on(event, fn) {
        this.callbacks[event] = fn;
    }

    async initHost(maxPeers = Infinity, deviceType = 'desktop', preferredId = null) {
        if (this.peer) this.destroy(); // Sauberen Start erzwingen

        this.isHost = true;
        this.maxPeers = maxPeers;
        this.myDeviceType = deviceType;
        this.sharedKey = await this.generateKey();
        const keyString = await this.exportKey(this.sharedKey);
        this.startHeartbeat();
        
        return new Promise((resolve, reject) => {
            // Rekursive Funktion für ID-Recovery Strategie
            const initPeer = (idToTry) => {
                // Versuche bevorzugte ID (für Reload-Resistenz) oder generiere neu
                const peer = idToTry ? new Peer(idToTry, PEER_CONFIG) : new Peer(PEER_CONFIG);
                
                peer.on('open', (id) => {
                    this.peer = peer; // Success!
                    this.peer.on('connection', (c) => this.handleConnection(c));
                    this.peers = [{ id: id, device: this.myDeviceType }];
                    
                    // WICHTIG: Wenn Verbindung zum Server abreißt (z.B. Standby), sofort neu verbinden!
                    this.peer.on('disconnected', () => {
                        console.log('HOST: Lost connection to signaling server. Reconnecting...');
                        this.reconnectSignaling();
                    });

                    // Aktiver Heartbeat für den Signaling-Server
                    this.signalingKeepAlive = setInterval(() => {
                        if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
                            console.warn('HOST: Detected silent signaling disconnect. Forcing reconnect.');
                            this.reconnectSignaling();
                        }
                    }, 5000);

                    resolve({ roomId: id, keyString });
                });

                peer.on('error', (err) => {
                    if (err.type === 'unavailable-id' && idToTry) {
                        console.warn("Host ID collision/taken. Falling back to random ID.");
                        peer.destroy();
                        initPeer(null); // Retry mit zufälliger ID
                    } else {
                        console.error('PeerJS Error (Host):', err);
                        this.callbacks.onError(err);
                    }
                });
            };

            initPeer(preferredId);
        });
    }

    async initGuest(roomId, keyString, deviceType = 'desktop') {
        if (this.peer) this.destroy(); // Sauberen Start erzwingen

        console.log(`GUEST: Initializing connection to room ${roomId}`);
        this.isHost = false;
        this.myDeviceType = deviceType;
        this.targetRoomId = roomId;
        this.sharedKey = await this.importKey(keyString);
        this.startHeartbeat();
        this.peer = new Peer(PEER_CONFIG);
        
        this.peer.on('open', (id) => {
            console.log(`GUEST: PeerJS connection to signaling server is open. My ID is ${id}.`);
            console.log(`GUEST: Attempting to connect to host: ${roomId}`);
            
            // Start connection strategy (UDP first, then TCP fallback)
            this.connectToHost(roomId);
        });
        
        this.peer.on('error', (err) => {
            console.error('PeerJS Error (Guest):', err);
            this.callbacks.onError(err);
        });

        // Auch als Gast die Verbindung zum Server halten
        this.peer.on('disconnected', () => {
            console.log('GUEST: Lost connection to signaling server. Reconnecting...');
            this.reconnectSignaling();
        });
    }

    connectToHost(roomId, forceRelay = false) {
        console.log(`GUEST: Connecting to ${roomId} (Relay Forced: ${forceRelay})`);
        
        const options = {
            reliable: true,
            serialization: 'binary'
        };

        if (forceRelay) {
            // STRATEGIE: Forced TCP/TLS Fallback (Port 443)
            // Wir zwingen WebRTC, alles über den TURN-Server zu tunneln.
            // Das sieht für die Firewall wie normaler HTTPS-Traffic aus.
            options.config = {
                // WICHTIG: Im Relay-Modus NUR den TCP-Server anbieten. Keine STUN-Server.
                // Das zwingt den Browser, nicht nach anderen Wegen zu suchen.
                iceServers: [
                    {
                        urls: "turn:openrelay.metered.ca:443?transport=tcp",
                        username: "openrelayproject",
                        credential: "openrelayproject"
                    }
                ],
                iceTransportPolicy: 'relay'
            };
        }

        const c = this.peer.connect(roomId, options);
        this.attachDebugLogger(c); // DIAGNOSE STARTEN
        this.handleConnection(c);

        // STRATEGIE: Aggressive ICE-Restart Heuristik (Watchdog)
        // Wir warten 8 Sekunden. Das ist der Sweetspot für Mobile.
        setTimeout(() => {
            if (!c.open && this.connections.length === 1 && this.connections[0] === c) {
                if (!forceRelay) {
                    console.warn("Watchdog: Connection stuck. Switching to Secure Relay.");
                    
                    // 1. UI informieren (Spinner zeigen)
                    this.callbacks.onError({ type: 'switching-protocols' });
                    
                    // 2. WICHTIG: 'close' Event entfernen, damit kein "Disconnected" Modal aufpoppt
                    c.removeAllListeners('close');
                    this.cleanupConnection(c);
                    
                    this.connectToHost(roomId, true); // Retry mit Relay
                } else {
                    // Wenn selbst Relay scheitert -> Abbruch
                    console.warn("Watchdog: Relay also stuck. Carrier blocking everything.");
                    this.callbacks.onError({ type: 'connection-timed-out' });
                }
            }
        }, 8000); // 8s: Genug Zeit für LTE, aber schnell genug für Fallback
    }

    handleConnection(c) {
        // Host Limit Check
        if (this.isHost && this.connections.length >= this.maxPeers) {
            c.on('open', () => {
                c.send({ type: 'error', message: 'Room is full.' });
                setTimeout(() => c.close(), 500);
            });
            return;
        }

        this.connections.push(c);
        this.attachDebugLogger(c); // DIAGNOSE STARTEN

        c.on('open', () => {
            // Handshake: Sende eigene Infos
            setTimeout(() => {
                c.send({ type: 'hello', id: this.peer.id, device: this.myDeviceType });
                this.callbacks.onConnect(this.connections.length);
                this.checkConnectionType(c);
            }, 500); // Kurze Pause für Stabilität
        });
        
        // WICHTIG: Fehler bei der Verbindung abfangen (z.B. Timeout, Firewall)
        c.on('error', (err) => {
            console.error('Connection Error:', err);
            this.cleanupConnection(c);
        });

        c.on('data', (data) => this.handleData(data, c));
        
        c.on('close', () => {
            this.connections = this.connections.filter(conn => conn !== c);
            this.callbacks.onDisconnect(this.connections.length);
            
            // Peer sauber aus der Liste entfernen
            if (c.peerId) {
                this.peers = this.peers.filter(p => p.id !== c.peerId);
            }
            if (this.isHost) this.broadcastPeerList();
            
            if (!this.isHost && this.targetRoomId && this.connections.length === 0) {
                this.reconnect();
            }
        });
    }

    async checkConnectionType(c) {
        // Warte kurz, bis sich die Verbindung stabilisiert hat
        setTimeout(async () => {
            if (!c.peerConnection) return;
            try {
                const stats = await c.peerConnection.getStats();
                let type = 'UNKNOWN';
                
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        const remoteId = report.remoteCandidateId;
                        if (remoteId && stats.has(remoteId)) {
                            const remote = stats.get(remoteId);
                            if (remote.candidateType === 'relay') type = 'RELAY (TURN)';
                            else if (remote.candidateType === 'srflx') type = 'DIRECT (WAN)';
                            else if (remote.candidateType === 'host') type = 'DIRECT (LAN)';
                            else type = 'DIRECT';
                        }
                    }
                });
                if (type !== 'UNKNOWN') this.callbacks.onConnectionType(type);
            } catch (e) { console.warn("Stats error", e); }
        }, 1000);
    }

    // --- DIAGNOSE TOOL ---
    attachDebugLogger(c) {
        // Wir müssen kurz warten, bis PeerJS das interne WebRTC-Objekt erstellt hat
        const checkInterval = setInterval(() => {
            if (!c.peerConnection) return;
            clearInterval(checkInterval);

            console.log(`%c[DIAGNOSTIC] Hooked into connection ${c.peer}`, 'background: #333; color: #ffff00; font-weight: bold');

            // 1. ICE Candidates (Welche Wege finden wir?)
            c.peerConnection.addEventListener('icecandidate', event => {
                if (event.candidate) {
                    const type = event.candidate.type; // host, srflx (stun), relay (turn)
                    const color = type === 'relay' ? '#ff00ff' : (type === 'srflx' ? '#00ffff' : '#aaaaaa');
                    console.log(`%c[ICE CANDIDATE] Found ${type.toUpperCase()} (${event.candidate.protocol}): ${event.candidate.candidate}`, `color: ${color}`);
                } else {
                    console.log('%c[ICE CANDIDATE] Gathering Finished (End of List)', 'color: #00ff00');
                }
            });

            // 2. Connection State (Wo hängt es?)
            c.peerConnection.addEventListener('iceconnectionstatechange', () => {
                console.log(`%c[ICE STATE] Changed to: ${c.peerConnection.iceConnectionState.toUpperCase()}`, 'background: #000; color: #fff; border: 1px solid #fff');
            });

            // 3. Gathering State
            c.peerConnection.addEventListener('icegatheringstatechange', () => {
                console.log(`%c[ICE GATHERING] ${c.peerConnection.iceGatheringState.toUpperCase()}`, 'color: #aaa');
            });
        }, 100);
    }

    cleanupConnection(c) {
        this.connections = this.connections.filter(conn => conn !== c);
        if (c.peerId) {
            this.peers = this.peers.filter(p => p.id !== c.peerId);
        }
        if (this.isHost) this.broadcastPeerList();
        
        // Schließen erzwingen, falls noch offen
        try { c.close(); } catch(e) {}
    }

    broadcastPeerList() {
        const msg = { type: 'peer-update', peers: this.peers };
        this.connections.forEach(c => {
            if (c.open) c.send(msg);
        });
        this.callbacks.onPeerCountUpdate(this.peers);
    }

    async handleData(data, sourceConn) {
        // 1. Keep-Alive Heartbeat (Ignorieren)
        if (data === 'PING') return;

        // 2. System Nachrichten (Unverschlüsselt, z.B. Fehler)
        if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data) && !(data instanceof Blob)) {
            if (data.type === 'error') {
                this.callbacks.onError({ type: 'room-full', message: data.message });
            } else if (data.type === 'hello') {
                // Neuer Peer stellt sich vor
                sourceConn.peerId = data.id; // ID an der Verbindung speichern für Disconnect-Handling
                const exists = this.peers.find(p => p.id === data.id);
                if (!exists) {
                    this.peers.push({ id: data.id, device: data.device });
                }
                if (this.isHost) this.broadcastPeerList();
            } else if (data.type === 'peer-update') {
                this.peers = Array.isArray(data.peers) ? data.peers : [];
                this.callbacks.onPeerCountUpdate(this.peers);
            }
            return;
        }

        // 3. Host Relay (Daten an alle anderen weiterleiten)
        if (this.isHost && sourceConn) {
            this.connections.forEach(conn => {
                if (conn !== sourceConn && conn.open) {
                    conn.send(data);
                }
            });
        }

        try {
            const decryptedBuffer = await this.decryptData(data);
            const textDecoder = new TextDecoder();
            
            // Try to parse as metadata first (naive check but fast)
            // In a prod app, we would send a packet type header
            let isMeta = false;
            if (decryptedBuffer.byteLength < 1000) {
                try {
                    const text = textDecoder.decode(decryptedBuffer);
                    if (text.includes('{"fileName":')) {
                        const info = JSON.parse(text);
                        this.fileInfo = info;
                        this.fileChunks = [];
                        this.receivedSize = 0;
                        this.callbacks.onIncomingInfo(info);
                        isMeta = true;
                    }
                } catch (e) { /* Not JSON */ }
            }

            if (!isMeta) {
                this.fileChunks.push(decryptedBuffer);
                this.receivedSize += decryptedBuffer.byteLength;
                this.callbacks.onDataProgress(this.receivedSize, this.fileInfo.fileSize);

                if (this.receivedSize >= this.fileInfo.fileSize) {
                    const blob = new Blob(this.fileChunks);
                    this.callbacks.onFileReceived(blob, this.fileInfo.fileName);
                }
            }
        } catch (err) {
            console.error("Data handling error:", err);
        }
    }

    startHeartbeat() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
            this.connections.forEach(c => {
                if (c.open) c.send('PING');
            });
        }, 2000); // Alle 2 Sekunden ein Lebenszeichen senden
    }

    reconnectSignaling() {
        if (this.peer && !this.peer.destroyed) this.peer.reconnect();
    }

    reconnect() {
        console.log('Attempting auto-reconnect...');
        setTimeout(() => {
            if (this.connections.length === 0 && this.peer && !this.peer.destroyed) {
                const c = this.peer.connect(this.targetRoomId);
                this.handleConnection(c);
            }
        }, 2000);
    }

    sendFile(file) {
        return new Promise(async (resolve, reject) => {
            if (this.connections.length === 0) return resolve();

            // Send Metadata
            const meta = JSON.stringify({ fileName: file.name, fileSize: file.size });
            const metaEncrypted = await this.encryptData(new TextEncoder().encode(meta));
            
            this.connections.forEach(c => { if (c.open) c.send(metaEncrypted); });

            // Send Chunks
            const reader = new FileReader();
            let offset = 0;

            reader.onload = async (e) => {
                const chunkEncrypted = await this.encryptData(e.target.result);
                
                this.connections.forEach(c => { if (c.open) c.send(chunkEncrypted); });
                
                offset += e.target.result.byteLength;
                this.callbacks.onDataProgress(offset, file.size);

                if (offset < file.size) {
                    readNextChunk();
                } else {
                    resolve();
                }
            };

            const readNextChunk = () => {
                const slice = file.slice(offset, offset + this.CHUNK_SIZE);
                reader.readAsArrayBuffer(slice);
            };

            readNextChunk();
        });
    }

    destroy() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.signalingKeepAlive) clearInterval(this.signalingKeepAlive);
        this.connections.forEach(c => c.close());
        this.connections = [];
        if (this.peer) this.peer.destroy();
        this.peer = null;
    }

    // --- CRYPTO UTILS ---
    async generateKey() {
        return window.crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
        );
    }

    async exportKey(key) {
        const exported = await window.crypto.subtle.exportKey("raw", key);
        return btoa(String.fromCharCode(...new Uint8Array(exported)));
    }

    async importKey(str) {
        const raw = Uint8Array.from(atob(str), c => c.charCodeAt(0));
        return window.crypto.subtle.importKey(
            "raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]
        );
    }

    async encryptData(data) {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv }, this.sharedKey, data
        );
        const buffer = new Uint8Array(iv.byteLength + encrypted.byteLength);
        buffer.set(iv, 0);
        buffer.set(new Uint8Array(encrypted), 12);
        return buffer.buffer;
    }

    async decryptData(packedData) {
        const iv = packedData.slice(0, 12);
        const data = packedData.slice(12);
        return window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(iv) }, this.sharedKey, data
        );
    }
}