# socket/

Empty until **Step 8 (Socket.IO signaling server)**.

This folder will hold the Socket.IO setup and event handlers that relay
signaling messages (SDP offers/answers and ICE candidates) between peers in a
room. The server never touches media: it only passes messages along so two
browsers can find each other.
