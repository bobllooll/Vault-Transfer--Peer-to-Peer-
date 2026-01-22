class VaultVisuals {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.isMobile = window.innerWidth <= 768;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.particles = null;
        this.nodes = null;
        this.lines = null;
        this.glow = null;
        this.scanRing = null; // Neuer Radar-Ring
        this.icons = this.createIcons();
        this.state = {
            hovering: false,
            transferring: false,
            connected: false
        };
        this.ACCENT_COLOR = 0x00e5ff;
        this.clock = new THREE.Clock();
        this.uniformTime = 0;
    }

    init() {
        if (!this.container) return;

        this.scene = new THREE.Scene();

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        
        // Mobile Optimization: Adjust Camera Z
        this.camera.position.z = this.isMobile ? 45 : 30;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap pixel ratio for performance
        this.container.appendChild(this.renderer.domElement);

        this.createNetworkVisuals();
        this.createScanEffect(); // Radar initialisieren
        this.animate();
        
        // Initial topology update is handled by app.js via p2p events now

        window.addEventListener('resize', () => this.onResize());
    }

    createIcons() {
        const drawIcon = (type) => {
            const canvas = document.createElement('canvas');
            canvas.width = 128; canvas.height = 128;
            const ctx = canvas.getContext('2d');
            
            ctx.shadowColor = "#00e5ff";
            ctx.shadowBlur = 15;
            ctx.strokeStyle = "#00e5ff";
            ctx.lineWidth = 4;

            if (type === 'desktop') {
                // Monitor
                ctx.strokeRect(24, 34, 80, 50);
                // Stand
                ctx.beginPath();
                ctx.moveTo(64, 84); ctx.lineTo(64, 104);
                ctx.moveTo(44, 104); ctx.lineTo(84, 104);
                ctx.stroke();
            } else {
                // Phone
                ctx.beginPath();
                ctx.roundRect(44, 24, 40, 80, 6);
                ctx.stroke();
                // Button
                ctx.beginPath();
                ctx.arc(64, 94, 3, 0, Math.PI*2);
                ctx.fillStyle = "#00e5ff";
                ctx.fill();
            }
            return new THREE.CanvasTexture(canvas);
        };

        return {
            desktop: drawIcon('desktop'),
            mobile: drawIcon('mobile')
        };
    }

    createNetworkVisuals() {
        // 1. Nodes (Sprites statt Points für Icons)
        this.nodes = new THREE.Group();
        this.scene.add(this.nodes);

        // 2. Lines (Verbindungslinien - optional sichtbar)
        const lineGeo = new THREE.BufferGeometry();
        const maxNodes = 50;
        const maxEdges = maxNodes * (maxNodes - 1) / 2;
        const linePos = new Float32Array(maxEdges * 2 * 3);
        lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
        
        const lineMat = new THREE.LineBasicMaterial({
            color: this.ACCENT_COLOR,
            transparent: true,
            opacity: 0.0, // Wird in animate gesteuert
            blending: THREE.AdditiveBlending
        });
        this.lines = new THREE.LineSegments(lineGeo, lineMat);
        this.scene.add(this.lines);

        // 3. Particles (Der Datenstrom auf den Linien)
        const particleCount = this.isMobile ? 300 : 600;
        const pGeo = new THREE.BufferGeometry();
        
        const pStart = new Float32Array(particleCount * 3);
        const pEnd = new Float32Array(particleCount * 3);
        const pOffset = new Float32Array(particleCount);
        const pSpeed = new Float32Array(particleCount);
        const pSize = new Float32Array(particleCount);

        for(let i=0; i<particleCount; i++) {
            pOffset[i] = Math.random(); // Zufälliger Startpunkt im Fluss
            // Viel langsamer: 0.02 bis 0.1
            pSpeed[i] = 0.02 + Math.random() * 0.08; 
            pSize[i] = Math.random() * (this.isMobile ? 2.5 : 1.5);
        }

        pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3)); // Dummy
        pGeo.setAttribute('edgeStart', new THREE.BufferAttribute(pStart, 3));
        pGeo.setAttribute('edgeEnd', new THREE.BufferAttribute(pEnd, 3));
        pGeo.setAttribute('offset', new THREE.BufferAttribute(pOffset, 1));
        pGeo.setAttribute('speed', new THREE.BufferAttribute(pSpeed, 1));
        pGeo.setAttribute('size', new THREE.BufferAttribute(pSize, 1));

        const pMat = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0 },
                color: { value: new THREE.Color(this.ACCENT_COLOR) },
                globalOpacity: { value: 0.0 }
            },
            vertexShader: `
                uniform float time;
                attribute vec3 edgeStart;
                attribute vec3 edgeEnd;
                attribute float offset;
                attribute float speed;
                attribute float size;
                varying float vProgress;
                
                void main() {
                    // Kontinuierlicher Fluss von Start zu Ende
                    float t = fract(offset + time * speed);
                    vProgress = t;
                    
                    vec3 pos = mix(edgeStart, edgeEnd, t);

                    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
                    gl_PointSize = size * (300.0 / -mvPosition.z);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                uniform vec3 color;
                uniform float globalOpacity;
                varying float vProgress;
                
                void main() {
                    vec2 coord = gl_PointCoord - vec2(0.5);
                    float dist = length(coord);
                    if (dist > 0.5) discard;
                    
                    // Fade In/Out an den Enden für sanften Übergang
                    float edgeFade = smoothstep(0.0, 0.1, vProgress) * (1.0 - smoothstep(0.9, 1.0, vProgress));
                    
                    float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
                    gl_FragColor = vec4(color, alpha * globalOpacity * edgeFade * 0.6); // Transparenter
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        this.particles = new THREE.Points(pGeo, pMat);
        this.scene.add(this.particles);
    }

    createScanEffect() {
        // Ein Ring, der sich ausdehnt
        const geometry = new THREE.RingGeometry(14, 15, 64);
        const material = new THREE.MeshBasicMaterial({ 
            color: this.ACCENT_COLOR, 
            transparent: true, 
            opacity: 0.0,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending
        });
        this.scanRing = new THREE.Mesh(geometry, material);
        this.scene.add(this.scanRing);
    }

    updateTopology(peers) {
        if (!this.nodes) return; 
        
        let n = 0;
        let peerList = [];
        if (Array.isArray(peers)) {
            n = peers.length;
            peerList = peers;
        } else {
            // Fallback für Hybrid-Modus (wenn nur Zahl übergeben wird)
            n = typeof peers === 'number' ? peers : 1;
        }
        
        const radius = this.isMobile ? 10 : 15;
        const nodePositions = [];
        
        // 1. Knoten-Positionen berechnen (Kreis-Anordnung)
        if (n === 1) {
            nodePositions.push(new THREE.Vector3(0, 0, 0));
        } else {
            for(let i=0; i<n; i++) {
                const theta = (i / n) * Math.PI * 2; // Start bei 0 für horizontale Ausrichtung bei 2 Nutzern
                nodePositions.push(new THREE.Vector3(
                    Math.cos(theta) * radius,
                    Math.sin(theta) * radius,
                    0 // XY-Ebene (Frontalansicht)
                ));
            }
        }

        // Nodes (Sprites) aktualisieren
        // Entferne alte Sprites wenn zu viele
        while(this.nodes.children.length > n) {
            this.nodes.remove(this.nodes.children[this.nodes.children.length - 1]);
        }
        // Füge neue hinzu wenn zu wenige
        while(this.nodes.children.length < n) {
            const spriteMat = new THREE.SpriteMaterial({ 
                map: this.icons.desktop, 
                color: this.ACCENT_COLOR,
                transparent: true,
                opacity: 0.0
            });
            const sprite = new THREE.Sprite(spriteMat);
            sprite.scale.set(4, 4, 1);
            this.nodes.add(sprite);
        }

        for(let i=0; i<n; i++) {
            const sprite = this.nodes.children[i];
            sprite.position.copy(nodePositions[i]);
            const p = peerList[i];
            sprite.material.map = (p && p.device === 'mobile') ? this.icons.mobile : this.icons.desktop;
        }

        // 2. Kanten (Edges) berechnen (Full Mesh)
        const edges = [];
        if (n > 1) {
            for(let i=0; i<n; i++) {
                for(let j=i+1; j<n; j++) {
                    edges.push([nodePositions[i], nodePositions[j]]);
                }
            }
        }

        // Linien aktualisieren
        const linePosAttr = this.lines.geometry.attributes.position;
        let lineIdx = 0;
        for(let i=0; i<edges.length; i++) {
            const start = edges[i][0];
            const end = edges[i][1];
            linePosAttr.setXYZ(lineIdx++, start.x, start.y, start.z);
            linePosAttr.setXYZ(lineIdx++, end.x, end.y, end.z);
        }
        linePosAttr.needsUpdate = true;
        this.lines.geometry.setDrawRange(0, edges.length * 2);

        // 3. Partikel auf Kanten verteilen
        const pStartAttr = this.particles.geometry.attributes.edgeStart;
        const pEndAttr = this.particles.geometry.attributes.edgeEnd;
        const particleCount = pStartAttr.count;

        for(let i=0; i<particleCount; i++) {
            if (edges.length > 0) {
                const edge = edges[Math.floor(Math.random() * edges.length)];
                // Zufällige Richtung (hin oder zurück)
                if (Math.random() > 0.5) {
                    pStartAttr.setXYZ(i, edge[0].x, edge[0].y, edge[0].z);
                    pEndAttr.setXYZ(i, edge[1].x, edge[1].y, edge[1].z);
                } else {
                    pStartAttr.setXYZ(i, edge[1].x, edge[1].y, edge[1].z);
                    pEndAttr.setXYZ(i, edge[0].x, edge[0].y, edge[0].z);
                }
            } else {
                // Fallback für n=1: Kleine Wolke um den Knoten
                const angle = Math.random() * Math.PI * 2;
                const r = 3 + Math.random() * 2;
                pStartAttr.setXYZ(i, Math.cos(angle)*r, Math.sin(angle)*r, 0);
                pEndAttr.setXYZ(i, Math.cos(angle+0.5)*r, Math.sin(angle+0.5)*r, 0);
            }
        }
        pStartAttr.needsUpdate = true;
        pEndAttr.needsUpdate = true;
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        const dt = this.clock.getDelta();
        // Beschleunige den Fluss während des Transfers
        const speedScale = this.state.transferring ? 3.0 : 1.0;
        this.uniformTime += dt * speedScale;

        // Fade In/Out basierend auf Verbindungsstatus
        const targetOpacity = this.state.connected ? 1.0 : 0.0;

        if (this.particles && this.particles.material.uniforms) {
            this.particles.material.uniforms.time.value = this.uniformTime;
            const currentOpacity = this.particles.material.uniforms.globalOpacity.value;
            this.particles.material.uniforms.globalOpacity.value = THREE.MathUtils.lerp(currentOpacity, targetOpacity, 0.02);
        }

        if (this.nodes) {
            this.nodes.children.forEach(sprite => {
                sprite.material.opacity = this.particles.material.uniforms.globalOpacity.value;
            });
        }

        if (this.lines) {
            if (this.particles) {
                this.lines.material.opacity = this.particles.material.uniforms.globalOpacity.value * 0.1;
            }
        }

        // --- RADAR ANIMATION (Wenn wir alleine sind) ---
        if (this.scanRing) {
            // Prüfen ob wir alleine sind (1 Node)
            const isWaiting = this.nodes && this.nodes.children.length === 1;
            
            if (isWaiting) {
                // Pulsieren: Skalierung von 1.0 bis 3.0
                const pulse = (this.uniformTime * 0.8) % 1; // 0 bis 1 Loop
                const scale = 1.0 + pulse * 2.0;
                this.scanRing.scale.set(scale, scale, 1);
                this.scanRing.material.opacity = (1.0 - pulse) * 0.5; // Ausblenden am Ende
            } else {
                this.scanRing.material.opacity = 0;
            }
        }

        // Camera Breathing entfernt (Hintergrund statisch)

        this.renderer.render(this.scene, this.camera);
    }

    onResize() {
        this.isMobile = window.innerWidth <= 768;
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        // Adjust camera Z on resize
        this.camera.position.z = this.isMobile ? 45 : 30;
    }
}