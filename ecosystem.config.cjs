// PM2 alternative to systemd:  pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'vibralook-api',
      script: 'dist/main.js',
      node_args: '--env-file-if-exists=.env',
      // One process: sessions live in memory, so do not use cluster mode.
      instances: 1,
      exec_mode: 'fork',
      kill_timeout: 20000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
