import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
    const port = Number(loadEnv(mode, process.cwd(), '').PORT) || 3001;
    const target = `http://localhost:${port}`;
    return {
        base: './',
        build: {
            rollupOptions: {
                output: {
                    manualChunks: {
                        phaser: ['phaser']
                    }
                }
            }
        },
        server: {
            port: 8080,
            proxy: {
                '/api': { target },
                '/socket.io': { target, ws: true },
            },
        }
    };
});
