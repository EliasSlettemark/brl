module.exports = {
  apps: [
    {
      name: "brl-sync",
      cwd: "/root/brl",
      script: "sync-hubspot.js",
      interpreter: "node",
      node_args: "--env-file=.env",
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 10000,
      max_memory_restart: "1500M",
    },
  ],
};
