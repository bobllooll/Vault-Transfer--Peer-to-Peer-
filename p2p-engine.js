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
            onError: () => {}
        };
        
        // State
        this.fileChunks = [];
        this.fileInfo = null;
        this.receivedSize = 0;
        
        // Reconnect State
        this.isHost = false;
        this.targetRoomId = null;
        this.maxPeers = Infinity;
    }

    on(event, fn) {
        this.callbacks[event] = fn;
    }

    async initHost(maxPeers = Infinity) {
        this.isHost = true;
        this.maxPeers = maxPeers;
        this.sharedKey = await this.generateKey();
        const keyString = await this.exportKey(this.sharedKey);
        
        return new Promise((resolve, reject) => {
            // Wir lassen PeerJS die ID generieren (sicherer & keine Kollisionen)
            this.peer = new Peer();
            
            this.peer.on('open', (id) => {
                this.peer.on('connection', (c) => this.handleConnection(c));
                resolve({ roomId: id, keyString });
            });

            this.peer.on('error', (err) => {
                console.error('PeerJS Error (Host):', err);
                this.callbacks.onError(err);
            });
        });
    }

    async initGuest(roomId, keyString) {
        this.isHost = false;
        this.targetRoomId = roomId;
        this.sharedKey = await this.importKey(keyString);
        this.peer = new Peer();
        
        this.peer.on('open', () => {
            const c = this.peer.connect(roomId);
            this.handleConnection(c);
        });
        
        this.peer.on('error', (err) => {
            console.error('PeerJS Error (Guest):', err);
            this.callbacks.onError(err);
        });
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
            this.callbacks.onConnect(this.connections.length);
        });
        
        c.on('data', (data) => this.handleData(data));
        
        c.on('close', () => {
            this.connections = this.connections.filter(conn => conn !== c);
            this.callbacks.onDisconnect(this.connections.length);
            
            if (!this.isHost && this.targetRoomId && this.connections.length === 0) {
                this.reconnect();
            }
        });
    }

    async handleData(encryptedData) {
        try {
            const decryptedBuffer = await this.decryptData(encryptedData);
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