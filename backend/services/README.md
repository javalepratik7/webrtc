# services/

Empty for now. Reusable server-side logic that isn't tied to HTTP or sockets
goes here, for example a **room manager** (who is in which room, max 2 peers
per room) used by the signaling handlers in Step 8, and later perhaps
TURN credential generation.
