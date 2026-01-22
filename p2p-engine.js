// Konfiguration für bessere Verbindungen (STUN hilft durch Firewalls)
const PEER_CONFIG = {
    debug: 2, // Zeigt Warnungen in der Konsole an
    config: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:stun.global.stun.twilio.com:3478' },
            
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
        ],
        iceCandidatePoolSize: 2 // Stark reduziert für Mobile-Netzwerke (verhindert Stau)
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
        this.myDeviceType = 'desktop';
        this.peers = []; // Liste aller Peers {id, device}
    }

    on(event, fn) {
        this.callbacks[event] = fn;
    }

    async initHost(maxPeers = Infinity, deviceType = 'desktop') {
        this.isHost = true;
        this.maxPeers = maxPeers;
        this.myDeviceType = deviceType;
        this.sharedKey = await this.generateKey();
        const keyString = await this.exportKey(this.sharedKey);
        this.startHeartbeat();
        
        return new Promise((resolve, reject) => {
            // Wir lassen PeerJS die ID generieren (sicherer & keine Kollisionen)
            this.peer = new Peer(PEER_CONFIG);
            
            this.peer.on('open', (id) => {
                this.peer.on('connection', (c) => this.handleConnection(c));
                this.peers = [{ id: id, device: this.myDeviceType }]; // Host zur Liste hinzufügen
                resolve({ roomId: id, keyString });
            });

            this.peer.on('error', (err) => {
                console.error('PeerJS Error (Host):', err);
                this.callbacks.onError(err);
            });

            // WICHTIG: Wenn Verbindung zum Server abreißt (z.B. Standby), sofort neu verbinden!
            this.peer.on('disconnected', () => {
                console.log('HOST: Lost connection to signaling server. Reconnecting...');
                if (!this.peer.destroyed) this.peer.reconnect();
            });
        });
    }

    async initGuest(roomId, keyString, deviceType = 'desktop') {
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
            if (!this.peer.destroyed) this.peer.reconnect();
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
                ...PEER_CONFIG.config,
                iceTransportPolicy: 'relay', 
                iceCandidatePoolSize: 0 // Keine Zeit mit lokalen IPs verschwenden
            };
        }

        // STRATEGIE: MTU-Clamping Simulation
        // Wir manipulieren das SDP, um die Bandbreite beim Start zu begrenzen.
        // Das verhindert, dass riesige Pakete von strikten Mobile-Firewalls verworfen werden.
        options.sdpTransform = (sdp) => {
            if (sdp.includes('b=AS:')) return sdp.replace(/b=AS:([0-9]+)/g, 'b=AS:500');
            return sdp.replace(/a=mid:data\r\n/g, 'a=mid:data\r\nb=AS:500\r\n');
        };

        const c = this.peer.connect(roomId, options);
        this.handleConnection(c);

        // STRATEGIE: Aggressive ICE-Restart Heuristik (Watchdog)
        // Wir warten nicht 45s. Wenn nach 6s nichts passiert, ist UDP wahrscheinlich blockiert.
        setTimeout(() => {
            if (!c.open && this.connections.length === 1 && this.connections[0] === c) {
                if (!forceRelay) {
                    console.warn("Watchdog: UDP stuck. Triggering TCP/TLS Fallback.");
                    this.cleanupConnection(c);
                    this.callbacks.onError({ type: 'switching-protocols' }); // UI Info
                    this.connectToHost(roomId, true); // Retry mit Relay
                }
            }
        }, 6000);
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

        c.on('open', () => {
            // Handshake: Sende eigene Infos
            c.send({ type: 'hello', id: this.peer.id, device: this.myDeviceType });
            this.callbacks.onConnect(this.connections.length);
            this.checkConnectionType(c);
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
        this.connections.forEach(c => c.close());
        this.connections = [];
        if (this.peer) this.peer.destroy();
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