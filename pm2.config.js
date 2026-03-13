module.exports = {
  apps: [
    {
      name: 'fb-bot',
      script: 'index.js',
      restart_delay: 10000,      // Wait 10s before restarting on crash
      max_restarts: 10,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
