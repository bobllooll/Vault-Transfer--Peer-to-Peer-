class VaultVisuals {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.isMobile = window.innerWidth <= 768;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.particles = null;
        this.state = {
            hovering: false,
            transferring: false,
            connected: false
        };
        this.ACCENT_COLOR = 0x00e5ff;
    }

    init() {
        if (!this.container) return;

        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x050505, 0.002);

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        
        // Mobile Optimization: Adjust Camera Z
        this.camera.position.z = this.isMobile ? 45 : 30;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap pixel ratio for performance
        this.container.appendChild(this.renderer.domElement);

        this.createParticles();
        this.createGlow();
        this.animate();

        window.addEventListener('resize', () => this.onResize());
    }

    createParticles() {
        // Mobile Optimization: Fewer particles
        const particleCount = this.isMobile ? 1500 : 2000;
        const pGeo = new THREE.BufferGeometry();
        const pPos = new Float32Array(particleCount * 3);
        const pSizes = new Float32Array(particleCount);

        for(let i=0; i<particleCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            // Mobile Optimization: Slightly wider spread
            const radius = 8 + Math.random() * (this.isMobile ? 18 : 15);
            
            pPos[i*3] = Math.cos(angle) * radius;
            pPos[i*3+1] = (Math.random() - 0.5) * 1;
            pPos[i*3+2] = Math.sin(angle) * radius;

            pSizes[i] = Math.random() * (this.isMobile ? 0.6 : 0.2);
        }

        pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
        pGeo.setAttribute('size', new THREE.BufferAttribute(pSizes, 1));

        const pMat = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0 },
                color: { value: new THREE.Color(this.ACCENT_COLOR) },
                globalOpacity: { value: 0.0 }
            },
            vertexShader: `
                uniform float time;
                attribute float size;
                varying float vAlpha;
                void main() {
                    vec3 pos = position;
                    float radius = length(pos.xz);
                    float speed = 20.0 / (radius + 0.1); 
                    float angle = time * speed * 0.1;
                    float c = cos(angle);
                    float s = sin(angle);
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
                uniform float globalOpacity;
                varying float vAlpha;
                void main() {
                    vec2 coord = gl_PointCoord - vec2(0.5);
                    if (length(coord) > 0.5) discard;
                    float strength = 1.0 - (length(coord) * 2.0);
                    gl_FragColor = vec4(color, vAlpha * strength * globalOpacity);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        this.particles = new THREE.Points(pGeo, pMat);
        this.scene.add(this.particles);
    }

    createGlow() {
        const glowGeo = new THREE.PlaneGeometry(40, 40);
        const glowMat = new THREE.MeshBasicMaterial({
            color: this.ACCENT_COLOR,
            transparent: true,
            opacity: 0.0,
            side: THREE.DoubleSide
        });
        this.glow = new THREE.Mesh(glowGeo, glowMat);
        this.glow.rotation.x = Math.PI / 2;
        this.scene.add(this.glow);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        const time = performance.now() * 0.001;
        if (this.particles && this.particles.material.uniforms) {
            this.particles.material.uniforms.time.value = time;
            
            // Fade in/out based on connection
            const targetOpacity = this.state.connected ? 1.0 : 0.0;
            const currentOpacity = this.particles.material.uniforms.globalOpacity.value;
            this.particles.material.uniforms.globalOpacity.value = THREE.MathUtils.lerp(currentOpacity, targetOpacity, 0.02);
        }
        
        if (this.glow) {
            const targetGlow = this.state.connected ? 0.05 : 0.0;
            this.glow.material.opacity = THREE.MathUtils.lerp(this.glow.material.opacity, targetGlow, 0.02);
        }

        // Camera Breathing
        const baseZ = this.isMobile ? 45 : 30;
        const zoomZ = this.isMobile ? 35 : 20;
        const targetZ = (this.state.hovering || this.state.transferring) ? zoomZ : baseZ;
        
        this.camera.position.z = THREE.MathUtils.lerp(this.camera.position.z, targetZ, 0.05);

        this.renderer.render(this.scene, this.camera);
    }

    onResize() {
        this.isMobile = window.innerWidth <= 768;
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        // Adjust camera Z on resize
        if (!this.state.hovering && !this.state.transferring) this.camera.position.z = this.isMobile ? 45 : 30;
    }
}