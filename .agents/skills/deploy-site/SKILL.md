---
name: deploy-site
description: Deploys the Snuggle site locally, finds the local IP address for stable Wi-Fi network access, and generates a QR code for mobile testing. Use when the user asks to "deploy", "start the site", "run the site", or "deploy the site".
---

# Deploy Snuggle Site (Local Network Access)

This skill automates starting the unified Node.js server that hosts both the frontend and backend of the Snuggle app, and finds the local IP address so the site can be accessed stably on the local Wi-Fi network. It then generates a QR code for easy mobile access.

## When to use this skill
- When the user asks to "deploy", "deploy the site", "start the site", or "run the site".
- When the user needs a fresh QR code to join the server on their mobile device from a different network.

## Workflow
1. Start the unified server by running `node index.js` inside the `server/` directory as a persistent background task (using `run_command` with `IsDaemon: true`). Do not block on this task.
2. Retrieve the machine's local IP address using `hostname -I | awk '{print $1}'` (or a similar command) so the site can be accessed on the local Wi-Fi network.
3. Respond to the user with:
   - A link to test on their local machine: `http://localhost:3000`
   - A dynamically generated QR code for their mobile device using the syntax: `![QR Code](https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=http://<LOCAL_IP>:3000)`

## Notes
- Remind the user that their mobile device MUST be connected to the exact same Wi-Fi network as this computer for the Local IP link to work.
- This approach mimics VS Code Live Server, providing indefinite stability without the disconnects associated with public tunnels.
