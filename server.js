const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 5000;

// Serve static files
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Game state
const gameState = {
    players: {}, // { socketId: { slot, name, score, completed, finished, board, solution } }
    maxPlayers: 4,
    slots: [false, false, false, false], // slot availability
    stats: {
        totalPlayers: 0,
        gamesPlayed: 0,
        totalTime: 0
    }
};

// Admin connections
const adminSockets = new Set();

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // Send current game state
    socket.emit('gameState', getPublicGameState());

    // ============================================
    // ADMIN EVENTS
    // ============================================

    // Admin login
    socket.on('adminLogin', () => {
        adminSockets.add(socket.id);
        console.log('Admin logged in:', socket.id);
        
        // Send full game state to admin
        socket.emit('gameState', getPublicGameState());
        
        // Send stats
        socket.emit('adminStats', gameState.stats);
    });

    // Admin kick player
    socket.on('adminKickPlayer', (playerId) => {
        if (!adminSockets.has(socket.id)) return;
        
        console.log(`Admin ${socket.id} kicking player ${playerId}`);
        
        if (gameState.players[playerId]) {
            const slot = gameState.players[playerId].slot;
            gameState.slots[slot - 1] = false;
            delete gameState.players[playerId];
            
            // Disconnect the player
            io.to(playerId).emit('kicked', { message: 'تم طردك من قبل المسؤول' });
            io.to(playerId).disconnectSockets(true);
            
            // Broadcast update
            io.emit('gameState', getPublicGameState());
            
            // Notify admin
            io.to(socket.id).emit('playerLeft', { playerId });
        }
    });

    // Admin reset player
    socket.on('adminResetPlayer', (playerId) => {
        if (!adminSockets.has(socket.id)) return;
        
        console.log(`Admin ${socket.id} resetting player ${playerId}`);
        
        if (gameState.players[playerId]) {
            gameState.players[playerId].score = 0;
            gameState.players[playerId].completed = 0;
            gameState.players[playerId].finished = false;
            gameState.players[playerId].board = null;
            gameState.players[playerId].solution = null;
            
            // Tell player to reset
            io.to(playerId).emit('resetGame');
            
            // Broadcast update
            io.emit('gameState', getPublicGameState());
        }
    });

    // Admin reset all games
    socket.on('adminResetAll', () => {
        if (!adminSockets.has(socket.id)) return;
        
        console.log(`Admin ${socket.id} resetting all games`);
        
        // Reset all players
        for (let playerId in gameState.players) {
            gameState.players[playerId].score = 0;
            gameState.players[playerId].completed = 0;
            gameState.players[playerId].finished = false;
            gameState.players[playerId].board = null;
            gameState.players[playerId].solution = null;
        }

        io.emit('resetGame');
        io.emit('gameState', getPublicGameState());
    });

    // Admin kick all players
    socket.on('adminKickAll', () => {
        if (!adminSockets.has(socket.id)) return;
        
        console.log(`Admin ${socket.id} kicking all players`);
        
        // Get all player IDs
        const playerIds = Object.keys(gameState.players);
        
        // Kick each player
        playerIds.forEach(playerId => {
            io.to(playerId).emit('kicked', { message: 'تم إنهاء اللعبة من قبل المسؤول' });
            io.to(playerId).disconnectSockets(true);
        });
        
        // Clear game state
        gameState.players = {};
        gameState.slots = [false, false, false, false];
        
        // Broadcast update
        io.emit('gameState', getPublicGameState());
    });

    // Admin refresh data
    socket.on('adminRefresh', () => {
        if (!adminSockets.has(socket.id)) return;
        
        socket.emit('gameState', getPublicGameState());
        socket.emit('adminStats', gameState.stats);
    });

    // ============================================
    // PLAYER EVENTS
    // ============================================

    // Request slot
    socket.on('requestSlot', (slotNumber) => {
        console.log(`Socket ${socket.id} requests slot ${slotNumber}`);
        
        // Check if slot is available
        if (slotNumber < 1 || slotNumber > 4) {
            socket.emit('slotError', 'رقم المكان غير صحيح');
            return;
        }

        // Check if game is full
        if (Object.keys(gameState.players).length >= 4) {
            socket.emit('slotError', 'اللعبة ممتلئة! (4/4)');
            return;
        }

        // Check if slot is taken
        const slotTaken = Object.values(gameState.players).some(p => p.slot === slotNumber);
        if (slotTaken) {
            socket.emit('slotError', 'هذا المكان محجوز!');
            return;
        }

        // Assign slot
        gameState.players[socket.id] = {
            id: socket.id,
            slot: slotNumber,
            name: `لاعب ${slotNumber}`,
            score: 0,
            completed: 0,
            finished: false,
            board: null,
            solution: null,
            online: true,
            joinedAt: Date.now()
        };

        gameState.slots[slotNumber - 1] = true;
        gameState.stats.totalPlayers++;

        // Notify player
        socket.emit('slotAssigned', {
            slot: slotNumber,
            playerId: socket.id
        });

        // Broadcast to all
        io.emit('gameState', getPublicGameState());
        
        // Notify admins
        adminSockets.forEach(adminId => {
            io.to(adminId).emit('playerJoined', {
                playerId: socket.id,
                slot: slotNumber
            });
        });

        console.log(`Slot ${slotNumber} assigned to ${socket.id}`);
    });

    // Receive board from player
    socket.on('sendBoard', (data) => {
        if (!gameState.players[socket.id]) return;
        
        gameState.players[socket.id].board = data.board;
        gameState.players[socket.id].solution = data.solution;
        
        console.log(`Board received from ${socket.id}`);
    });

    // Update player progress
    socket.on('updateProgress', (data) => {
        if (!gameState.players[socket.id]) return;

        gameState.players[socket.id].score = data.score;
        gameState.players[socket.id].completed = data.completed;
        gameState.players[socket.id].finished = data.finished;

        // Broadcast updated state
        io.emit('gameState', getPublicGameState());

        if (data.finished) {
            gameState.stats.gamesPlayed++;
            
            const timePlayed = Math.floor((Date.now() - gameState.players[socket.id].joinedAt) / 1000);
            gameState.stats.totalTime += timePlayed;
            
            console.log(`Player ${socket.id} finished in ${timePlayed}s!`);
            
            io.emit('playerFinished', {
                slot: gameState.players[socket.id].slot,
                score: data.score
            });

            // Notify admins
            adminSockets.forEach(adminId => {
                io.to(adminId).emit('gameFinished', {
                    playerId: socket.id,
                    time: formatTime(timePlayed),
                    score: data.score
                });
            });
        }
    });

    // New game request
    socket.on('newGame', () => {
        // Reset all players
        for (let playerId in gameState.players) {
            gameState.players[playerId].score = 0;
            gameState.players[playerId].completed = 0;
            gameState.players[playerId].finished = false;
            gameState.players[playerId].board = null;
            gameState.players[playerId].solution = null;
            gameState.players[playerId].joinedAt = Date.now();
        }

        io.emit('resetGame');
        io.emit('gameState', getPublicGameState());
        console.log('New game started');
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        
        // Remove from admin sockets if admin
        adminSockets.delete(socket.id);
        
        // Remove from players
        if (gameState.players[socket.id]) {
            const slot = gameState.players[socket.id].slot;
            gameState.slots[slot - 1] = false;
            delete gameState.players[socket.id];
            
            io.emit('gameState', getPublicGameState());
            
            // Notify admins
            adminSockets.forEach(adminId => {
                io.to(adminId).emit('playerLeft', {
                    playerId: socket.id
                });
            });
            
            console.log(`Slot ${slot} is now available`);
        }
    });
});

// Helper function to get public game state
function getPublicGameState() {
    const publicPlayers = {};
    
    for (let playerId in gameState.players) {
        const player = gameState.players[playerId];
        publicPlayers[playerId] = {
            id: playerId,
            slot: player.slot,
            name: player.name,
            score: player.score,
            completed: player.completed,
            finished: player.finished,
            online: player.online
        };
    }

    return {
        players: publicPlayers,
        maxPlayers: gameState.maxPlayers,
        onlineCount: Object.keys(gameState.players).length,
        availableSlots: gameState.slots.map((taken, idx) => !taken ? idx + 1 : null).filter(s => s !== null),
        stats: gameState.stats
    };
}

// Helper function to format time
function formatTime(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🎮 Sudoku 4-Player Game Server`);
    console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
    console.log(`🎯 Game: http://localhost:${PORT}/`);
});
