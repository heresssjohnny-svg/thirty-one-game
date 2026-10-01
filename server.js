const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Active game rooms storage
const rooms = {};

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Create or Join Lobby
    socket.on('join_room', ({ roomCode, username }) => {
        socket.join(roomCode);
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                code: roomCode,
                host: socket.id,
                players: [],
                spectators: [],
                gameState: 'waiting',
                wager: 5,
                lives: 2,
                deck: [],
                discard: []
            };
        }

        const room = rooms[roomCode];
        room.players.push({ id: socket.id, username, ready: false, lives: room.lives, hand: [] });

        // Broadcast player update
        io.to(roomCode).emit('room_update', room);
        console.log(`${username} joined room ${roomCode}`);
    });

    // Player Ready toggle
    socket.on('set_ready', ({ roomCode, ready }) => {
        const room = rooms[roomCode];
        if (room) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                player.ready = ready;
                io.to(roomCode).emit('room_update', room);

                // Auto start if all ready
                if (room.players.length > 0 && room.players.every(p => p.ready)) {
                    room.gameState = 'playing';
                    io.to(roomCode).emit('game_started', { room });
                }
            }
        }
    });

    // Discard pickup or draw action
    socket.on('player_action', ({ roomCode, action, card }) => {
        io.to(roomCode).emit('broadcast_action', { socketId: socket.id, action, card });
    });

    // Knock action
    socket.on('player_knock', ({ roomCode, score }) => {
        io.to(roomCode).emit('broadcast_knock', { socketId: socket.id, score });
    });

    // Disconnection handler
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        for (const code in rooms) {
            const room = rooms[code];
            room.players = room.players.filter(p => p.id !== socket.id);
            room.spectators = room.spectators.filter(s => s.id !== socket.id);
            if (room.players.length === 0) {
                delete rooms[code];
            } else {
                io.to(code).emit('room_update', room);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`31! Game Server running on port ${PORT}`);
});
