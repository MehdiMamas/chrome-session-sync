# Run the hub as a systemd user service

On Linux you can keep the hub running without a terminal. This uses a systemd
user service, so it starts with your session and restarts after a failure.

1. Find the Node.js path and the directory you keep the hub in:

   ```bash
   command -v node
   ```

2. Save this unit as `~/.config/systemd/user/chrome-session-sync.service`. The
   `ExecStart` line assumes Node.js is at `/usr/bin/node` and the hub is in
   `~/chrome-session-sync`; adjust both, and the `--dir` state directory, to
   match your machine.

   ```ini
   [Unit]
   Description=Chrome Session Sync hub
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   ExecStart=/usr/bin/node %h/chrome-session-sync/server/standalone.mjs --dir %h/.local/share/chrome-session-sync
   Restart=on-failure
   NoNewPrivileges=true
   PrivateTmp=true
   UMask=0077

   [Install]
   WantedBy=default.target
   ```

   `NoNewPrivileges` and `PrivateTmp` limit what the service can do, and
   `UMask=0077` keeps the hub's state files readable only by you.

3. Enable and start it:

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now chrome-session-sync
   ```

4. Keep the service running while you are logged out:

   ```bash
   loginctl enable-linger "$USER"
   ```

5. Check the logs with `journalctl --user -u chrome-session-sync -f`.

The service still listens on `127.0.0.1:8787`; put it behind HTTPS the same way
as in the [README](../README.md#1-run-the-hub), for example with Tailscale Serve
or another reverse proxy.
