const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log('Attempting to serve static files from:', path.join(__dirname, '../client'));

// Serve static files from the client folder
app.use(express.static(path.join(__dirname, '../client')));

// Redirect / to index.html (optional, but good for direct access)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
});

// --- WebSocket Logic with Room Management ---
const rooms = {}; // Structure: { 'roomId': [ws1, ws2], ... }
// We can also store a mapping from WebSocket to its roomId for quicker lookup on close
const wsToRoomMap = new Map();
const wsToNameMap = new Map(); // Map WebSocket to user name

wss.on('connection', (ws) => {
    console.log('A user connected.');

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
            console.log('Received message:', data.type, 'from client');
        } catch (e) {
            console.error('Invalid JSON message:', message.toString());
            return;
        }

        switch (data.type) {
            case 'joinRoom':
                const { roomId, name } = data;
                if (!roomId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room ID is required.' }));
                    return;
                }

                if (!rooms[roomId]) {
                    rooms[roomId] = [];
                }

                // Check if room is full (max 2 participants for simple two-way chat)
                if (rooms[roomId].length >= 2) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room is full. Please try another room.' }));
                    console.log(`Room ${roomId} is full. Client rejected.`);
                    ws.close(); // Close connection if room is full
                    return;
                }

                // Add client to the room
                rooms[roomId].push(ws);
                wsToRoomMap.set(ws, roomId); // Store room ID with the WebSocket object
                wsToNameMap.set(ws, name || 'Anonymous');

                console.log(`Client joined room: ${roomId}. Current participants: ${rooms[roomId].length}`);
                ws.send(JSON.stringify({ type: 'room-joined', roomId: roomId })); // Confirm client joined

                // If this is the second user, notify both participants to start WebRTC
                if (rooms[roomId].length === 2) {
                    const firstClient = rooms[roomId][0];
                    const secondClient = rooms[roomId][1];
                    const firstName = wsToNameMap.get(firstClient) || 'User 1';
                    const secondName = wsToNameMap.get(secondClient) || 'User 2';
                    if (firstClient && firstClient.readyState === WebSocket.OPEN) {
                        firstClient.send(JSON.stringify({ type: 'user-joined', isInitiator: true, name: secondName }));
                        console.log(`Notified first client in room ${roomId} to initiate.`);
                    }
                    if (secondClient && secondClient.readyState === WebSocket.OPEN) {
                        secondClient.send(JSON.stringify({ type: 'user-joined', isInitiator: false, name: firstName }));
                        console.log(`Notified second client in room ${roomId} of new user.`);
                    }
                } else if (rooms[roomId].length === 1) {
                    ws.send(JSON.stringify({ type: 'message', message: `Waiting for another user to join room ${roomId}...` }));
                }
                break;

            case 'offer':
            case 'answer':
            case 'candidate':
                const currentRoomId = wsToRoomMap.get(ws);
                if (!currentRoomId || !rooms[currentRoomId]) {
                    console.warn('Signaling message received from client not in a valid room or room not found.');
                    return;
                }
                if (rooms[currentRoomId].length < 2) {
                     console.warn(`Signaling message (${data.type}) received from room ${currentRoomId} with only one participant.`);
                     return; // Can't relay if no other peer
                }

                // Find the other client in the same room
                const otherClient = rooms[currentRoomId].find(client => client !== ws);

                if (otherClient && otherClient.readyState === WebSocket.OPEN) {
                    // Relay the message to the other peer in the same room
                    otherClient.send(message);
                    console.log(`Relayed ${data.type} in room ${currentRoomId}`);
                } else {
                    console.warn(`Could not find active other client in room ${currentRoomId} to relay ${data.type}.`);
                }
                break;

            default:
                console.warn('Unknown message type received:', data.type);
                ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type.' }));
        }
    });

    ws.on('close', () => {
        console.log('A user disconnected.');
        const currentRoomId = wsToRoomMap.get(ws);
        const userName = wsToNameMap.get(ws) || 'A user';

        if (currentRoomId && rooms[currentRoomId]) {
            // Remove the disconnected client from the room
            rooms[currentRoomId] = rooms[currentRoomId].filter(client => client !== ws);
            console.log(`Client left room: ${currentRoomId}. Remaining participants: ${rooms[currentRoomId].length}`);

            // If room becomes empty, clean up
            if (rooms[currentRoomId].length === 0) {
                delete rooms[currentRoomId];
                console.log(`Room ${currentRoomId} is now empty and deleted.`);
            } else {
                // Notify the remaining client that the other user left, with name
                rooms[currentRoomId].forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'user-left', name: userName }));
                        console.log(`Notified client in room ${currentRoomId} about user-left (${userName}).`);
                    }
                });
            }
        }
        wsToRoomMap.delete(ws); // Clean up the map
        wsToNameMap.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Start the server
server.listen(3002, () => {
    console.log('Server running at http://localhost:3002');
});